// page-extract.js — Non-destructive article text extraction for a live page (classic content script)
//
// Noise elements are hidden while text is read and restored afterwards, so the page the user
// is reading is never modified. Selectors are passed in (selectors.js is a service-worker module).

(() => {
    if (typeof window === 'undefined') return;

    /**
     * @param {string} noiseSelectors   - Comma-separated selector list to hide while reading
     * @param {string[]} articleSelectors - Tried in order; first with enough text wins
     * @param {number} minLength        - A selector match must exceed this many characters
     * @param {number} maxLength        - Cap on returned text
     * @returns {string}
     */
    function extractPageText(noiseSelectors, articleSelectors, minLength, maxLength) {
        const read = (el) => (el.innerText ?? el.textContent ?? '').trim();

        const hidden = [];
        try {
            document.querySelectorAll(noiseSelectors).forEach(el => {
                hidden.push({ el, style: el.getAttribute('style') });
                el.style.setProperty('display', 'none', 'important');
            });

            for (const sel of articleSelectors) {
                const el = document.querySelector(sel);
                if (!el) continue;
                const text = read(el);
                if (text.length > minLength) return text.substring(0, maxLength);
            }
            return document.body ? read(document.body).substring(0, maxLength) : '';
        } finally {
            // Restore the exact original style attribute (or its absence)
            for (const { el, style } of hidden) {
                if (style === null) el.removeAttribute('style');
                else el.setAttribute('style', style);
            }
        }
    }

    window.__cbrExtractPageText = extractPageText;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { extractPageText };
    }
})();
