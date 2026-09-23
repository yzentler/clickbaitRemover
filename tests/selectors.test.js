// tests/selectors.test.js
const { ARTICLE_SELECTORS, NOISE_SELECTORS } = require('../selectors');

describe('ARTICLE_SELECTORS', () => {
    test('is a non-empty array', () => {
        expect(Array.isArray(ARTICLE_SELECTORS)).toBe(true);
        expect(ARTICLE_SELECTORS.length).toBeGreaterThan(0);
    });

    test('all entries are non-empty strings', () => {
        for (const sel of ARTICLE_SELECTORS) {
            expect(typeof sel).toBe('string');
            expect(sel.trim().length).toBeGreaterThan(0);
        }
    });

    test('contains site-specific selectors for major English sites', () => {
        const joined = ARTICLE_SELECTORS.join(' ');
        // CNN
        expect(joined).toContain('.article__content');
        // BBC
        expect(joined).toContain('[data-component="text-block"]');
        // Fox News
        expect(joined).toContain('.article-body');
        // NYT
        expect(joined).toContain('section[name="articleBody"]');
        // Daily Mail
        expect(joined).toContain('[itemprop="articleBody"]');
        // Reuters
        expect(joined).toContain('.article-body__content');
        // AP News
        expect(joined).toContain('.RichTextStoryBody');
        // The Verge
        expect(joined).toContain('.duet--article--article-body-component');
    });

    test('contains Hebrew/Israeli site selectors', () => {
        const joined = ARTICLE_SELECTORS.join(' ');
        expect(joined).toContain('.single-post-content');  // Israel Hayom
        expect(joined).toContain('.art_body');              // Ynet
        expect(joined).toContain('.item-main-content');     // Walla
    });

    test('contains generic fallback selectors', () => {
        expect(ARTICLE_SELECTORS).toContain('.entry-content');
        expect(ARTICLE_SELECTORS).toContain('.post-content');
        expect(ARTICLE_SELECTORS).toContain('.story-body');
    });

    test('ends with semantic HTML fallbacks', () => {
        const last4 = ARTICLE_SELECTORS.slice(-4);
        expect(last4).toContain('article');
        expect(last4).toContain('main');
        expect(last4).toContain('[role="main"]');
    });

    test('has no adjacent duplicate entries', () => {
        for (let i = 1; i < ARTICLE_SELECTORS.length; i++) {
            expect(
                ARTICLE_SELECTORS[i] !== ARTICLE_SELECTORS[i - 1] ||
                `Adjacent duplicate: "${ARTICLE_SELECTORS[i]}" at index ${i}`
            ).not.toBe(false);
        }
    });

    test('contains clickbait-heavy site selectors', () => {
        const joined = ARTICLE_SELECTORS.join(' ');
        // ScreenRant
        expect(joined).toContain('.w-article');
        // Bored Panda
        expect(joined).toContain('.post-container');
        // The Sun
        expect(joined).toContain('div.article__content');
        // Mirror
        expect(joined).toContain('.reach-plc-article');
        // TMZ
        expect(joined).toContain('.post-content-inner');
        // Yahoo News
        expect(joined).toContain('div.caas-body');
        // MSN
        expect(joined).toContain('div.article-container');
        // People
        expect(joined).toContain('div.mntl-sc-page');
        // LADbible
        expect(joined).toContain('div[class*="article-body_body"]');
    });
});

describe('NOISE_SELECTORS', () => {
    test('is a non-empty string', () => {
        expect(typeof NOISE_SELECTORS).toBe('string');
        expect(NOISE_SELECTORS.length).toBeGreaterThan(0);
    });

    test('contains standard noise selectors', () => {
        expect(NOISE_SELECTORS).toContain('script');
        expect(NOISE_SELECTORS).toContain('style');
        expect(NOISE_SELECTORS).toContain('nav');
        expect(NOISE_SELECTORS).toContain('footer');
        expect(NOISE_SELECTORS).toContain('aside');
        expect(NOISE_SELECTORS).toContain('iframe');
    });

    test('contains ad selectors', () => {
        expect(NOISE_SELECTORS).toContain('.ad-container');
        expect(NOISE_SELECTORS).toContain('[id*="taboola"]');
        expect(NOISE_SELECTORS).toContain('[id*="outbrain"]');
    });

    test('contains social/share selectors', () => {
        expect(NOISE_SELECTORS).toContain('.social-share');
        expect(NOISE_SELECTORS).toContain('[class*="share"]');
    });

    test('contains comment selectors', () => {
        expect(NOISE_SELECTORS).toContain('[class*="comment"]');
        expect(NOISE_SELECTORS).toContain('#comments');
    });

    test('contains newsletter/signup selectors', () => {
        expect(NOISE_SELECTORS).toContain('[class*="newsletter"]');
        expect(NOISE_SELECTORS).toContain('[class*="subscribe"]');
    });

    test('is comma-separated (valid querySelectorAll format)', () => {
        const parts = NOISE_SELECTORS.split(',').map(s => s.trim());
        expect(parts.length).toBeGreaterThan(10);
        for (const part of parts) {
            expect(part.length).toBeGreaterThan(0);
        }
    });
});
