// batch-extractor.js — Candidate filtering & concurrency control for viewport spoilers

const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', 'ref', 'source',
]);

const NON_ARTICLE_PATH_RE = /\/(?:tag|tags|category|categories|section|topics?|author|writers?|privacy|terms|about|contact|accessibility|login|register|newsletter|sitemap)(?:\/|$)/i;

const SOCIAL_HOSTS = new Set([
    'twitter.com', 'x.com', 'facebook.com', 'wa.me', 'api.whatsapp.com',
    'linkedin.com', 'instagram.com', 'tiktok.com', 't.me', 'telegram.me',
    'reddit.com', 'pinterest.com',
]);

const SISTER_DOMAIN_SETS = [
    new Set(['n12.co.il', 'mako.co.il']),
    new Set(['haaretz.co.il', 'themarker.com']),
];

/**
 * Check if linkHost is permitted for currentHost (same domain, subdomain, reverse subdomain, or sister domain).
 * @param {string} linkHost
 * @param {string} currentHost
 * @returns {boolean}
 */
function isAllowedArticleHost(linkHost, currentHost) {
    if (!currentHost || !linkHost) return true;

    const cleanCurrent = currentHost.toLowerCase().replace(/^www\./, '');
    const cleanLink = linkHost.toLowerCase().replace(/^www\./, '');

    // 1. Direct match or subdomain
    if (cleanLink === cleanCurrent || cleanLink.endsWith('.' + cleanCurrent)) {
        return true;
    }

    // 2. Reverse subdomain (e.g. current is sports.walla.co.il, link is walla.co.il)
    if (cleanCurrent.endsWith('.' + cleanLink)) {
        return true;
    }

    // 3. Known sister domains (e.g. n12.co.il <-> mako.co.il)
    for (const group of SISTER_DOMAIN_SETS) {
        let currentMatches = false;
        let linkMatches = false;

        for (const domain of group) {
            if (cleanCurrent === domain || cleanCurrent.endsWith('.' + domain)) {
                currentMatches = true;
            }
            if (cleanLink === domain || cleanLink.endsWith('.' + domain)) {
                linkMatches = true;
            }
        }

        if (currentMatches && linkMatches) {
            return true;
        }
    }

    return false;
}

/**
 * Normalize an article URL by removing tracking query parameters and hash fragments.
 * @param {string} rawUrl
 * @returns {string|null} Normalized URL, or null if invalid / non-http
 */
function normalizeArticleUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;

    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }

        // Strip hash fragment
        parsed.hash = '';

        // Strip known tracking params
        const params = new URLSearchParams(parsed.search);
        for (const key of Array.from(params.keys())) {
            if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
                params.delete(key);
            }
        }
        parsed.search = params.toString() ? `?${params.toString()}` : '';

        return parsed.toString();
    } catch (_err) {
        return null;
    }
}

/**
 * Filter an array of raw DOM link objects down to high-confidence article headline candidates.
 * @param {Array<{ url: string, text: string }>} links
 * @param {string} [currentHost]
 * @param {number} [maxCount=6]
 * @returns {Array<{ url: string, headline: string }>}
 */
function filterHeadlineCandidates(links, currentHost, maxCount = 12) {
    if (!Array.isArray(links)) return [];

    const seenUrls = new Set();
    const cleanCurrentHost = currentHost ? currentHost.toLowerCase().replace(/^www\./, '') : '';
    const validCandidates = [];

    for (const link of links) {
        if (!link || !link.url || !link.text) continue;

        // Reject links explicitly flagged as sidebar, gutter, or too narrow
        if (link.isSidebar || link.isGutter) continue;
        if (typeof link.width === 'number' && link.width < 100) continue;
        if (typeof link.containerWidth === 'number' && link.containerWidth < 120) continue;

        // 1. Clean headline text
        const cleanHeadline = link.text.replace(/[\s\r\n\t]+/g, ' ').trim();
        if (cleanHeadline.length < 15 || cleanHeadline.length > 300) {
            continue;
        }

        // 2. Normalize URL
        const normalizedUrl = normalizeArticleUrl(link.url);
        if (!normalizedUrl) continue;

        let parsed;
        try {
            parsed = new URL(normalizedUrl);
        } catch (_err) {
            continue;
        }

        const linkHost = parsed.hostname.toLowerCase().replace(/^www\./, '');

        // 3. Reject social share links
        if (SOCIAL_HOSTS.has(linkHost)) {
            continue;
        }

        // 4. Enforce same host / subdomain / sister domain (e.g. n12.co.il -> mako.co.il)
        if (!isAllowedArticleHost(linkHost, cleanCurrentHost)) {
            continue;
        }

        // 5. Reject category/tag/author index paths
        if (NON_ARTICLE_PATH_RE.test(parsed.pathname)) {
            continue;
        }

        // 6. Deduplicate by normalized URL
        if (seenUrls.has(normalizedUrl)) {
            continue;
        }
        seenUrls.add(normalizedUrl);

        validCandidates.push({
            url: normalizedUrl,
            headline: cleanHeadline,
            score: typeof link.score === 'number' ? link.score : 0,
            id: link.id,
        });
    }

    // Sort by prominence score descending (higher heading level, larger text, larger area first)
    validCandidates.sort((a, b) => b.score - a.score);

    return validCandidates.slice(0, maxCount).map(c => ({
        url: c.url,
        headline: c.headline,
        id: c.id,
    }));
}

/**
 * Execute an array of async tasks with a maximum concurrency limit.
 * Preserves result order and behaves similarly to Promise.allSettled.
 * @param {Array<() => Promise<any>>} tasks
 * @param {number} [limit=3]
 * @returns {Promise<Array<{ status: 'fulfilled', value: any } | { status: 'rejected', reason: any }>>}
 */
async function runWithConcurrency(tasks, limit = 3) {
    if (!Array.isArray(tasks) || tasks.length === 0) return [];

    const results = new Array(tasks.length);
    let nextIndex = 0;

    const worker = async () => {
        while (nextIndex < tasks.length) {
            const index = nextIndex++;
            const task = tasks[index];
            try {
                const value = await task();
                results[index] = { status: 'fulfilled', value };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    };

    const workerCount = Math.min(limit, tasks.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    return results;
}

/**
 * Splits an array into chunks of specified size.
 * @param {Array<any>} items
 * @param {number} [size=3]
 * @returns {Array<Array<any>>}
 */
function chunkItems(items, size = 3) {
    if (!Array.isArray(items) || items.length === 0) return [];
    if (size <= 0) return [items];
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

const BATCH_SYSTEM_PROMPT = `You are a spoiler tool that reveals what clickbait headlines hide.
You are given multiple articles. For EACH article, identify what the headline makes the reader curious about and provide the specific direct spoiler fact from that article's text.
You MUST write the question and answer in the EXACT SAME language as that article.

Format your response strictly using numbered delimiters:
--- 1 ---
❓ [question for article 1]
💡 [answer for article 1, max 15 words]

--- 2 ---
❓ [question for article 2]
💡 [answer for article 2, max 15 words]

CRITICAL RULES:
1. For each article, output ONLY the delimiter line followed by the two lines starting with ❓ and 💡.
2. Absolutely NO introductory text, NO preamble, and NO concluding notes.
3. If an article text does not contain the answer, output:
   ❓ [question]
   💡 ❌ Could not find the answer in the article text.`;

/**
 * Builds a multi-article prompt combining up to N articles into a single LLM call.
 * @param {Array<{ headline: string, text: string }>} items
 * @returns {string}
 */
function buildMultiArticlePrompt(items) {
    if (!Array.isArray(items) || items.length === 0) return '';
    let prompt = BATCH_SYSTEM_PROMPT + '\n\nARTICLES TO ANALYZE:\n';
    items.forEach((item, index) => {
        const num = index + 1;
        prompt += `\n--- ARTICLE ${num} ---\n`;
        prompt += `HEADLINE: ${item.headline || '(none)'}\n`;
        prompt += `ARTICLE TEXT:\n${item.text || ''}\n`;
    });
    prompt += '\n---\nRespond with the spoilers for each article starting with "--- 1 ---":';
    return prompt;
}

/**
 * Parses a batched LLM response into an array of spoiler strings matching expectedCount.
 * @param {string} responseText
 * @param {number} [expectedCount=1]
 * @returns {Array<string>} Array of spoiler text strings
 */
function parseMultiArticleResponse(responseText, expectedCount = 1) {
    if (!responseText || typeof responseText !== 'string') {
        return new Array(expectedCount).fill('');
    }

    if (expectedCount <= 1) {
        return [responseText.trim()];
    }

    const results = new Array(expectedCount).fill('');

    // Strategy 1: Match section delimiters like "--- 1 ---", "--- ARTICLE 1 ---", "[1]", "ARTICLE 1:"
    const sectionRegex = /(?:^|\n)\s*(?:---+\s*(?:ARTICLE\s*)?(\d+)\s*---+|\[(\d+)\]|ARTICLE\s*(\d+):?)/gi;
    const matches = [];
    let match;
    while ((match = sectionRegex.exec(responseText)) !== null) {
        const indexStr = match[1] || match[2] || match[3];
        const num = parseInt(indexStr, 10);
        matches.push({ num, index: match.index, length: match[0].length });
    }

    if (matches.length > 0) {
        for (let i = 0; i < matches.length; i++) {
            const current = matches[i];
            const start = current.index + current.length;
            const end = (i + 1 < matches.length) ? matches[i + 1].index : responseText.length;
            const block = responseText.substring(start, end).trim();

            const targetIdx = current.num - 1;
            if (targetIdx >= 0 && targetIdx < expectedCount) {
                results[targetIdx] = block;
            } else if (i < expectedCount && !results[i]) {
                results[i] = block;
            }
        }
    }

    // Strategy 2: If sections weren't found or some are unfilled, fallback to matching pairs of ❓ and 💡
    const unfilledCount = results.filter(r => !r || !r.includes('💡')).length;
    if (unfilledCount > 0) {
        const qMatches = Array.from(responseText.matchAll(/(❓[\s\S]*?💡[^\n]+)/g));
        if (qMatches.length >= expectedCount) {
            for (let i = 0; i < expectedCount; i++) {
                if (!results[i] || !results[i].includes('💡')) {
                    results[i] = qMatches[i][1].trim();
                }
            }
        }
    }

    return results;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        normalizeArticleUrl,
        filterHeadlineCandidates,
        runWithConcurrency,
        TRACKING_PARAMS,
        chunkItems,
        buildMultiArticlePrompt,
        parseMultiArticleResponse,
        isAllowedArticleHost,
        SISTER_DOMAIN_SETS,
    };
}
