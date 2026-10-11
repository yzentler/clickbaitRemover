// ui-bridge.js — Everything the service worker does *to a page* lives here.
//
// Cards: state is sent as messages to overlay-ui.js (the sole renderer).
// Inline badges + viewport scanning: thin wrappers over viewport-scanner.js helpers.

async function showTimingEnabled() {
    const { showTiming } = await chrome.storage.local.get('showTiming');
    return showTiming !== false;
}

/** Inject the overlay renderer. Idempotent (the script guards against double install). */
export async function ensureOverlay(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay-ui.js'] });
}

async function send(tabId, message) {
    await chrome.tabs.sendMessage(tabId, { cbr: 'overlay', ...message });
}

/** Create or replace one card. */
export async function upsertCard(tabId, card) {
    await ensureOverlay(tabId);
    await send(tabId, { op: 'upsert', card, showTiming: await showTimingEnabled() });
}

/** Live-update a card's answer text. Fire-and-forget: a closed tab or overlay is fine. */
export function streamCard(tabId, id, text) {
    return send(tabId, { op: 'stream', id, text }).catch(() => { });
}

/** Rebuild saved cards after navigation. */
export async function restoreCards(tabId, cards) {
    await ensureOverlay(tabId);
    await send(tabId, { op: 'restore', cards, showTiming: await showTimingEnabled() });
}

// ─── Current-page text ───────────────────────────────────────

/** Read the live page's article text without modifying it. */
export async function extractCurrentPageText(tabId, noiseSelectors, articleSelectors, minLength, maxLength) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['page-extract.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (noise, selectors, min, max) => window.__cbrExtractPageText(noise, selectors, min, max),
        args: [noiseSelectors, articleSelectors, minLength, maxLength],
    });
    return result || '';
}

// ─── Viewport spoilers (inline badges) ───────────────────────

/** Inject the scanner + badge styles and return visible headline-link candidates. */
export async function scanViewport(tabId) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['inline-spoiler.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['viewport-scanner.js'] });
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (typeof window.__cbrScanViewport === 'function' ? window.__cbrScanViewport() : []),
    });
    return results?.[0]?.result || [];
}

export async function injectBadges(tabId, items) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (list) => {
            if (typeof window.__cbrInjectInlineBadge === 'function') {
                list.forEach(item => window.__cbrInjectInlineBadge(item.cbrId, item.headline));
            }
        },
        args: [items],
    });
}

/** Update one inline badge. Never throws: the tab may have navigated away. */
export async function updateBadge(tabId, cbrId, text, isError = false) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (id, spoiler, err) => {
                if (typeof window.__cbrUpdateInlineBadge === 'function') {
                    window.__cbrUpdateInlineBadge(id, spoiler, err);
                }
            },
            args: [cbrId, text, isError],
        });
    } catch (_err) { }
}

// ─── Headline lookup ─────────────────────────────────────────

const HEBREW_BYLINE_RE = /^(מערכת|כתב\/ת|כתבת|כתב)\s/;
const HEBREW_SOURCE_RE = /וואלה|ynet|ישראל היום|מעריב|הארץ|N12|חדשות\s*\d*/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/**
 * Find a link's headline text on the page: a heading inside the <a> if present,
 * otherwise the longest line of its text that isn't a byline, source, time or date.
 */
export async function extractHeadlineFromLink(tabId, linkUrl) {
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (url, byline, source, time, date) => {
            const bylineRe = new RegExp(byline);
            const sourceRe = new RegExp(source);
            const timeRe = new RegExp(time);
            const dateRe = new RegExp(date);
            const candidates = [];

            for (const link of document.querySelectorAll('a')) {
                if (link.href !== url) continue;

                const heading = link.querySelector('h1, h2, h3, h4');
                if (heading) {
                    const text = heading.innerText.trim();
                    if (text.length > 5) {
                        candidates.push({ text, priority: 1 });
                        continue;
                    }
                }

                const rawText = link.innerText.trim();
                if (rawText.length <= 3) continue;

                const cleaned = rawText
                    .split('\n')
                    .map(l => l.trim())
                    .filter(l => l.length > 0)
                    .filter(line => !bylineRe.test(line) && !sourceRe.test(line) && !timeRe.test(line) && !dateRe.test(line));

                if (cleaned.length > 0) {
                    cleaned.sort((a, b) => b.length - a.length);
                    candidates.push({ text: cleaned[0], priority: 2 });
                }
            }

            if (candidates.length === 0) return '';
            candidates.sort((a, b) => a.priority - b.priority || b.text.length - a.text.length);
            return candidates[0].text;
        },
        args: [linkUrl, HEBREW_BYLINE_RE.source, HEBREW_SOURCE_RE.source, TIME_RE.source, DATE_RE.source],
    });

    return result || '';
}
