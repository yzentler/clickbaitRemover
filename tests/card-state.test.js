// tests/card-state.test.js
const {
    saveCard, getCards, clearCards, newCardId, markInterruptedCards, reinjectOverlay,
} = require('../card-state');
const { STALE_LOADING_CARD_MS } = require('../config');

function installSessionStorage() {
    const data = new Map();
    global.chrome = {
        storage: {
            session: {
                get: jest.fn(async (key) => (data.has(key) ? { [key]: data.get(key) } : {})),
                set: jest.fn(async (obj) => { for (const [k, v] of Object.entries(obj)) data.set(k, JSON.parse(JSON.stringify(v))); }),
                remove: jest.fn(async (key) => { data.delete(key); }),
            },
        },
    };
    return data;
}

describe('Card State Management (storage.session)', () => {
    let store;
    beforeEach(() => {
        store = installSessionStorage();
    });

    test('creates a new card and returns the merged card', async () => {
        const card = await saveCard(1, 'card-1', { headline: 'Test', url: 'http://example.com', status: 'loading' });
        expect(card).toMatchObject({ id: 'card-1', headline: 'Test', status: 'loading' });
        expect(typeof card.updatedAt).toBe('number');
        expect(await getCards(1)).toHaveLength(1);
    });

    test('state is persisted in storage.session, not module memory', async () => {
        await saveCard(7, 'a', { status: 'done', text: 'x' });
        expect(store.get('cbr_cards_7')).toHaveLength(1);
    });

    test('merges updates into an existing card by id', async () => {
        await saveCard(1, 'card-1', { headline: 'Test', status: 'loading', text: 'Fetching...' });
        const merged = await saveCard(1, 'card-1', { status: 'done', text: 'Result' });
        expect(merged).toMatchObject({ headline: 'Test', status: 'done', text: 'Result' });
        expect(await getCards(1)).toHaveLength(1);
    });

    test('keeps tabs separate', async () => {
        await saveCard(1, 'a', { headline: 'A' });
        await saveCard(2, 'b', { headline: 'B' });
        expect((await getCards(1))[0].headline).toBe('A');
        expect((await getCards(2))[0].headline).toBe('B');
    });

    test('concurrent saves to one tab are not lost', async () => {
        await Promise.all(Array.from({ length: 20 }, (_, i) => saveCard(1, `c${i}`, { n: i })));
        expect(await getCards(1)).toHaveLength(20);
    });

    test('getCards returns null for an unknown tab', async () => {
        expect(await getCards(999)).toBeNull();
    });

    test('clearCards removes only that tab', async () => {
        await saveCard(1, 'a', {});
        await saveCard(2, 'b', {});
        await clearCards(1);
        expect(await getCards(1)).toBeNull();
        expect(await getCards(2)).toHaveLength(1);
        await expect(clearCards(12345)).resolves.toBeUndefined();
    });

    test('newCardId is unique and prefixed', () => {
        const ids = new Set(Array.from({ length: 100 }, newCardId));
        expect(ids.size).toBe(100);
        for (const id of ids) expect(id).toMatch(/^cbr-card-/);
    });
});

describe('falls back to memory when storage.session is unavailable', () => {
    test('still stores and clears', async () => {
        global.chrome = { storage: {} };
        await saveCard(5, 'm', { text: 'x' });
        expect(await getCards(5)).toHaveLength(1);
        await clearCards(5);
        expect(await getCards(5)).toBeNull();
    });
});

describe('markInterruptedCards', () => {
    const now = 1_000_000_000;

    test('turns long-stale loading cards into errors', () => {
        const cards = [
            { id: 'old', status: 'loading', updatedAt: now - STALE_LOADING_CARD_MS - 1 },
            { id: 'fresh', status: 'loading', updatedAt: now - 1000 },
            { id: 'done', status: 'done', updatedAt: 0 },
        ];
        const [old, fresh, done] = markInterruptedCards(cards, now);
        expect(old.status).toBe('error');
        expect(old.text).toMatch(/Interrupted/);
        expect(fresh.status).toBe('loading');
        expect(done.status).toBe('done');
    });
});

describe('reinjectOverlay', () => {
    beforeEach(() => {
        installSessionStorage();
        jest.useFakeTimers();
    });
    afterEach(() => jest.useRealTimers());

    test('restores saved cards after a short delay', async () => {
        await saveCard(1, 'a', { status: 'done', text: 'x' });
        const restore = jest.fn().mockResolvedValue(undefined);

        const pending = reinjectOverlay(1, restore);
        await jest.advanceTimersByTimeAsync(600);
        await pending;

        expect(restore).toHaveBeenCalledTimes(1);
        expect(restore.mock.calls[0][0]).toBe(1);
        expect(restore.mock.calls[0][1]).toHaveLength(1);
    });

    test('does nothing when the tab has no cards', async () => {
        const restore = jest.fn();
        await reinjectOverlay(42, restore);
        expect(restore).not.toHaveBeenCalled();
    });

    test('a second call while one is in flight is ignored', async () => {
        await saveCard(1, 'a', { status: 'done', text: 'x' });
        const restore = jest.fn().mockResolvedValue(undefined);

        const first = reinjectOverlay(1, restore);
        const second = reinjectOverlay(1, restore);
        await jest.advanceTimersByTimeAsync(600);
        await Promise.all([first, second]);

        expect(restore).toHaveBeenCalledTimes(1);
    });

    test('swallows restore failures (tab may be uninjectable)', async () => {
        await saveCard(1, 'a', { status: 'done', text: 'x' });
        const restore = jest.fn().mockRejectedValue(new Error('Cannot access chrome:// URL'));
        jest.spyOn(console, 'log').mockImplementation(() => { });

        const pending = reinjectOverlay(1, restore);
        await jest.advanceTimersByTimeAsync(600);
        await expect(pending).resolves.toBeUndefined();
    });
});
