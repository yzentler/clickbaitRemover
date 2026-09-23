// background.js — Service-worker orchestrator
// Wires together: context menu → extraction → LLM → overlay

importScripts('prompts.js', 'selectors.js', 'text-cleaner.js', 'card-state.js', 'llm-providers.js');

// ─── Constants ───────────────────────────────────────────────

const MAX_TEXT_LENGTH = 8000;   // cap sent to LLM
const MIN_TEXT_LENGTH = 150;    // below this, selector match is "too short"
const MIN_FETCH_LENGTH = 200;   // below this, fast-fetch is considered failed
const TAB_LOAD_DELAY_MS = 2000;  // wait for JS-heavy pages to hydrate
const CONTEXT_MENU_ID = 'summarizePage';

// Patterns used to detect JS-framework "shell" pages (no real article HTML)
const CLIENT_RENDERED_MARKERS = [
    '__NEXT_DATA__',
    'window.__APP',
    'React.createElement',
    '_buildManifest',
];

// ─── Request counter ─────────────────────────────────────────

let requestCounter = 0;

// ─── Context menu setup ──────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: '🔍 Reveal the Spoiler',
        contexts: ['page', 'link', 'selection'],
    });
    console.log('[Background] Context menu created.');
});

// ─── Navigation listeners: re-inject overlay on page load ────

// Primary trigger — webNavigation fires reliably on navigation
chrome.webNavigation.onCompleted.addListener(({ frameId, url, tabId }) => {
    if (frameId !== 0) return;           // main frame only
    if (!url.startsWith('http')) return;
    reinjectOverlay(tabId);
});

// Backup trigger
chrome.tabs.onUpdated.addListener((tabId, { status }, { url = '' }) => {
    if (status !== 'complete') return;
    if (!url.startsWith('http')) return;
    reinjectOverlay(tabId);
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => clearCards(tabId));

// ─── Context menu click handler ──────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_ID) return;

    const cardId = `cbr-card-${++requestCounter}`;
    console.log(`[Background] Context menu clicked, card: ${cardId}`);

    try {
        if (info.linkUrl) {
            await handleLinkClick(tab, cardId, info.linkUrl);
        } else {
            await handlePageClick(tab);
        }
    } catch (err) {
        console.error('[Background] Error:', err);
        try {
            await updateCardError(tab.id, cardId, err.message);
            saveCard(tab.id, cardId, { status: 'error', text: `Error: ${err.message}` });
        } catch (_ignored) { /* overlay may already be gone */ }
    }
});

/**
 * Handle right-click on a *link*: extract headline → fetch article → LLM → show card.
 */
async function handleLinkClick(tab, cardId, linkUrl) {
    const startTime = Date.now();

    // 1. Extract headline text from the clicked link
    const headline = await extractHeadlineFromLink(tab.id, linkUrl);
    console.log(`[Background] Headline: "${headline}"`);

    // 2. Inject overlay + loading card
    await injectLoadingCard(tab.id, cardId, headline, linkUrl);
    saveCard(tab.id, cardId, { headline, url: linkUrl, status: 'loading', text: 'Fetching article…' });

    // 3. Extract article text (fast-fetch first, background-tab fallback)
    let articleText = await extractArticleText(tab.id, linkUrl, cardId);

    // 4. Show "analysing" state
    await updateCardLoading(tab.id, cardId, `Analyzing… (${articleText.length.toLocaleString()} chars)`);

    // 5. Clean extracted text
    articleText = cleanArticleText(articleText);
    console.log(`[Background] Cleaned text: ${articleText.length} chars`);

    // 6. Call LLM
    const summary = await callLLM(articleText, headline);

    // 7. Compute elapsed time and show result
    const elapsedMs = Date.now() - startTime;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    console.log(`[Background] Spoiler completed in ${elapsedSec}s`);

    await updateCardResult(tab.id, cardId, summary, elapsedMs);
    saveCard(tab.id, cardId, { status: 'done', text: summary, elapsedMs });
}

/**
 * Handle right-click on the *page* itself: inject content.js for on-page extraction.
 */
async function handlePageClick(tab) {
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { window.__cbrHeadline = ''; },
    });
    await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['styles.css'],
    });
    // Inject selectors first so content.js can reference ARTICLE_SELECTORS / NOISE_SELECTORS
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['selectors.js'],
    });
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
    });
}

// ─── Message handler ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log(`[Background] Message received: action=${request.action}`);

    if (request.action === 'summarizeArticle') {
        console.log(`[Background] Headline: ${request.headline || '(none)'}`);
        console.log(`[Background] Text length: ${request.text?.length || 0} chars`);

        if (!request.text) {
            sendResponse({ success: false, error: 'No text provided' });
            return true;
        }

        callLLM(request.text, request.headline)
            .then(summary => sendResponse({ success: true, summary }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;   // keep message channel open for async response
    }

    if (request.action === 'clearCards' && sender.tab) {
        clearCards(sender.tab.id);
    }
});

// ─── Headline extraction ─────────────────────────────────────

// Regex patterns for filtering noise from link text
const HEBREW_BYLINE_RE = /^(מערכת|כתב\/ת|כתבת|כתב)\s/;
const HEBREW_SOURCE_RE = /וואלה|ynet|ישראל היום|מעריב|הארץ|N12|חדשות\s*\d*/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/**
 * Extract headline text from a link element on the page.
 * Prefers <h1-h4> inside the link, falls back to longest cleaned text line.
 */
async function extractHeadlineFromLink(tabId, linkUrl) {
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

                // Priority 1 — heading inside <a>
                const heading = link.querySelector('h1, h2, h3, h4');
                if (heading) {
                    const text = heading.innerText.trim();
                    if (text.length > 5) {
                        candidates.push({ text, priority: 1 });
                        continue;
                    }
                }

                // Priority 2 — cleaned innerText
                const rawText = link.innerText.trim();
                if (rawText.length <= 3) continue;

                const cleaned = rawText
                    .split('\n')
                    .map(l => l.trim())
                    .filter(l => l.length > 0)
                    .filter(line =>
                        !bylineRe.test(line) &&
                        !sourceRe.test(line) &&
                        !timeRe.test(line) &&
                        !dateRe.test(line)
                    );

                if (cleaned.length > 0) {
                    cleaned.sort((a, b) => b.length - a.length);
                    candidates.push({ text: cleaned[0], priority: 2 });
                }
            }

            if (candidates.length === 0) return '';
            candidates.sort((a, b) => a.priority - b.priority || b.text.length - a.text.length);
            return candidates[0].text;
        },
        args: [
            linkUrl,
            HEBREW_BYLINE_RE.source,
            HEBREW_SOURCE_RE.source,
            TIME_RE.source,
            DATE_RE.source,
        ],
    });

    return result || '';
}

// ─── Overlay injection ───────────────────────────────────────

/**
 * Inject CSS + overlay + loading card into a tab.
 */
async function injectLoadingCard(tabId, cardId, headline, articleUrl) {
    await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['styles.css'],
    });

    await chrome.scripting.executeScript({
        target: { tabId },
        func: (id, headlineText, url) => {
            let overlay = document.getElementById('cbr-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'cbr-overlay';
                overlay.innerHTML = `
                    <div class="cbr-overlay-header">
                        <span class="cbr-overlay-title">🔍 Spoiler</span>
                        <button class="cbr-overlay-close" title="Close">✕</button>
                    </div>
                    <div class="cbr-cards"></div>
                `;
                document.body.appendChild(overlay);

                overlay.querySelector('.cbr-overlay-close').addEventListener('click', (e) => {
                    e.stopPropagation();
                    overlay.remove();
                    chrome.runtime.sendMessage({ action: 'clearCards' });
                });
                overlay.addEventListener('click', (e) => e.stopPropagation());
            }

            // Build a new loading card
            const card = document.createElement('div');
            card.className = 'cbr-card';
            card.id = id;

            const safeHeadline = document.createElement('span');
            safeHeadline.textContent = headlineText || 'Loading…';

            card.innerHTML = `
                <a class="cbr-card-headline" href="${url}" target="_blank"
                   rel="noopener" title="${safeHeadline.textContent}">${safeHeadline.textContent}</a>
                <div class="cbr-card-loading">
                    <div class="cbr-loader"></div>
                    <span>Fetching article…</span>
                </div>
            `;
            card.querySelector('.cbr-card-headline').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.open(url, '_blank');
            });

            const cardsContainer = overlay.querySelector('.cbr-cards');
            cardsContainer.appendChild(card);
            cardsContainer.scrollTop = cardsContainer.scrollHeight;
        },
        args: [cardId, headline, articleUrl],
    });
}

// ─── Article text extraction ─────────────────────────────────

// ARTICLE_SELECTORS / NOISE_SELECTORS loaded from selectors.js

/**
 * Extract article text: fast-fetch first, background-tab fallback.
 */
async function extractArticleText(tabId, linkUrl, cardId) {
    // ── Fast path: fetch raw HTML in the service worker ──
    const fetchedText = await tryFastFetch(tabId, linkUrl);
    if (fetchedText && fetchedText.length >= MIN_FETCH_LENGTH) {
        console.log(`[Background] Fast fetch OK (${fetchedText.length} chars)`);
        return fetchedText;
    }

    // ── Slow path: open a background tab and wait for full render ──
    return await extractViaBackgroundTab(tabId, linkUrl, cardId);
}

/**
 * Attempt a fast fetch of the article HTML and parse it in the page context.
 * Returns empty string if the fetched HTML looks like a JS-rendered shell.
 */
async function tryFastFetch(tabId, linkUrl) {
    try {
        const response = await fetch(linkUrl);
        const html = await response.text();

        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (htmlStr, noiseSelectors, articleSelectors, minLength) => {
                const doc = new DOMParser().parseFromString(htmlStr, 'text/html');
                doc.querySelectorAll(noiseSelectors).forEach(el => el.remove());

                for (const sel of articleSelectors) {
                    const el = doc.querySelector(sel);
                    if (el && el.textContent.trim().length > minLength) {
                        return el.textContent.trim().substring(0, 8000);
                    }
                }
                return doc.body?.textContent?.trim().substring(0, 8000) || '';
            },
            args: [html, NOISE_SELECTORS, ARTICLE_SELECTORS, MIN_TEXT_LENGTH],
        });

        const text = result || '';
        if (looksLikeClientRendered(html, text)) {
            console.log('[Background] Fast fetch looks like client-rendered JS. Falling back.');
            return '';
        }
        return text;
    } catch (err) {
        console.log(`[Background] Fast fetch failed: ${err.message}`);
        return '';
    }
}

/**
 * Heuristic: does the fetched HTML look like a JS-framework shell
 * rather than server-rendered article content?
 */
function looksLikeClientRendered(html, extractedText) {
    if (extractedText.length < MIN_FETCH_LENGTH) return true;

    for (const marker of CLIENT_RENDERED_MARKERS) {
        if (extractedText.includes(marker)) return true;
    }

    const scriptCount = (html.match(/<script/gi) || []).length;
    const pCount = (html.match(/<p[\s>]/gi) || []).length;
    return scriptCount > pCount * 3 && pCount < 5;
}

/**
 * Open the article in a hidden tab, wait for JS to render, then extract text.
 */
async function extractViaBackgroundTab(tabId, linkUrl, cardId) {
    await updateCardLoading(tabId, cardId, 'Loading article page…');

    const articleTab = await chrome.tabs.create({ url: linkUrl, active: false });

    // Wait for the tab to finish loading
    await new Promise((resolve) => {
        const listener = (tid, changeInfo) => {
            if (tid === articleTab.id && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });

    // Extra delay for JS-heavy pages to hydrate
    await new Promise(resolve => setTimeout(resolve, TAB_LOAD_DELAY_MS));

    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: articleTab.id },
        func: (noiseSelectors, articleSelectors, minLength) => {
            document.querySelectorAll(noiseSelectors).forEach(el => el.remove());

            for (const sel of articleSelectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText.trim().length > minLength) {
                    return el.innerText.trim().substring(0, 8000);
                }
            }
            return document.body?.innerText?.trim().substring(0, 8000) || '';
        },
        args: [NOISE_SELECTORS, ARTICLE_SELECTORS, MIN_TEXT_LENGTH],
    });

    await chrome.tabs.remove(articleTab.id);

    const articleText = result || '';
    console.log(`[Background] Background tab extracted ${articleText.length} chars`);
    return articleText;
}

// ─── Card DOM updates ────────────────────────────────────────

/** Update a card's loading status text. */
async function updateCardLoading(tabId, cardId, message) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (id, msg) => {
            const span = document.querySelector(`#${id} .cbr-card-loading span`);
            if (span) span.textContent = msg;
        },
        args: [cardId, message],
    });
}

/** Replace a card's loading state with the final result text + optional timing. */
async function updateCardResult(tabId, cardId, text, elapsedMs = 0) {
    const { showTiming } = await chrome.storage.local.get('showTiming');

    await chrome.scripting.executeScript({
        target: { tabId },
        func: (id, resultText, elapsed, shouldShowTiming) => {
            const card = document.getElementById(id);
            if (!card) return;
            card.querySelector('.cbr-card-loading')?.remove();

            const paragraph = document.createElement('p');
            paragraph.className = 'cbr-card-text';
            paragraph.textContent = resultText;
            card.appendChild(paragraph);

            if (shouldShowTiming && elapsed > 0) {
                const timingEl = document.createElement('span');
                timingEl.className = 'cbr-card-timing';
                const secs = (elapsed / 1000).toFixed(1);
                timingEl.textContent = `⏱ ${secs}s`;
                card.appendChild(timingEl);
            }
        },
        args: [cardId, text, elapsedMs, showTiming !== false],
    });
}

/** Replace a card's loading state with an error message. */
async function updateCardError(tabId, cardId, errorMessage) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (id, errMsg) => {
            const card = document.getElementById(id);
            if (!card) return;
            card.querySelector('.cbr-card-loading')?.remove();

            const paragraph = document.createElement('p');
            paragraph.className = 'cbr-card-text';
            paragraph.style.color = '#ff6b6b';
            paragraph.textContent = `Error: ${errMsg}`;
            card.appendChild(paragraph);
        },
        args: [cardId, errorMessage],
    });
}
