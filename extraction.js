// extraction.js — Get article text for a URL: fast fetch first, hidden-tab fallback second.

import { ARTICLE_SELECTORS, NOISE_SELECTORS, getArticleSelectors } from './selectors.js';
import { extractStructuredArticleText } from './structured-extractor.js';
import { MIN_TEXT_LENGTH, MIN_FETCH_LENGTH, MAX_EXTRACTED_LENGTH } from './config.js';

const TAB_LOAD_TIMEOUT_MS = 3500;   // max wait for a hidden tab to finish loading
const TAB_POLL_WINDOW_MS = 1500;    // how long to poll for article text after the load wait
const TAB_POLL_INTERVAL_MS = 100;

// Patterns used to detect JS-framework "shell" pages (no real article HTML)
const CLIENT_RENDERED_MARKERS = ['__NEXT_DATA__', 'window.__APP', 'React.createElement', '_buildManifest'];

// Cloudflare / generic bot-wall interstitials; their text must never reach the LLM
const BOT_CHALLENGE_RE = /<title>\s*(Just a moment|Attention Required|Access Denied|Are you a robot|Checking your browser)/i;

/** Site-aware selector list for an article URL (host-specific first, then generic). */
export function selectorsForUrl(url) {
    try {
        return getArticleSelectors(new URL(url).hostname);
    } catch (_e) {
        return ARTICLE_SELECTORS;
    }
}

/**
 * Heuristic: does the fetched HTML look like a JS-framework shell
 * rather than server-rendered article content?
 */
export function looksLikeClientRendered(html, extractedText) {
    if (extractedText.length >= MIN_FETCH_LENGTH) return false;

    for (const marker of CLIENT_RENDERED_MARKERS) {
        if (extractedText.includes(marker)) return true;
    }

    const scriptCount = (html.match(/<script/gi) || []).length;
    const pCount = (html.match(/<p[\s>]/gi) || []).length;
    return scriptCount > pCount * 3 && pCount < 5;
}

/**
 * Extract article text: fast-fetch first, background-tab fallback.
 * A metadata teaser (og:description) is only a last resort — on clickbait sites it
 * is usually the very text that hides the answer.
 *
 * @param {number} tabId - Tab used to run DOM parsing for the fast path
 * @param {string} url
 * @param {{ onStatus?: (message: string) => void, signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export async function extractArticleText(tabId, url, { onStatus, signal } = {}) {
    const selectors = selectorsForUrl(url);

    const fast = await tryFastFetch(tabId, url, selectors);
    if (fast.text && fast.text.length >= MIN_FETCH_LENGTH) {
        console.log(`[Extract] Fast fetch OK (${fast.text.length} chars)`);
        return fast.text;
    }
    if (signal?.aborted) return '';

    const tabText = await extractViaBackgroundTab(url, selectors, { onStatus, signal });
    if (tabText.length >= MIN_TEXT_LENGTH) return tabText;

    if (fast.teaser) {
        console.log('[Extract] Full text unavailable; falling back to metadata teaser.');
        return fast.teaser;
    }
    return tabText;
}

/**
 * Attempt a fast fetch of the article HTML and parse it in the page context.
 * `text` is empty if the response failed or looks like a JS-rendered shell;
 * `teaser` is the metadata description, kept only as a last-resort fallback.
 * @returns {Promise<{ text: string, teaser: string }>}
 */
export async function tryFastFetch(tabId, url, selectors) {
    const failed = { text: '', teaser: '' };
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.log(`[Extract] Fast fetch got HTTP ${response.status}; skipping.`);
            return failed;
        }
        const html = await response.text();
        if (BOT_CHALLENGE_RE.test(html)) {
            console.log('[Extract] Fast fetch hit a bot-challenge page; skipping.');
            return failed;
        }

        const teaser = extractStructuredArticleText(html);

        // 1. Structured article body (JSON-LD articleBody, __NEXT_DATA__) — no teasers
        const structured = extractStructuredArticleText(html, { allowTeaser: false });
        if (structured && structured.length >= MIN_FETCH_LENGTH) {
            console.log(`[Extract] Fast structured extraction OK (${structured.length} chars)`);
            return { text: structured, teaser };
        }

        // 2. DOM evaluation in page context (the service worker has no DOMParser)
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (htmlStr, noiseSelectors, articleSelectors, minLength, maxLength) => {
                const doc = new DOMParser().parseFromString(htmlStr, 'text/html');
                doc.querySelectorAll(noiseSelectors).forEach(el => el.remove());

                for (const sel of articleSelectors) {
                    const el = doc.querySelector(sel);
                    if (el && el.textContent.trim().length > minLength) {
                        return el.textContent.trim().substring(0, maxLength);
                    }
                }
                return doc.body?.textContent?.trim().substring(0, maxLength) || '';
            },
            args: [html, NOISE_SELECTORS, selectors, MIN_TEXT_LENGTH, MAX_EXTRACTED_LENGTH],
        });

        const text = result || '';
        if (looksLikeClientRendered(html, text)) {
            console.log('[Extract] Fast fetch looks like client-rendered JS. Falling back.');
            return { text: '', teaser };
        }
        return { text, teaser };
    } catch (err) {
        console.log(`[Extract] Fast fetch failed: ${err.message}`);
        return failed;
    }
}

/** Resolve when the tab finishes loading, the timeout passes, or the signal aborts. */
function waitForTabLoad(tabId, signal) {
    return new Promise((resolve) => {
        let timeoutId;
        const done = () => {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const listener = (id, changeInfo) => {
            if (id === tabId && changeInfo.status === 'complete') done();
        };
        timeoutId = setTimeout(done, TAB_LOAD_TIMEOUT_MS);
        signal?.addEventListener('abort', done);
        chrome.tabs.onUpdated.addListener(listener);
    });
}

/**
 * Open the article in a hidden tab and poll until article text appears.
 * The tab is always closed — including when the caller aborts.
 */
export async function extractViaBackgroundTab(url, selectors, { onStatus, signal } = {}) {
    onStatus?.('Loading article page…');

    const articleTab = await chrome.tabs.create({ url, active: false });
    let articleText = '';
    const startTime = Date.now();

    try {
        await waitForTabLoad(articleTab.id, signal);

        // Poll window starts after the load wait; measuring from tab creation
        // meant slow-loading pages (the reason for this fallback) never got polled.
        const pollStart = Date.now();
        while (!signal?.aborted && Date.now() - pollStart < TAB_POLL_WINDOW_MS) {
            try {
                await chrome.scripting.executeScript({ target: { tabId: articleTab.id }, files: ['page-extract.js'] });
                const [{ result }] = await chrome.scripting.executeScript({
                    target: { tabId: articleTab.id },
                    func: (noise, sels, min, max) => window.__cbrExtractPageText(noise, sels, min, max),
                    args: [NOISE_SELECTORS, selectors, MIN_TEXT_LENGTH, MAX_EXTRACTED_LENGTH],
                });

                if (result && result.length >= MIN_TEXT_LENGTH) {
                    articleText = result;
                    break;
                }
            } catch (_e) { }

            await new Promise(r => setTimeout(r, TAB_POLL_INTERVAL_MS));
        }
    } finally {
        try {
            await chrome.tabs.remove(articleTab.id);
        } catch (_e) { }
    }

    console.log(`[Extract] Background tab extracted ${articleText.length} chars in ${Date.now() - startTime}ms`);
    return articleText;
}
