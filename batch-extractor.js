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
function filterHeadlineCandidates(links, currentHost, maxCount = 6) {
    if (!Array.isArray(links)) return [];

    const seenUrls = new Set();
    const candidates = [];

    const cleanCurrentHost = currentHost ? currentHost.toLowerCase().replace(/^www\./, '') : '';

    for (const link of links) {
        if (!link || !link.url || !link.text) continue;

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

        // 4. If currentHost is provided, enforce same host/domain
        if (cleanCurrentHost && linkHost !== cleanCurrentHost && !linkHost.endsWith('.' + cleanCurrentHost)) {
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

        candidates.push({
            url: normalizedUrl,
            headline: cleanHeadline,
        });

        if (candidates.length >= maxCount) {
            break;
        }
    }

    return candidates;
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        normalizeArticleUrl,
        filterHeadlineCandidates,
        runWithConcurrency,
        TRACKING_PARAMS,
    };
}
