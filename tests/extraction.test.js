// tests/extraction.test.js
const {
    extractArticleText, tryFastFetch, extractViaBackgroundTab,
    looksLikeClientRendered, selectorsForUrl,
} = require('../extraction');
const { ARTICLE_SELECTORS } = require('../selectors');

const BODY = 'The committee announced that the new stadium will open in March after two years of construction delays and a budget overrun of twelve million. '.repeat(3);
const TEASER = 'You will never guess what the committee announced about the stadium opening date this week and why it matters.';

const jsonLdPage = (body) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script></head><body></body></html>`;
const ogPage = `<html><head><meta property="og:description" content="${TEASER}"></head><body><p>x</p></body></html>`;

let executeScript;
let tabsRemoved;

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => { });
    tabsRemoved = [];
    executeScript = jest.fn(async (opts) => (opts.files ? [] : [{ result: '' }]));
    const listeners = new Set();
    global.chrome = {
        scripting: { executeScript },
        tabs: {
            create: jest.fn(async () => ({ id: 77 })),
            remove: jest.fn(async (id) => { tabsRemoved.push(id); }),
            onUpdated: {
                addListener: jest.fn((fn) => { listeners.add(fn); queueMicrotask(() => fn(77, { status: 'complete' })); }),
                removeListener: jest.fn((fn) => listeners.delete(fn)),
            },
        },
    };
});
afterEach(() => jest.restoreAllMocks());

const respond = (html, init = {}) => jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => html, ...init });

describe('helpers', () => {
    test('looksLikeClientRendered: shell pages vs real articles', () => {
        const shell = '<script></script>'.repeat(10) + '<p>hi</p>';
        expect(looksLikeClientRendered(shell, 'short')).toBe(true);
        expect(looksLikeClientRendered(shell, 'x'.repeat(300))).toBe(false);
        expect(looksLikeClientRendered('<p>a</p><p>b</p><p>c</p><p>d</p><p>e</p><p>f</p>', 'short')).toBe(false);
        expect(looksLikeClientRendered('<p>a</p>', 'window.__APP boot')).toBe(true);
    });

    test('selectorsForUrl is host-aware and tolerates bad URLs', () => {
        expect(selectorsForUrl('https://www.ynet.co.il/news/article/x')[0]).toBe('.art_body');
        expect(selectorsForUrl('https://example.com/a')).toBe(ARTICLE_SELECTORS);
        expect(selectorsForUrl('not a url')).toBe(ARTICLE_SELECTORS);
    });
});

describe('tryFastFetch', () => {
    test('skips non-2xx responses', async () => {
        global.fetch = respond('<html>Not found page with plenty of text</html>', { ok: false, status: 404 });
        expect(await tryFastFetch(1, 'https://a.com/x', [])).toEqual({ text: '', teaser: '' });
        expect(executeScript).not.toHaveBeenCalled();
    });

    test('skips bot-challenge pages', async () => {
        global.fetch = respond('<html><head><title>Just a moment...</title></head></html>');
        expect(await tryFastFetch(1, 'https://a.com/x', [])).toEqual({ text: '', teaser: '' });
    });

    test('uses structured articleBody without touching the page', async () => {
        global.fetch = respond(jsonLdPage(BODY));
        const { text } = await tryFastFetch(1, 'https://a.com/x', []);
        expect(text).toContain('new stadium will open');
        expect(executeScript).not.toHaveBeenCalled();
    });

    test('prefers DOM body over the og:description teaser', async () => {
        global.fetch = respond(ogPage);
        executeScript.mockResolvedValue([{ result: BODY }]);

        const { text, teaser } = await tryFastFetch(1, 'https://a.com/x', ['article']);

        expect(text).toBe(BODY);
        expect(teaser).toContain('You will never guess');
    });

    test('flags client-rendered shells but still reports the teaser', async () => {
        global.fetch = respond(`<html><head><meta property="og:description" content="${TEASER}"></head>${'<script></script>'.repeat(10)}</html>`);
        executeScript.mockResolvedValue([{ result: 'tiny' }]);

        expect(await tryFastFetch(1, 'https://a.com/x', [])).toEqual({ text: '', teaser: expect.stringContaining('You will never guess') });
    });

    test('network errors are swallowed', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
        expect(await tryFastFetch(1, 'https://a.com/x', [])).toEqual({ text: '', teaser: '' });
    });
});

describe('extractViaBackgroundTab', () => {
    test('reads text from the hidden tab, then closes it', async () => {
        executeScript.mockImplementation(async (opts) => (opts.files ? [] : [{ result: BODY }]));
        const status = jest.fn();

        const text = await extractViaBackgroundTab('https://a.com/x', ['article'], { onStatus: status });

        expect(text).toBe(BODY);
        expect(status).toHaveBeenCalledWith('Loading article page…');
        expect(tabsRemoved).toEqual([77]);
    });

    test('regression: a page that takes >1.5s to load is still polled', async () => {
        jest.useFakeTimers();
        try {
            // Load completes after 2s — longer than the 1.5s poll window
            chrome.tabs.onUpdated.addListener.mockImplementation((fn) => { setTimeout(() => fn(77, { status: 'complete' }), 2000); });
            executeScript.mockImplementation(async (opts) => (opts.files ? [] : [{ result: BODY }]));

            const pending = extractViaBackgroundTab('https://a.com/x', ['article']);
            await jest.advanceTimersByTimeAsync(2500);

            expect(await pending).toBe(BODY);
        } finally {
            jest.useRealTimers();
        }
    });

    test('closes the tab and stops polling when aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const text = await extractViaBackgroundTab('https://a.com/x', [], { signal: controller.signal });

        expect(text).toBe('');
        expect(tabsRemoved).toEqual([77]);
        expect(executeScript).not.toHaveBeenCalled();
    });
});

describe('extractArticleText', () => {
    test('returns fast-path text without opening a tab', async () => {
        global.fetch = respond(jsonLdPage(BODY));
        expect(await extractArticleText(1, 'https://a.com/x')).toContain('new stadium');
        expect(chrome.tabs.create).not.toHaveBeenCalled();
    });

    test('falls back to a hidden tab when the fast path yields nothing', async () => {
        global.fetch = respond('<html></html>', { ok: false, status: 403 });
        executeScript.mockImplementation(async (opts) => (opts.files ? [] : [{ result: BODY }]));

        expect(await extractArticleText(1, 'https://a.com/x')).toBe(BODY);
        expect(chrome.tabs.create).toHaveBeenCalled();
    });

    test('uses the teaser only as a last resort', async () => {
        global.fetch = respond(`<html><head><meta property="og:description" content="${TEASER}"></head>${'<script></script>'.repeat(10)}</html>`);
        executeScript.mockImplementation(async (opts) => (opts.files ? [] : [{ result: '' }]));

        expect(await extractArticleText(1, 'https://a.com/x')).toContain('You will never guess');
    });

    test('returns empty when everything fails', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
        executeScript.mockImplementation(async (opts) => (opts.files ? [] : [{ result: '' }]));

        expect(await extractArticleText(1, 'https://a.com/x')).toBe('');
    });

    test('an aborted signal skips the tab fallback', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
        const controller = new AbortController();
        controller.abort();

        expect(await extractArticleText(1, 'https://a.com/x', { signal: controller.signal })).toBe('');
        expect(chrome.tabs.create).not.toHaveBeenCalled();
    });
});
