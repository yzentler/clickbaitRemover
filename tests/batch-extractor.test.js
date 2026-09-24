const {
    filterHeadlineCandidates,
    runWithConcurrency,
    normalizeArticleUrl,
    chunkItems,
    buildMultiArticlePrompt,
    parseMultiArticleResponse,
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

    test('allows sister domain links like mako.co.il when browsing n12.co.il', () => {
        const links = [
            { url: 'https://www.mako.co.il/news-military/Article-12345.htm', text: 'כותרת כתבה על מבצע צבאי בצפון הארץ' },
            { url: 'https://www.external-ad.co.il/campaign', text: 'פרסומת חיצונית שאסור להכניס לרשימת הכתבות' },
        ];
        const result = filterHeadlineCandidates(links, 'n12.co.il');
        expect(result).toHaveLength(1);
        expect(result[0].url).toBe('https://www.mako.co.il/news-military/Article-12345.htm');
    });

    test('allows root domain links when browsing a subdomain', () => {
        const links = [
            { url: 'https://www.walla.co.il/item/99999', text: 'כותרת מאתר וואלה הראשי מתוך עמוד הספורט' },
        ];
        const result = filterHeadlineCandidates(links, 'sports.walla.co.il');
        expect(result).toHaveLength(1);
        expect(result[0].url).toBe('https://www.walla.co.il/item/99999');
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

    test('sorts candidates by prominence score descending so main headlines are picked first', () => {
        const links = [
            { url: 'https://www.israelhayom.co.il/article/ticker1', text: 'כותרת מבזק קטנה שמופיעה בראש העמוד', score: 10 },
            { url: 'https://www.israelhayom.co.il/article/main1', text: 'כותרת ראשית ענקית על איטודיס בהפועל תל אביב', score: 100 },
            { url: 'https://www.israelhayom.co.il/article/sub1', text: 'כותרת משנה בולטת בעמוד הראשי של הספורט', score: 60 },
        ];
        const result = filterHeadlineCandidates(links, currentHost, 2);
        expect(result).toHaveLength(2);
        expect(result[0].headline).toBe('כותרת ראשית ענקית על איטודיס בהפועל תל אביב');
        expect(result[1].headline).toBe('כותרת משנה בולטת בעמוד הראשי של הספורט');
    });

    test('filters out links flagged as sidebar, gutter, or too narrow', () => {
        const links = [
            { url: 'https://www.israelhayom.co.il/article/side', text: 'כותרת בסרגל צדדי צר מאוד שלא מתאימה', isSidebar: true },
            { url: 'https://www.israelhayom.co.il/article/narrow', text: 'כותרת שרוחבה פחות מ-100 פיקסלים', width: 45 },
            { url: 'https://www.israelhayom.co.il/article/valid', text: 'כותרת רחבה תקינה במרכז עמוד החדשות', width: 350 },
        ];
        const result = filterHeadlineCandidates(links, currentHost);
        expect(result).toHaveLength(1);
        expect(result[0].url).toBe('https://www.israelhayom.co.il/article/valid');
    });

    test('preserves candidate element id if provided', () => {
        const links = [
            { url: 'https://www.israelhayom.co.il/article/1', text: 'כותרת ראשית שכוללת מזהה אלמנט', id: 'cbr-vp-123' },
        ];
        const result = filterHeadlineCandidates(links, currentHost);
        expect(result[0].id).toBe('cbr-vp-123');
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

describe('chunkItems', () => {
    test('chunks array into groups of specified size', () => {
        expect(chunkItems([1, 2, 3, 4, 5, 6, 7, 8], 3)).toEqual([
            [1, 2, 3],
            [4, 5, 6],
            [7, 8],
        ]);
    });

    test('returns empty array for empty input', () => {
        expect(chunkItems([], 3)).toEqual([]);
        expect(chunkItems(null, 3)).toEqual([]);
    });

    test('handles array smaller than chunk size', () => {
        expect(chunkItems([1, 2], 3)).toEqual([[1, 2]]);
    });
});

describe('buildMultiArticlePrompt', () => {
    test('builds delimited multi-article prompt for 3 articles', () => {
        const items = [
            { headline: 'כותרת ראשונה', text: 'טקסט כתבה ראשונה על כדורסל' },
            { headline: 'כותרת שנייה', text: 'טקסט כתבה שנייה על מזג אוויר' },
            { headline: 'Headline 3', text: 'This is the third article about technology.' },
        ];
        const prompt = buildMultiArticlePrompt(items);
        expect(prompt).toContain('--- ARTICLE 1 ---');
        expect(prompt).toContain('כותרת ראשונה');
        expect(prompt).toContain('--- ARTICLE 2 ---');
        expect(prompt).toContain('כותרת שנייה');
        expect(prompt).toContain('--- ARTICLE 3 ---');
        expect(prompt).toContain('Headline 3');
        expect(prompt).toContain('--- 1 ---');
    });
});

describe('parseMultiArticleResponse', () => {
    test('parses responses with standard "--- 1 ---" delimiters', () => {
        const response = `
--- 1 ---
❓ מה קרה בחופים?
💡 הרצליה והחוף הצפוני בבת ים

--- 2 ---
❓ מי הודיע על התפטרות?
💡 מאמן הפועל תל אביב

--- 3 ---
❓ איזה מוצר יחסוך כסף?
💡 נורות לד חכמות
        `;
        const parsed = parseMultiArticleResponse(response, 3);
        expect(parsed).toHaveLength(3);
        expect(parsed[0]).toContain('מה קרה בחופים?');
        expect(parsed[0]).toContain('הרצליה והחוף הצפוני בבת ים');
        expect(parsed[1]).toContain('מי הודיע על התפטרות?');
        expect(parsed[1]).toContain('מאמן הפועל תל אביב');
        expect(parsed[2]).toContain('איזה מוצר יחסוך כסף?');
        expect(parsed[2]).toContain('נורות לד חכמות');
    });

    test('parses responses with "[1]", "[2]" style delimiters', () => {
        const response = `
[1]
❓ What happened to the market?
💡 Tech stocks dropped 2% following earnings

[2]
❓ Who won the match?
💡 Barcelona won 3-1 against Napoli
        `;
        const parsed = parseMultiArticleResponse(response, 2);
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toContain('Tech stocks dropped 2%');
        expect(parsed[1]).toContain('Barcelona won 3-1');
    });

    test('falls back to pairing ❓ and 💡 when section headers are absent', () => {
        const response = `
❓ שאלה ראשונה?
💡 תשובה ראשונה

❓ שאלה שנייה?
💡 תשובה שנייה
        `;
        const parsed = parseMultiArticleResponse(response, 2);
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toContain('שאלה ראשונה?');
        expect(parsed[1]).toContain('שאלה שנייה?');
    });

    test('handles single expected item cleanly', () => {
        const response = '❓ שאלה בודדת? 💡 תשובה בודדת';
        const parsed = parseMultiArticleResponse(response, 1);
        expect(parsed).toHaveLength(1);
        expect(parsed[0]).toContain('תשובה בודדת');
    });
});

