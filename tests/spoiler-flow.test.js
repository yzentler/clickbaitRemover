// tests/spoiler-flow.test.js — orchestration with all I/O modules mocked

jest.mock('../ui-bridge', () => ({
    upsertCard: jest.fn().mockResolvedValue(undefined),
    streamCard: jest.fn().mockResolvedValue(undefined),
    extractHeadlineFromLink: jest.fn(),
    extractCurrentPageText: jest.fn(),
    scanViewport: jest.fn(),
    injectBadges: jest.fn().mockResolvedValue(undefined),
    updateBadge: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../extraction', () => ({
    extractArticleText: jest.fn(),
    selectorsForUrl: jest.fn(() => ['article']),
}));
jest.mock('../llm-providers', () => ({
    callLLM: jest.fn(),
    callBatchLLM: jest.fn(),
}));
jest.mock('../cache', () => ({
    readCachedSpoiler: jest.fn().mockResolvedValue(null),
    writeCachedSpoiler: jest.fn().mockResolvedValue(undefined),
    FAILURE_SPOILER_FALLBACK: 'Could not reveal spoiler',
}));

const ui = require('../ui-bridge');
const { extractArticleText } = require('../extraction');
const { callLLM, callBatchLLM } = require('../llm-providers');
const cache = require('../cache');
const { getCards } = require('../card-state');
const { handleLinkClick, handlePageClick, handleRevealVisibleSpoilers } = require('../spoiler-flow');

const TAB = { id: 5, url: 'https://news.example.com/home', title: 'Home page' };
const ARTICLE = 'The council voted to close the main bridge for repairs from March through August, redirecting traffic to the southern ring road. '.repeat(3);
const SPOILER = '❓ When does the bridge close?\n💡 March through August';

const lastCard = () => ui.upsertCard.mock.calls.at(-1)[1];

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => { });
    jest.spyOn(console, 'error').mockImplementation(() => { });
    global.chrome = { storage: {} };   // card-state falls back to memory
    cache.readCachedSpoiler.mockResolvedValue(null);
    ui.extractHeadlineFromLink.mockResolvedValue('Bridge closing — you will not believe when');
    extractArticleText.mockResolvedValue(ARTICLE);
    callLLM.mockImplementation(async (_t, _h, onChunk) => { onChunk?.('x', SPOILER); return SPOILER; });
});
afterEach(() => jest.restoreAllMocks());

describe('handleLinkClick', () => {
    const URL_ = 'https://news.example.com/a/1';

    test('serves cache hits without extracting or calling the LLM', async () => {
        cache.readCachedSpoiler.mockResolvedValue({ headline: 'Cached headline', summary: SPOILER });

        await handleLinkClick(TAB, URL_);

        expect(extractArticleText).not.toHaveBeenCalled();
        expect(callLLM).not.toHaveBeenCalled();
        expect(lastCard()).toMatchObject({ status: 'done', text: SPOILER, headline: 'Cached headline', url: URL_ });
    });

    test('happy path: streams, finishes the card, caches, and persists state', async () => {
        await handleLinkClick(TAB, URL_);

        expect(ui.streamCard).toHaveBeenCalledWith(TAB.id, expect.stringMatching(/^cbr-card-/), SPOILER);
        const final = lastCard();
        expect(final).toMatchObject({ status: 'done', text: SPOILER, headline: 'Bridge closing — you will not believe when' });
        expect(final.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(cache.writeCachedSpoiler).toHaveBeenCalledWith(URL_, expect.any(String), SPOILER, expect.any(Number));
        expect((await getCards(TAB.id)).at(-1)).toMatchObject({ id: final.id, status: 'done' });
    });

    test('shows an error card when no article text can be extracted', async () => {
        extractArticleText.mockResolvedValue('');

        await handleLinkClick(TAB, URL_);

        expect(callLLM).not.toHaveBeenCalled();
        expect(lastCard()).toMatchObject({ status: 'error', text: 'Error: Could not extract article content' });
        expect(cache.writeCachedSpoiler).not.toHaveBeenCalled();
    });

    test('shows an error card when the LLM fails', async () => {
        callLLM.mockRejectedValue(new Error('Groq Error: 401 bad key'));

        await handleLinkClick(TAB, URL_);

        expect(lastCard()).toMatchObject({ status: 'error', text: 'Error: Groq Error: 401 bad key' });
    });

    test('card updates apply in order (the last upsert is the final state)', async () => {
        await handleLinkClick(TAB, URL_);
        const statuses = ui.upsertCard.mock.calls.map(c => c[1].status);
        expect(statuses.at(-1)).toBe('done');
        expect(statuses.indexOf('done')).toBe(statuses.length - 1);
    });
});

describe('handlePageClick', () => {
    test('summarizes a long selection without reading the page', async () => {
        const selection = 'x'.repeat(80);

        await handlePageClick(TAB, selection);

        expect(ui.extractCurrentPageText).not.toHaveBeenCalled();
        expect(callLLM).toHaveBeenCalledWith(selection, 'Home page', expect.any(Function));
        expect(cache.writeCachedSpoiler).not.toHaveBeenCalled();   // selections aren't cached
        expect(lastCard().status).toBe('done');
    });

    test('reads the live page when there is no usable selection, and caches by page URL', async () => {
        ui.extractCurrentPageText.mockResolvedValue(ARTICLE);

        await handlePageClick(TAB, 'short');

        expect(ui.extractCurrentPageText).toHaveBeenCalled();
        expect(cache.writeCachedSpoiler).toHaveBeenCalledWith(TAB.url, 'Home page', SPOILER, expect.any(Number));
    });

    test('reports pages with too little text', async () => {
        ui.extractCurrentPageText.mockResolvedValue('tiny');

        await handlePageClick(TAB, '');

        expect(lastCard()).toMatchObject({ status: 'error', text: expect.stringContaining('Could not extract enough text') });
    });
});

describe('handleRevealVisibleSpoilers', () => {
    const link = (n, extra = {}) => ({
        id: `cbr-vp-${n}`,
        url: `https://news.example.com/a/${n}`,
        text: `A sufficiently long headline number ${n}`,
        score: 100 - n, width: 400, containerWidth: 500,
        ...extra,
    });

    test('ignores non-http tabs', async () => {
        await handleRevealVisibleSpoilers({ id: 1, url: 'chrome://extensions' });
        expect(ui.scanViewport).not.toHaveBeenCalled();
    });

    test('does nothing when no links are visible', async () => {
        ui.scanViewport.mockResolvedValue([]);
        await handleRevealVisibleSpoilers(TAB);
        expect(ui.injectBadges).not.toHaveBeenCalled();
    });

    test('filters off-site links, serves cache, and answers the rest in one batch', async () => {
        ui.scanViewport.mockResolvedValue([
            link(1), link(2), link(3),
            link(9, { url: 'https://other-site.example.org/x' }),
        ]);
        cache.readCachedSpoiler.mockImplementation(async (url) =>
            url.endsWith('/1') ? { summary: 'cached answer' } : null);
        callBatchLLM.mockResolvedValue(['answer 2', 'answer 3']);

        await handleRevealVisibleSpoilers(TAB);

        expect(ui.injectBadges.mock.calls[0][1].map(i => i.cbrId)).toEqual(['cbr-vp-1', 'cbr-vp-2', 'cbr-vp-3']);
        expect(ui.updateBadge).toHaveBeenCalledWith(TAB.id, 'cbr-vp-1', 'cached answer');
        expect(callBatchLLM).toHaveBeenCalledTimes(1);
        expect(callBatchLLM.mock.calls[0][0]).toHaveLength(2);
        expect(ui.updateBadge).toHaveBeenCalledWith(TAB.id, 'cbr-vp-2', 'answer 2');
        expect(ui.updateBadge).toHaveBeenCalledWith(TAB.id, 'cbr-vp-3', 'answer 3');
        expect(cache.writeCachedSpoiler).toHaveBeenCalledTimes(2);
    });

    test('marks articles that cannot be extracted as errors and batches the rest', async () => {
        ui.scanViewport.mockResolvedValue([link(1), link(2)]);
        extractArticleText.mockImplementation(async (_tab, url) => (url.endsWith('/1') ? '' : ARTICLE));
        callBatchLLM.mockResolvedValue(['answer 2']);

        await handleRevealVisibleSpoilers(TAB);

        expect(ui.updateBadge).toHaveBeenCalledWith(TAB.id, 'cbr-vp-1', 'Could not extract article content', true);
        expect(ui.updateBadge).toHaveBeenCalledWith(TAB.id, 'cbr-vp-2', 'answer 2');
    });

    test('falls back to single calls when the batch call fails', async () => {
        ui.scanViewport.mockResolvedValue([link(1), link(2)]);
        callBatchLLM.mockRejectedValue(new Error('429'));
        callLLM.mockResolvedValueOnce('single 1').mockRejectedValueOnce(new Error('boom'));

        await handleRevealVisibleSpoilers(TAB);

        expect(ui.updateBadge).toHaveBeenCalledWith(TAB.id, 'cbr-vp-1', 'single 1');
        expect(ui.updateBadge).toHaveBeenCalledWith(TAB.id, 'cbr-vp-2', 'Error: boom', true);
    });

    test('an article that exceeds the deadline is aborted (so its hidden tab can close)', async () => {
        jest.useFakeTimers();
        try {
            ui.scanViewport.mockResolvedValue([link(1)]);
            let seenSignal;
            extractArticleText.mockImplementation((_tab, _url, { signal }) => {
                seenSignal = signal;
                return new Promise(() => { });   // never settles
            });

            const run = handleRevealVisibleSpoilers(TAB);
            await jest.advanceTimersByTimeAsync(9000);
            await run;

            expect(seenSignal.aborted).toBe(true);
            expect(ui.updateBadge).toHaveBeenCalledWith(TAB.id, 'cbr-vp-1', 'Article extraction timed out', true);
        } finally {
            jest.useRealTimers();
        }
    });
});
