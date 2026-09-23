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

/**
 * Budget article text using bimodal truncation (head + tail) to minimize LLM prefill time
 * while preserving key answer areas (headline/lead and conclusion/reveal).
 * @param {string} text - Cleaned article text
 * @param {number} [maxChars=2500] - Total maximum characters
 * @param {number} [leadChars=1500] - Characters allocated to the beginning
 * @param {number} [tailChars=1000] - Characters allocated to the end
 * @returns {string} Budgeted text
 */
function budgetArticleText(text, maxChars = 2500, leadChars = 1500, tailChars = 1000) {
    if (!text) return '';
    if (text.length <= maxChars) return text;

    const SEPARATOR = '\n\n[...]\n\n';
    const available = maxChars - SEPARATOR.length;
    if (available <= 0) return text.substring(0, maxChars);

    let actualLead = leadChars;
    let actualTail = tailChars;

    if (actualLead + actualTail > available) {
        const ratio = actualLead / (actualLead + actualTail);
        actualLead = Math.floor(available * ratio);
        actualTail = available - actualLead;
    }

    const head = text.substring(0, actualLead).trimEnd();
    const tail = text.substring(text.length - actualTail).trimStart();

    return `${head}${SEPARATOR}${tail}`;
}

/**
 * Filter raw LLM output to extract only the clean spoiler lines (❓ and 💡),
 * removing any conversational preamble, chain-of-thought, or echoed prompt rules.
 * @param {string} text - Raw LLM output
 * @returns {string} Cleaned spoiler text
 */
function filterSpoilerResponse(text) {
    if (!text) return '';

    // If ❓ is present, everything before ❓ is preamble / echoed rules — strip it!
    const qIndex = text.indexOf('❓');
    if (qIndex !== -1) {
        return text.substring(qIndex).trim();
    }

    // If no ❓ yet, filter out echoed meta lines
    const lines = text.split('\n');
    const filtered = lines.filter(line => {
        const trimmed = line.trim();
        if (/^\*?\s*(Role|Task|Step \d|Strict Rules|Language):/i.test(trimmed)) return false;
        if (/^You are a spoiler/i.test(trimmed)) return false;
        return true;
    });

    return filtered.join('\n').trim();
}

// ─── Exports ─────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { cleanArticleText, budgetArticleText, filterSpoilerResponse };
}
