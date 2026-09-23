// content.js — Injected on demand via right-click context menu
// Extracts the page's article text, sends it to background for summarisation,
// and displays the result in a floating overlay.

(function () {
    // ─── Constants ───────────────────────────────────────

    const LOG_PREFIX = '[Clickbait Remover]';
    const MIN_ARTICLE_LENGTH = 50;    // reject pages with less text than this
    const MIN_SELECTOR_LENGTH = 150;   // selector match must exceed this
    const MIN_LINE_LENGTH = 20;    // drop short noise lines (nav, buttons)
    const MAX_TEXT_LENGTH = 8000;  // cap sent to background
    const MAX_FALLBACK_LENGTH = 50000; // ignore monster divs (likely the whole page)

    // ─── Toggle guard ────────────────────────────────────

    if (document.getElementById('cbr-overlay')) {
        document.getElementById('cbr-overlay').remove();
        return;
    }

    // ─── 1. Create overlay (loading state) ───────────────

    const overlay = document.createElement('div');
    overlay.id = 'cbr-overlay';
    overlay.innerHTML = `
        <div class="cbr-overlay-header">
            <span class="cbr-overlay-title">📝 Summary</span>
            <button class="cbr-overlay-close" title="Close">✕</button>
        </div>
        <div class="cbr-overlay-body">
            <div class="cbr-loader"></div>
            <span>Generating summary…</span>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.cbr-overlay-close').addEventListener('click', () => {
        overlay.remove();
    });

    // ─── 2. Extract headline + article text ──────────────

    const headline = extractHeadline();
    const articleText = extractArticleText();

    console.log(`${LOG_PREFIX} Headline: ${headline}`);
    console.log(`${LOG_PREFIX} Extracted text (${articleText.length} chars)`);

    if (!articleText || articleText.length < MIN_ARTICLE_LENGTH) {
        showResult(overlay, 'Could not extract enough text from this page.');
        return;
    }

    // ─── 3. Send to background for LLM summarisation ────

    chrome.runtime.sendMessage(
        { action: 'summarizeArticle', text: articleText, headline },
        (response) => {
            if (response?.success) {
                console.log(`${LOG_PREFIX} Summary: ${response.summary}`);
                showResult(overlay, response.summary);
            } else {
                const err = response?.error || 'Unknown error';
                console.error(`${LOG_PREFIX} Failed:`, err);
                showResult(overlay, `Error: ${err}`);
            }
        },
    );

    // ─── Helpers ─────────────────────────────────────────

    function showResult(overlayEl, text) {
        const body = overlayEl.querySelector('.cbr-overlay-body');
        body.innerHTML = `<p class="cbr-summary-text">${escapeHtml(text)}</p>`;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function extractHeadline() {
        const raw = window.__cbrHeadline || document.title || '';
        console.log(`${LOG_PREFIX} Headline: ${raw}`);
        return raw;
    }

    function extractArticleText() {
        // Use shared selectors from selectors.js (injected before content.js)
        const selectors = (typeof ARTICLE_SELECTORS !== 'undefined')
            ? ARTICLE_SELECTORS
            : ['article', '[role="main"]', 'main'];   // minimal fallback

        // Strip noise elements first
        if (typeof NOISE_SELECTORS !== 'undefined') {
            document.querySelectorAll(NOISE_SELECTORS).forEach(el => el.remove());
        }

        // Try each selector; return the first one with substantial text
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                const text = cleanText(el.innerText);
                if (text.length > MIN_SELECTOR_LENGTH) {
                    console.log(`${LOG_PREFIX} Matched selector: ${sel}`);
                    return text.substring(0, MAX_TEXT_LENGTH);
                }
            }
        }

        // Fallback: largest text block on the page
        let best = { el: null, len: 0 };
        for (const div of document.querySelectorAll('div, section')) {
            const len = div.innerText.trim().length;
            if (len > best.len && len < MAX_FALLBACK_LENGTH) {
                best = { el: div, len };
            }
        }

        if (best.el && best.len > MIN_SELECTOR_LENGTH) {
            console.log(`${LOG_PREFIX} Fallback: largest div (${best.len} chars)`);
            return cleanText(best.el.innerText).substring(0, MAX_TEXT_LENGTH);
        }

        // Last resort: full body text
        console.log(`${LOG_PREFIX} Fallback: body text`);
        return cleanText(document.body.innerText).substring(0, MAX_TEXT_LENGTH);
    }

    function cleanText(raw) {
        return raw
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > MIN_LINE_LENGTH)
            .join('\n')
            .trim();
    }
})();
