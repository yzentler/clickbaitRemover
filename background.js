// background.js — Service-worker orchestrator
// Wires together: context menu → extraction → LLM → overlay

importScripts('prompts.js', 'selectors.js', 'text-cleaner.js', 'structured-extractor.js', 'batch-extractor.js', 'card-state.js', 'llm-providers.js');

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
        contexts: ['link', 'selection'],
    });
    chrome.contextMenus.create({
        id: 'revealVisibleSpoilers',
        title: '🔍 Reveal Visible Spoilers (Screen)',
        contexts: ['page'],
    });
    console.log('[Background] Context menus created.');
});

// ─── Keyboard commands ───────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'reveal-visible-spoilers') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
            await handleRevealVisibleSpoilers(tab);
        }
    }
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
    if (info.menuItemId === 'revealVisibleSpoilers') {
        await handleRevealVisibleSpoilers(tab);
        return;
    }

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

    // 0. Cache check (0ms instant response)
    const cacheKey = `cbr_cache_${linkUrl}`;
    try {
        const cached = await chrome.storage.local.get(cacheKey);
        if (cached && cached[cacheKey]) {
            const item = cached[cacheKey];
            console.log(`[Background] Cache hit for ${linkUrl}`);
            await injectLoadingCard(tab.id, cardId, item.headline || 'Spoiler', linkUrl);
            await updateCardResult(tab.id, cardId, item.summary, 0);
            saveCard(tab.id, cardId, { status: 'done', text: item.summary, elapsedMs: 0 });
            return;
        }
    } catch (_e) { }

    // 1. Parallelize headline extraction and article text fetching
    const headlinePromise = extractHeadlineFromLink(tab.id, linkUrl);
    const textPromise = extractArticleText(tab.id, linkUrl, cardId);

    // 2. Inject overlay + loading card immediately
    await injectLoadingCard(tab.id, cardId, 'Loading…', linkUrl);
    saveCard(tab.id, cardId, { headline: 'Loading…', url: linkUrl, status: 'loading', text: 'Fetching article…' });

    let [headline, articleText] = await Promise.all([headlinePromise, textPromise]);
    console.log(`[Background] Parallel extraction complete. Headline: "${headline}", Text length: ${articleText.length}`);

    if (headline) {
        await updateCardHeadline(tab.id, cardId, headline);
    }

    // 3. Show "analysing" state
    await updateCardLoading(tab.id, cardId, `Analyzing… (${articleText.length.toLocaleString()} chars)`);

    // 4. Clean extracted text
    articleText = cleanArticleText(articleText);
    console.log(`[Background] Cleaned text: ${articleText.length} chars`);

    // 5. Call LLM with token streaming
    let streamStarted = false;
    const summary = await callLLM(articleText, headline, (chunk, accumulated) => {
        if (!streamStarted) {
            streamStarted = true;
            updateCardStartStream(tab.id, cardId);
        }
        updateCardStreamChunk(tab.id, cardId, accumulated);
    });

    // 6. Compute elapsed time and finalize result
    const elapsedMs = Date.now() - startTime;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    console.log(`[Background] Spoiler completed in ${elapsedSec}s`);

    await updateCardResult(tab.id, cardId, summary, elapsedMs);
    saveCard(tab.id, cardId, { status: 'done', text: summary, elapsedMs });

    // 7. Save to cache
    try {
        await chrome.storage.local.set({
            [cacheKey]: { headline, summary, elapsedMs }
        });
    } catch (_e) { }
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

        // 1. Structured metadata extraction directly in Service Worker (JSON-LD, __NEXT_DATA__, og:description)
        if (typeof extractStructuredArticleText === 'function') {
            const structured = extractStructuredArticleText(html);
            if (structured && structured.length >= MIN_FETCH_LENGTH) {
                console.log(`[Background] Fast structured extraction OK (${structured.length} chars)`);
                return structured;
            }
        }

        // 2. Fallback to DOM evaluation in page context
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
    if (extractedText.length >= MIN_FETCH_LENGTH) return false;

    for (const marker of CLIENT_RENDERED_MARKERS) {
        if (extractedText.includes(marker)) return true;
    }

    const scriptCount = (html.match(/<script/gi) || []).length;
    const pCount = (html.match(/<p[\s>]/gi) || []).length;
    return scriptCount > pCount * 3 && pCount < 5;
}

/**
 * Open the article in a hidden tab and actively poll for article selectors.
 */
async function extractViaBackgroundTab(tabId, linkUrl, cardId) {
    await updateCardLoading(tabId, cardId, 'Loading article page…');

    const articleTab = await chrome.tabs.create({ url: linkUrl, active: false });
    let articleText = '';
    const startTime = Date.now();

    try {
        // Wait for the tab to finish loading with a 3500ms safety timeout
        await new Promise((resolve) => {
            let timeoutId;
            const listener = (tid, changeInfo) => {
                if (tid === articleTab.id && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    if (timeoutId) clearTimeout(timeoutId);
                    resolve();
                }
            };
            timeoutId = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }, 3500);
            chrome.tabs.onUpdated.addListener(listener);
        });

        // Active polling for selector presence instead of unconditional 2000ms sleep!
        const maxPollTimeMs = 1500;
        const pollIntervalMs = 100;

        while (Date.now() - startTime < maxPollTimeMs) {
            try {
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

                if (result && result.length >= MIN_TEXT_LENGTH) {
                    articleText = result;
                    break;
                }
            } catch (_e) { }

            await new Promise(r => setTimeout(r, pollIntervalMs));
        }
    } finally {
        try {
            await chrome.tabs.remove(articleTab.id);
        } catch (_e) {}
    }

    console.log(`[Background] Background tab extracted ${articleText.length} chars in ${Date.now() - startTime}ms`);
    return articleText;
}

// ─── Card DOM updates ────────────────────────────────────────

/** Update a card's headline link text. */
async function updateCardHeadline(tabId, cardId, headlineText) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (id, text) => {
            const headlineEl = document.querySelector(`#${id} .cbr-card-headline`);
            if (headlineEl && text) {
                headlineEl.textContent = text;
                headlineEl.title = text;
            }
        },
        args: [cardId, headlineText],
    });
}

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

/** Prepare card for live streaming tokens. */
async function updateCardStartStream(tabId, cardId) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (id) => {
            const card = document.getElementById(id);
            if (!card) return;
            card.querySelector('.cbr-card-loading')?.remove();
            let p = card.querySelector('.cbr-card-text');
            if (!p) {
                p = document.createElement('p');
                p.className = 'cbr-card-text';
                card.appendChild(p);
            }
        },
        args: [cardId],
    });
}

/** Stream a text chunk into the card in real-time. */
async function updateCardStreamChunk(tabId, cardId, accumulatedText) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (id, text) => {
            const card = document.getElementById(id);
            if (!card) return;
            let p = card.querySelector('.cbr-card-text');
            if (!p) {
                card.querySelector('.cbr-card-loading')?.remove();
                p = document.createElement('p');
                p.className = 'cbr-card-text';
                card.appendChild(p);
            }
            p.textContent = text;
        },
        args: [cardId, accumulatedText],
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

            let paragraph = card.querySelector('.cbr-card-text');
            if (!paragraph) {
                paragraph = document.createElement('p');
                paragraph.className = 'cbr-card-text';
                card.appendChild(paragraph);
            }
            paragraph.textContent = resultText;

            if (shouldShowTiming && elapsed > 0 && !card.querySelector('.cbr-card-timing')) {
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

            let paragraph = card.querySelector('.cbr-card-text');
            if (!paragraph) {
                paragraph = document.createElement('p');
                paragraph.className = 'cbr-card-text';
                card.appendChild(paragraph);
            }
            paragraph.style.color = '#ff6b6b';
            paragraph.textContent = `Error: ${errMsg}`;
        },
        args: [cardId, errorMessage],
    });
}

// ─── Viewport Batch Spoilers ─────────────────────────────────

/**
 * Update an inline headline spoiler badge.
 */
async function updateInlineResult(tabId, cbrId, spoilerText, isError = false) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (id, text, err) => {
                if (typeof window.__cbrUpdateInlineBadge === 'function') {
                    window.__cbrUpdateInlineBadge(id, text, err);
                }
            },
            args: [cbrId, spoilerText, isError],
        });
    } catch (_err) {
        // Tab may have closed or navigated away
    }
}

/**
 * Handle revealing all visible spoilers in the current viewport.
 * Discovers 4-6 headline links currently on screen, extracts them concurrently
 * with a rate-limit safe limit (max 3), and renders inline badges.
 */
async function handleRevealVisibleSpoilers(tab) {
    if (!tab?.id || !tab?.url || !tab.url.startsWith('http')) return;
    console.log(`[Background] Starting viewport batch spoilers on tab ${tab.id}`);

    // 1. Inject styling and content script
    try {
        await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['inline-spoiler.css'],
        });
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['viewport-scanner.js'],
        });
    } catch (err) {
        console.error('[Background] Failed to inject viewport scanner:', err);
        return;
    }

    // 2. Scan viewport for visible links
    let scanResults;
    try {
        scanResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                return typeof window.__cbrScanViewport === 'function'
                    ? window.__cbrScanViewport()
                    : [];
            },
        });
    } catch (err) {
        console.error('[Background] Failed to scan viewport:', err);
        return;
    }

    const rawLinks = scanResults?.[0]?.result || [];
    if (rawLinks.length === 0) {
        console.log('[Background] No visible headline links found in viewport.');
        return;
    }

    // 3. Filter candidates
    let currentHost = '';
    try {
        currentHost = new URL(tab.url).hostname;
    } catch (_e) {}

    const candidates = filterHeadlineCandidates(rawLinks, currentHost, 15);
    if (candidates.length === 0) {
        console.log('[Background] No valid headline candidates after filtering.');
        return;
    }

    console.log(`[Background] Discovered ${candidates.length} visible headlines to spoil.`);

    // 4. Map back to element cbrId
    const candidateItems = candidates.map(c => {
        const cbrId = c.id || rawLinks.find(r => normalizeArticleUrl(r.url) === c.url)?.id;
        return {
            cbrId,
            url: c.url,
            headline: c.headline,
        };
    }).filter(item => item.cbrId);

    if (candidateItems.length === 0) return;

    // 5. Inject loading badges for all candidates
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (items) => {
                if (typeof window.__cbrInjectInlineBadge === 'function') {
                    items.forEach(item => window.__cbrInjectInlineBadge(item.cbrId, item.headline));
                }
            },
            args: [candidateItems],
        });
    } catch (err) {
        console.error('[Background] Failed to inject inline badges:', err);
        return;
    }

    // 6. Check cache first for all candidate items
    const uncachedItems = [];
    for (const item of candidateItems) {
        const cacheKey = `cbr_cache_${item.url}`;
        try {
            const cached = await chrome.storage.local.get(cacheKey);
            if (cached[cacheKey]?.summary) {
                console.log(`[Background] Cache hit for ${item.url}`);
                await updateInlineResult(tab.id, item.cbrId, cached[cacheKey].summary);
                continue;
            }
        } catch (_e) {}
        uncachedItems.push(item);
    }

    if (uncachedItems.length === 0) {
        console.log('[Background] All visible headlines retrieved from cache.');
        return;
    }

    // 7. Group uncached items into chunks of 3 for concurrent extraction and batched LLM calls
    const chunks = chunkItems(uncachedItems, 3);
    console.log(`[Background] Processing ${uncachedItems.length} articles across ${chunks.length} batched LLM chunks`);

    for (const chunk of chunks) {
        // Extract up to 3 articles concurrently
        const extractionResults = await Promise.allSettled(chunk.map(async (item) => {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Article extraction timed out')), 8000)
            );
            let articleText = await Promise.race([
                extractArticleText(tab.id, item.url, item.cbrId),
                timeoutPromise,
            ]);

            if (!articleText || articleText.length < MIN_TEXT_LENGTH) {
                throw new Error('Could not extract article content');
            }

            return cleanArticleText(articleText);
        }));

        // Filter valid extracted items vs failures
        const validItems = [];
        extractionResults.forEach((res, i) => {
            const item = chunk[i];
            if (res.status === 'fulfilled' && res.value) {
                validItems.push({
                    item,
                    headline: item.headline,
                    text: res.value,
                });
            } else {
                console.error(`[Background] Extraction failed for ${item.url}:`, res.reason);
                updateInlineResult(tab.id, item.cbrId, res.reason?.message || 'Could not extract article content', true);
            }
        });

        if (validItems.length === 0) continue;

        // Call LLM with up to 3 articles bundled in a single request (slashes RPM by 66%)
        try {
            const spoilers = await callBatchLLM(validItems.map(v => ({ headline: v.headline, text: v.text })));

            for (let i = 0; i < validItems.length; i++) {
                const v = validItems[i];
                const spoiler = spoilers[i] || 'Could not reveal spoiler';
                await updateInlineResult(tab.id, v.item.cbrId, spoiler);

                // Cache individual result
                try {
                    const cacheKey = `cbr_cache_${v.item.url}`;
                    await chrome.storage.local.set({
                        [cacheKey]: { headline: v.headline, summary: spoiler, elapsedMs: 0 },
                    });
                } catch (_e) {}
            }
        } catch (err) {
            console.error('[Background] Batch LLM call failed, falling back to individual calls:', err);
            for (const v of validItems) {
                try {
                    const singleSpoiler = await callLLM(v.text, v.headline);
                    await updateInlineResult(tab.id, v.item.cbrId, singleSpoiler);
                    const cacheKey = `cbr_cache_${v.item.url}`;
                    await chrome.storage.local.set({
                        [cacheKey]: { headline: v.headline, summary: singleSpoiler, elapsedMs: 0 },
                    });
                } catch (singleErr) {
                    await updateInlineResult(tab.id, v.item.cbrId, `Error: ${singleErr.message}`, true);
                }
            }
        }
    }

    console.log('[Background] Viewport batch spoilers complete.');
}


