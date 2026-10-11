// tests/cache.test.js
const {
    cacheKeyFor, isCacheableSpoiler, readCachedSpoiler, writeCachedSpoiler,
    pruneCache, providerFingerprint, FAILURE_SPOILER_FALLBACK,
} = require('../cache');
const { CACHE_TTL_MS, CACHE_MAX_ENTRIES, CACHE_KEY_PREFIX } = require('../config');

let data;
beforeEach(() => {
    data = { provider: 'groq', groqModel: 'llama-3.1-8b-instant' };
    global.chrome = {
        storage: {
            local: {
                get: jest.fn(async (keys) => {
                    if (keys === null) return { ...data };
                    const list = Array.isArray(keys) ? keys : [keys];
                    return Object.fromEntries(list.filter(k => k in data).map(k => [k, data[k]]));
                }),
                set: jest.fn(async (obj) => { Object.assign(data, obj); }),
                remove: jest.fn(async (keys) => { for (const k of [].concat(keys)) delete data[k]; }),
            },
        },
    };
});

describe('keys', () => {
    test('normalizes tracking params and hash', () => {
        expect(cacheKeyFor('https://a.com/x?utm_source=z#top', 'f')).toBe(cacheKeyFor('https://a.com/x', 'f'));
    });

    test('differs by provider/model fingerprint', async () => {
        expect(cacheKeyFor('https://a.com/x', 'groq:a')).not.toBe(cacheKeyFor('https://a.com/x', 'groq:b'));
        expect(await providerFingerprint()).toBe('groq:llama-3.1-8b-instant');
        data.provider = 'chrome-ai';
        expect(await providerFingerprint()).toBe('chrome-ai:');
    });
});

describe('isCacheableSpoiler', () => {
    test.each([
        ['', false],
        [null, false],
        [FAILURE_SPOILER_FALLBACK, false],
        ['❓ Q?\n💡 ❌ Could not find the answer in the article text.', false],
        ['❓ Q?\n💡 A.', true],
    ])('%j → %s', (summary, expected) => {
        expect(isCacheableSpoiler(summary)).toBe(expected);
    });
});

describe('read / write', () => {
    test('round-trips an answer', async () => {
        await writeCachedSpoiler('https://a.com/x', 'H', '❓ Q?\n💡 A.', 1234);
        const hit = await readCachedSpoiler('https://a.com/x?utm_campaign=1');
        expect(hit).toMatchObject({ headline: 'H', summary: '❓ Q?\n💡 A.', elapsedMs: 1234 });
    });

    test('does not write failures', async () => {
        await writeCachedSpoiler('https://a.com/x', 'H', FAILURE_SPOILER_FALLBACK);
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    test('a different model does not see the old answer', async () => {
        await writeCachedSpoiler('https://a.com/x', 'H', '💡 A');
        data.groqModel = 'llama-3.3-70b-versatile';
        expect(await readCachedSpoiler('https://a.com/x')).toBeNull();
    });

    test('expired entries are ignored', async () => {
        await writeCachedSpoiler('https://a.com/x', 'H', '💡 A');
        const key = Object.keys(data).find(k => k.startsWith(CACHE_KEY_PREFIX));
        data[key].cachedAt = Date.now() - CACHE_TTL_MS - 1000;
        expect(await readCachedSpoiler('https://a.com/x')).toBeNull();
    });

    test('storage errors read as a miss', async () => {
        chrome.storage.local.get.mockRejectedValue(new Error('boom'));
        expect(await readCachedSpoiler('https://a.com/x')).toBeNull();
    });
});

describe('pruneCache', () => {
    test('removes expired and legacy entries, keeps fresh ones and non-cache keys', async () => {
        const now = Date.now();
        data[`${CACHE_KEY_PREFIX}fresh`] = { summary: 's', cachedAt: now };
        data[`${CACHE_KEY_PREFIX}expired`] = { summary: 's', cachedAt: now - CACHE_TTL_MS - 1 };
        data[`${CACHE_KEY_PREFIX}https://legacy.example/`] = { summary: 's' };

        const removed = await pruneCache();

        expect(removed).toBe(2);
        expect(Object.keys(data)).toEqual(expect.arrayContaining([`${CACHE_KEY_PREFIX}fresh`, 'provider', 'groqModel']));
        expect(data[`${CACHE_KEY_PREFIX}expired`]).toBeUndefined();
    });

    test('evicts the oldest beyond the cap', async () => {
        const now = Date.now();
        for (let i = 0; i < CACHE_MAX_ENTRIES + 5; i++) {
            data[`${CACHE_KEY_PREFIX}k${i}`] = { summary: 's', cachedAt: now - (CACHE_MAX_ENTRIES + 5 - i) };
        }
        expect(await pruneCache()).toBe(5);
        expect(data[`${CACHE_KEY_PREFIX}k0`]).toBeUndefined();
        expect(data[`${CACHE_KEY_PREFIX}k${CACHE_MAX_ENTRIES + 4}`]).toBeDefined();
    });
});
