// spoiler-flow.js — Orchestration: link → card, page → card, and viewport → inline badges.

import { callLLM, callBatchLLM } from './llm-providers.js';
import { cleanArticleText } from './text-cleaner.js';
import { NOISE_SELECTORS } from './selectors.js';
import { filterHeadlineCandidates, normalizeArticleUrl, chunkItems } from './batch-extractor.js';
import { extractArticleText, selectorsForUrl } from './extraction.js';
import { readCachedSpoiler, writeCachedSpoiler, FAILURE_SPOILER_FALLBACK } from './cache.js';
import { saveCard, newCardId } from './card-state.js';
import * as ui from './ui-bridge.js';
import {
    MIN_TEXT_LENGTH, MAX_EXTRACTED_LENGTH,
    BATCH_ARTICLE_TIMEOUT_MS, BATCH_CHUNK_SIZE, MAX_VIEWPORT_CANDIDATES,
} from './config.js';

const MIN_SELECTION_LENGTH = 50;   // a text selection shorter than this is treated as a plain page click

// ─── Card helpers ────────────────────────────────────────────

// Updates to one card are applied in order, so a late status patch can't overwrite a newer state.
const cardChains = new Map();

/** Persist a card's state and render it. Returns the merged card. */
function setCard(tabId, cardId, data) {
    const previous = cardChains.get(cardId) || Promise.resolve();
    const run = previous.then(async () => {
        const card = await saveCard(tabId, cardId, data);
        await ui.upsertCard(tabId, card);
        return card;
    });
    const tail = run.catch(() => { }).then(() => {
        if (cardChains.get(cardId) === tail) cardChains.delete(cardId);
    });
    cardChains.set(cardId, tail);
    return run;
}

async function failCard(tabId, cardId, err) {
    console.error('[Flow] Error:', err);
    try {
        await setCard(tabId, cardId, { status: 'error', text: `Error: ${err.message}` });
    } catch (_ignored) { /* overlay may already be gone */ }
}

/** Shared tail of the link and page flows: clean → LLM (streamed) → final card → cache. */
async function summarizeIntoCard({ tab, cardId, cacheUrl, headline, rawText, startTime }) {
    await setCard(tab.id, cardId, { status: 'loading', text: `Analyzing… (${rawText.length.toLocaleString()} chars)` });

    const articleText = cleanArticleText(rawText);
    console.log(`[Flow] Cleaned text: ${articleText.length} chars`);

    const summary = await callLLM(articleText, headline, (_chunk, accumulated) => {
        ui.streamCard(tab.id, cardId, accumulated);
    });

    const elapsedMs = Date.now() - startTime;
    console.log(`[Flow] Spoiler completed in ${(elapsedMs / 1000).toFixed(1)}s`);

    await setCard(tab.id, cardId, { status: 'done', text: summary, elapsedMs });
    if (cacheUrl) await writeCachedSpoiler(cacheUrl, headline, summary, elapsedMs);
}

// ─── Right-click on a link ───────────────────────────────────

/** extract headline → fetch article → LLM → card. */
export async function handleLinkClick(tab, linkUrl) {
    const cardId = newCardId();
    const startTime = Date.now();

    try {
        const cached = await readCachedSpoiler(linkUrl);
        if (cached) {
            console.log(`[Flow] Cache hit for ${linkUrl}`);
            await setCard(tab.id, cardId, {
                headline: cached.headline || 'Spoiler', url: linkUrl,
                status: 'done', text: cached.summary, elapsedMs: 0,
            });
            return;
        }

        await setCard(tab.id, cardId, { headline: 'Loading…', url: linkUrl, status: 'loading', text: 'Fetching article…' });

        // Headline lookup and article fetch are independent
        const headlinePromise = ui.extractHeadlineFromLink(tab.id, linkUrl);
        const textPromise = extractArticleText(tab.id, linkUrl, {
            onStatus: (message) => setCard(tab.id, cardId, { text: message }).catch(() => { }),
        });
        const [headline, rawText] = await Promise.all([headlinePromise, textPromise]);

        if (headline) await setCard(tab.id, cardId, { headline });
        if (!rawText) throw new Error('Could not extract article content');

        await summarizeIntoCard({ tab, cardId, cacheUrl: linkUrl, headline, rawText, startTime });
    } catch (err) {
        await failCard(tab.id, cardId, err);
    }
}

// ─── Right-click on the page / a text selection ──────────────

/** Summarize the current page, or the selected text if there is one. */
export async function handlePageClick(tab, selectionText = '') {
    const cardId = newCardId();
    const startTime = Date.now();
    const selection = selectionText.trim();
    const useSelection = selection.length >= MIN_SELECTION_LENGTH;
    const headline = tab.title || tab.url || 'Page';

    try {
        await setCard(tab.id, cardId, { headline, url: tab.url, status: 'loading', text: 'Reading page…' });

        const rawText = useSelection
            ? selection
            : await ui.extractCurrentPageText(tab.id, NOISE_SELECTORS, selectorsForUrl(tab.url), MIN_TEXT_LENGTH, MAX_EXTRACTED_LENGTH);
        if (!rawText || rawText.length < MIN_SELECTION_LENGTH) {
            throw new Error('Could not extract enough text from this page.');
        }

        await summarizeIntoCard({
            tab, cardId, headline, rawText, startTime,
            cacheUrl: useSelection ? null : tab.url,   // selections vary, so only whole pages are cached
        });
    } catch (err) {
        await failCard(tab.id, cardId, err);
    }
}

// ─── Viewport batch spoilers ─────────────────────────────────

/**
 * Run `task(signal)` with a deadline. On timeout the signal aborts, so the work
 * (e.g. a hidden tab) can clean up instead of being orphaned.
 */
async function withDeadline(task, ms, message) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(message));
        }, ms);
    });
    try {
        return await Promise.race([task(controller.signal), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Reveal all visible spoilers in the current viewport: discover headline links, then extract
 * each chunk of articles concurrently and answer the whole chunk with one LLM request.
 */
export async function handleRevealVisibleSpoilers(tab) {
    if (!tab?.id || !tab?.url || !tab.url.startsWith('http')) return;
    console.log(`[Flow] Starting viewport batch spoilers on tab ${tab.id}`);

    // 1. Scan viewport for visible links
    let rawLinks;
    try {
        rawLinks = await ui.scanViewport(tab.id);
    } catch (err) {
        console.error('[Flow] Failed to scan viewport:', err);
        return;
    }
    if (rawLinks.length === 0) {
        console.log('[Flow] No visible headline links found in viewport.');
        return;
    }

    // 2. Filter candidates
    let currentHost = '';
    try {
        currentHost = new URL(tab.url).hostname;
    } catch (_e) { }

    const candidates = filterHeadlineCandidates(rawLinks, currentHost, MAX_VIEWPORT_CANDIDATES);
    const candidateItems = candidates
        .map(c => ({
            cbrId: c.id || rawLinks.find(r => normalizeArticleUrl(r.url) === c.url)?.id,
            url: c.url,
            headline: c.headline,
        }))
        .filter(item => item.cbrId);
    if (candidateItems.length === 0) {
        console.log('[Flow] No valid headline candidates after filtering.');
        return;
    }
    console.log(`[Flow] Discovered ${candidateItems.length} visible headlines to spoil.`);

    // 3. Loading badges for all candidates
    try {
        await ui.injectBadges(tab.id, candidateItems);
    } catch (err) {
        console.error('[Flow] Failed to inject inline badges:', err);
        return;
    }

    // 4. Serve what's cached
    const uncachedItems = [];
    for (const item of candidateItems) {
        const cached = await readCachedSpoiler(item.url);
        if (cached) {
            await ui.updateBadge(tab.id, item.cbrId, cached.summary);
        } else {
            uncachedItems.push(item);
        }
    }
    if (uncachedItems.length === 0) {
        console.log('[Flow] All visible headlines retrieved from cache.');
        return;
    }

    // 5. Chunks: concurrent extraction, one batched LLM call per chunk
    const chunks = chunkItems(uncachedItems, BATCH_CHUNK_SIZE);
    console.log(`[Flow] Processing ${uncachedItems.length} articles across ${chunks.length} batched LLM chunks`);

    for (const chunk of chunks) {
        const extractionResults = await Promise.allSettled(chunk.map(async (item) => {
            const text = await withDeadline(
                (signal) => extractArticleText(tab.id, item.url, { signal }),
                BATCH_ARTICLE_TIMEOUT_MS,
                'Article extraction timed out',
            );
            if (!text || text.length < MIN_TEXT_LENGTH) throw new Error('Could not extract article content');
            return cleanArticleText(text);
        }));

        const validItems = [];
        extractionResults.forEach((res, i) => {
            const item = chunk[i];
            if (res.status === 'fulfilled' && res.value) {
                validItems.push({ item, headline: item.headline, text: res.value });
            } else {
                console.error(`[Flow] Extraction failed for ${item.url}:`, res.reason);
                ui.updateBadge(tab.id, item.cbrId, res.reason?.message || 'Could not extract article content', true);
            }
        });
        if (validItems.length === 0) continue;

        await answerChunk(tab.id, validItems);
    }

    console.log('[Flow] Viewport batch spoilers complete.');
}

/** One batched LLM call for a chunk; falls back to one call per article if the batch fails. */
async function answerChunk(tabId, validItems) {
    try {
        const spoilers = await callBatchLLM(validItems.map(v => ({ headline: v.headline, text: v.text })));
        for (let i = 0; i < validItems.length; i++) {
            const v = validItems[i];
            const spoiler = spoilers[i] || FAILURE_SPOILER_FALLBACK;
            await ui.updateBadge(tabId, v.item.cbrId, spoiler);
            await writeCachedSpoiler(v.item.url, v.headline, spoiler);
        }
    } catch (err) {
        console.error('[Flow] Batch LLM call failed, falling back to individual calls:', err);
        for (const v of validItems) {
            try {
                const single = await callLLM(v.text, v.headline);
                await ui.updateBadge(tabId, v.item.cbrId, single);
                await writeCachedSpoiler(v.item.url, v.headline, single);
            } catch (singleErr) {
                await ui.updateBadge(tabId, v.item.cbrId, `Error: ${singleErr.message}`, true);
            }
        }
    }
}
