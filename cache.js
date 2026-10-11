// cache.js — Persistent per-article spoiler cache (chrome.storage.local)
//
// Keyed by provider + model + normalized URL, so switching models gives fresh answers.
// Entries expire after CACHE_TTL_MS and the cache is capped at CACHE_MAX_ENTRIES.

import { normalizeArticleUrl } from './batch-extractor.js';
import { CACHE_KEY_PREFIX, CACHE_TTL_MS, CACHE_MAX_ENTRIES } from './config.js';

export const FAILURE_SPOILER_FALLBACK = 'Could not reveal spoiler';

const PRUNE_EVERY_N_WRITES = 20;
let writesSincePrune = 0;

/** Identifies which provider/model produced an answer. */
export async function providerFingerprint() {
    const s = await chrome.storage.local.get(['provider', 'modelName', 'geminiModel', 'groqModel']);
    const provider = s.provider || 'ollama';
    const model = { ollama: s.modelName, gemini: s.geminiModel, groq: s.groqModel }[provider] || '';
    return `${provider}:${model}`;
}

export function cacheKeyFor(url, fingerprint = '') {
    return `${CACHE_KEY_PREFIX}${fingerprint}|${normalizeArticleUrl(url) || url}`;
}

/** Failed or empty answers must be retried next time, not cached. */
export function isCacheableSpoiler(summary) {
    return !!summary && !summary.includes('❌') && summary !== FAILURE_SPOILER_FALLBACK;
}

function isFresh(entry, now) {
    return !!entry?.summary && !!entry.cachedAt && now - entry.cachedAt <= CACHE_TTL_MS;
}

export async function readCachedSpoiler(url) {
    try {
        const key = cacheKeyFor(url, await providerFingerprint());
        const entry = (await chrome.storage.local.get(key))[key];
        return isFresh(entry, Date.now()) ? entry : null;
    } catch (_e) {
        return null;
    }
}

export async function writeCachedSpoiler(url, headline, summary, elapsedMs = 0) {
    if (!isCacheableSpoiler(summary)) return;
    try {
        const key = cacheKeyFor(url, await providerFingerprint());
        await chrome.storage.local.set({
            [key]: { headline, summary, elapsedMs, cachedAt: Date.now() },
        });
        if (++writesSincePrune >= PRUNE_EVERY_N_WRITES) {
            writesSincePrune = 0;
            await pruneCache();
        }
    } catch (_e) { }
}

/** Drop expired and legacy (timestamp-less) entries, then evict the oldest beyond the cap. */
export async function pruneCache() {
    try {
        const all = await chrome.storage.local.get(null);
        const now = Date.now();
        const entries = Object.entries(all).filter(([key]) => key.startsWith(CACHE_KEY_PREFIX));

        const doomed = [];
        const live = [];
        for (const [key, entry] of entries) {
            (isFresh(entry, now) ? live : doomed).push([key, entry]);
        }

        if (live.length > CACHE_MAX_ENTRIES) {
            live.sort((a, b) => a[1].cachedAt - b[1].cachedAt);
            doomed.push(...live.slice(0, live.length - CACHE_MAX_ENTRIES));
        }

        if (doomed.length > 0) {
            await chrome.storage.local.remove(doomed.map(([key]) => key));
        }
        return doomed.length;
    } catch (_e) {
        return 0;
    }
}
