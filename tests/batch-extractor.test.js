const {
    filterHeadlineCandidates,
    runWithConcurrency,
    normalizeArticleUrl,
} = require('../batch-extractor');

describe('normalizeArticleUrl', () => {
    test('removes tracking query parameters and fragments', () => {
        const raw = 'https://www.israelhayom.co.il/sport/article/12345?utm_source=push&utm_medium=site#comments';
        expect(normalizeArticleUrl(raw)).toBe('https://www.israelhayom.co.il/sport/article/12345');
    });

    test('returns null for non-http/https URLs', () => {
        expect(normalizeArticleUrl('javascript:void(0)')).toBeNull();
        expect(normalizeArticleUrl('mailto:editor@news.com')).toBeNull();
        expect(normalizeArticleUrl('#top')).toBeNull();
        expect(normalizeArticleUrl('')).toBeNull();
    });
});

describe('filterHeadlineCandidates', () => {
    const currentHost = 'www.israelhayom.co.il';

    test('filters out links with too short text', () => {
        const links = [
            { url: 'https://www.israelhayom.co.il/article/1', text: 'More' },
            { url: 'https://www.israelhayom.co.il/article/2', text: '12:30' },
            { url: 'https://www.israelhayom.co.il/article/3', text: 'דימיטריס איטודיס מונה למאמן הפועל תל אביב' },
        ];
        const result = filterHeadlineCandidates(links, currentHost);
        expect(result).toHaveLength(1);
        expect(result[0].headline).toBe('דימיטריס איטודיס מונה למאמן הפועל תל אביב');
    });

    test('filters out non-article URLs (tags, categories, privacy, author)', () => {
        const links = [
            { url: 'https://www.israelhayom.co.il/tag/basketball', text: 'כל הכתבות על כדורסל ישראלי ועולמי' },
            { url: 'https://www.israelhayom.co.il/category/news', text: 'מבזקי חדשות שוטפים לאורך כל היום' },
            { url: 'https://www.israelhayom.co.il/author/john-doe', text: 'הטור השבועי של הכתב הראשי לענייני ספורט' },
            { url: 'https://www.israelhayom.co.il/sport/article/21472432', text: 'המעמד החריג של דימיטריס איטודיס בהפועל תל אביב' },
        ];
        const result = filterHeadlineCandidates(links, currentHost);
        expect(result).toHaveLength(1);
        expect(result[0].url).toBe('https://www.israelhayom.co.il/sport/article/21472432');
    });

    test('filters out external host links when currentHost is provided', () => {
        const links = [
            { url: 'https://twitter.com/share?url=...', text: 'שתף את הכתבה הזו עכשיו ברשתות החברתיות' },
            { url: 'https://www.facebook.com/dialog/...', text: 'שתף בפייסבוק עם כל החברים שלך' },
            { url: 'https://www.israelhayom.co.il/sport/article/999', text: 'שחקן הרכש החדש נחת בישראל ויעבור בדיקות רפואיות' },
        ];
        const result = filterHeadlineCandidates(links, currentHost);
        expect(result).toHaveLength(1);
        expect(result[0].url).toBe('https://www.israelhayom.co.il/sport/article/999');
    });

    test('deduplicates links pointing to the same article with different query params', () => {
        const links = [
            { url: 'https://www.israelhayom.co.il/sport/article/100?utm_source=a', text: 'כותרת ראשית שמופיעה בראש העמוד' },
            { url: 'https://www.israelhayom.co.il/sport/article/100?utm_source=b', text: 'כותרת זהה שמופיעה בתמונה ובטקסט' },
            { url: 'https://www.israelhayom.co.il/sport/article/200', text: 'כותרת שונה לחלוטין של כתבה אחרת לגמרי' },
        ];
        const result = filterHeadlineCandidates(links, currentHost);
        expect(result).toHaveLength(2);
        expect(result[0].url).toBe('https://www.israelhayom.co.il/sport/article/100');
        expect(result[1].url).toBe('https://www.israelhayom.co.il/sport/article/200');
    });

    test('limits candidate count to maxCount (default 6)', () => {
        const links = [];
        for (let i = 1; i <= 15; i++) {
            links.push({
                url: `https://www.israelhayom.co.il/article/${i}`,
                text: `כותרת כתבה מפורטת ומעניינת מספר ${i} לחשיפה`,
            });
        }
        const result = filterHeadlineCandidates(links, currentHost, 6);
        expect(result).toHaveLength(6);
    });

    test('cleans whitespace, newlines, and trims headline text', () => {
        const links = [
            {
                url: 'https://www.israelhayom.co.il/article/55',
                text: '   \n  כותרת עם רווחים \t מיותרים ומעברי שורה   \n',
            },
        ];
        const result = filterHeadlineCandidates(links, currentHost);
        expect(result[0].headline).toBe('כותרת עם רווחים מיותרים ומעברי שורה');
    });
});

describe('runWithConcurrency', () => {
    test('executes all tasks and resolves results in order', async () => {
        const tasks = [
            async () => { await new Promise(r => setTimeout(r, 20)); return 1; },
            async () => { await new Promise(r => setTimeout(r, 10)); return 2; },
            async () => { await new Promise(r => setTimeout(r, 15)); return 3; },
            async () => { await new Promise(r => setTimeout(r, 5)); return 4; },
        ];

        const results = await runWithConcurrency(tasks, 2);
        expect(results).toEqual([
            { status: 'fulfilled', value: 1 },
            { status: 'fulfilled', value: 2 },
            { status: 'fulfilled', value: 3 },
            { status: 'fulfilled', value: 4 },
        ]);
    });

    test('never exceeds concurrency limit', async () => {
        let activeCount = 0;
        let maxActiveObserved = 0;
        const limit = 2;

        const tasks = [1, 2, 3, 4, 5].map((val) => async () => {
            activeCount++;
            if (activeCount > maxActiveObserved) maxActiveObserved = activeCount;
            await new Promise(r => setTimeout(r, 25));
            activeCount--;
            return val;
        });

        await runWithConcurrency(tasks, limit);
        expect(maxActiveObserved).toBeLessThanOrEqual(limit);
    });

    test('handles rejected tasks gracefully without stopping others', async () => {
        const tasks = [
            async () => 1,
            async () => { throw new Error('Task 2 failed'); },
            async () => 3,
        ];

        const results = await runWithConcurrency(tasks, 2);
        expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
        expect(results[1].status).toBe('rejected');
        expect(results[1].reason.message).toBe('Task 2 failed');
        expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    });

    test('returns empty array when tasks array is empty', async () => {
        const results = await runWithConcurrency([], 3);
        expect(results).toEqual([]);
    });
});
