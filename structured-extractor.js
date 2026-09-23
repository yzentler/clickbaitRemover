// structured-extractor.js — Extract clean article text directly from structured metadata
// Runs inside the Service Worker without requiring DOMParser or injected tab scripts.

const MIN_STRUCTURED_LENGTH = 100;

/**
 * Decode basic HTML entities into plain text.
 * @param {string} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
    if (!str) return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
}

/**
 * Strip HTML tags from a string.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract substantive text from Schema.org / JSON-LD objects.
 * @param {any} obj
 * @returns {string}
 */
function extractFromJsonLdObject(obj) {
    if (!obj || typeof obj !== 'object') return '';

    // Handle @graph array
    if (Array.isArray(obj['@graph'])) {
        for (const item of obj['@graph']) {
            const text = extractFromJsonLdObject(item);
            if (text.length >= MIN_STRUCTURED_LENGTH) return text;
        }
    }

    // Check @type
    const type = obj['@type'];
    const isArticle = typeof type === 'string' && /Article|Post|Report|News/i.test(type);
    const isArrayArticle = Array.isArray(type) && type.some(t => /Article|Post|Report|News/i.test(t));

    if (isArticle || isArrayArticle || obj.articleBody) {
        if (obj.articleBody && typeof obj.articleBody === 'string') {
            const body = decodeHtmlEntities(stripHtml(obj.articleBody));
            if (body.length >= MIN_STRUCTURED_LENGTH) return body;
        }
        if (obj.description && typeof obj.description === 'string') {
            const desc = decodeHtmlEntities(stripHtml(obj.description));
            if (desc.length >= MIN_STRUCTURED_LENGTH) return desc;
        }
    }

    return '';
}

/**
 * Recursively search Next.js pageProps for article content.
 * @param {any} node
 * @param {number} [depth=0]
 * @returns {string}
 */
function findNextArticleText(node, depth = 0) {
    if (!node || depth > 6 || typeof node !== 'object') return '';

    if (typeof node.body === 'string' && node.body.length >= MIN_STRUCTURED_LENGTH) {
        return decodeHtmlEntities(stripHtml(node.body));
    }
    if (typeof node.articleBody === 'string' && node.articleBody.length >= MIN_STRUCTURED_LENGTH) {
        return decodeHtmlEntities(stripHtml(node.articleBody));
    }
    if (typeof node.content === 'string' && node.content.length >= MIN_STRUCTURED_LENGTH) {
        return decodeHtmlEntities(stripHtml(node.content));
    }

    for (const key of Object.keys(node)) {
        if (key === 'article' || key === 'post' || key === 'item' || key === 'story' || key === 'pageProps' || key === 'props') {
            const res = findNextArticleText(node[key], depth + 1);
            if (res.length >= MIN_STRUCTURED_LENGTH) return res;
        }
    }

    return '';
}

/**
 * Extract clean article text directly from HTML structured metadata.
 * @param {string} html - Raw page HTML string
 * @returns {string} Extracted text or empty string if not found
 */
function extractStructuredArticleText(html) {
    if (!html || typeof html !== 'string') return '';

    // 1. JSON-LD Extraction (<script type="application/ld+json">)
    const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = jsonLdRegex.exec(html)) !== null) {
        try {
            const rawJson = match[1].trim();
            const data = JSON.parse(rawJson);
            const text = extractFromJsonLdObject(data);
            if (text.length >= MIN_STRUCTURED_LENGTH) {
                return text;
            }
        } catch (_err) {
            // malformed JSON-LD, continue to next tag
        }
    }

    // 2. Next.js __NEXT_DATA__ Hydration Script
    const nextRegex = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
    const nextMatch = html.match(nextRegex);
    if (nextMatch) {
        try {
            const data = JSON.parse(nextMatch[1]);
            const text = findNextArticleText(data);
            if (text.length >= MIN_STRUCTURED_LENGTH) {
                return text;
            }
        } catch (_err) {
            // continue
        }
    }

    // 3. OpenGraph & Twitter Description Fallback
    const ogRegex = /<meta[^>]+(?:property|name)=["'](?:og:description|twitter:description)["'][^>]+content=["']([^"']+)["']/i;
    const ogMatch = html.match(ogRegex);
    if (ogMatch && ogMatch[1]) {
        const text = decodeHtmlEntities(stripHtml(ogMatch[1]));
        if (text.length >= MIN_STRUCTURED_LENGTH) {
            return text;
        }
    }

    // Alternative meta attribute ordering: content before property/name
    const ogAltRegex = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:description|twitter:description)["']/i;
    const ogAltMatch = html.match(ogAltRegex);
    if (ogAltMatch && ogAltMatch[1]) {
        const text = decodeHtmlEntities(stripHtml(ogAltMatch[1]));
        if (text.length >= MIN_STRUCTURED_LENGTH) {
            return text;
        }
    }

    return '';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        extractStructuredArticleText,
        decodeHtmlEntities,
        stripHtml,
        MIN_STRUCTURED_LENGTH
    };
}
