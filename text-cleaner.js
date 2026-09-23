// text-cleaner.js — Pure text cleaning utilities (no Chrome API dependencies)

// ─── Constants ───────────────────────────────────────────────

const MAX_CLEAN_LENGTH = 6000;  // cap output sent to LLM
const MIN_LINE_LENGTH = 4;     // lines shorter than this are noise (buttons, labels)

// Patterns for lines that are noise rather than article content
const STANDALONE_URL_RE = /^https?:\/\//;
const SHARE_LINE_RE = /^(שתף ב|share|tweet|whatsapp|facebook|twitter|telegram)/i;
const CSS_CLASS_RE = /^\.css-/;
const UI_ELEMENT_RE = /^(תגובות|comments|עוד באותו נושא|כתבות נוספות|מומלצים עבורך)/i;

// ─── Cleaner ─────────────────────────────────────────────────

/**
 * Clean extracted article text by removing noise, deduplicating, and normalising.
 * @param {string} text - Raw extracted article text
 * @returns {string} Cleaned text, capped at MAX_CLEAN_LENGTH chars
 */
function cleanArticleText(text) {
    if (!text) return '';

    let lines = text.split('\n');

    // Remove lines that are noise
    lines = lines.filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (STANDALONE_URL_RE.test(trimmed)) return false;
        if (SHARE_LINE_RE.test(trimmed)) return false;
        if (CSS_CLASS_RE.test(trimmed)) return false;
        if (trimmed.length < MIN_LINE_LENGTH) return false;
        if (UI_ELEMENT_RE.test(trimmed)) return false;
        return true;
    });

    // Deduplicate identical lines
    const seen = new Set();
    lines = lines.filter(line => {
        const key = line.trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Collapse excessive whitespace
    const result = lines
        .join('\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n');

    return result.trim().substring(0, MAX_CLEAN_LENGTH);
}

// ─── Exports ─────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { cleanArticleText };
}
