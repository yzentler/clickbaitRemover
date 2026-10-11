/**
 * @jest-environment jsdom
 */
// tests/page-extract.test.js — extraction must never modify the user's live page

const { extractPageText } = require('../page-extract');

const LONG = 'This paragraph is the real article content and is long enough to pass the minimum length threshold easily. '.repeat(3);

beforeEach(() => {
    document.body.innerHTML = `
        <nav id="nav" style="color:red">Navigation links</nav>
        <div class="share-bar" id="share" style="display:flex !important">Share on socials</div>
        <article id="art"><p>${LONG}</p></article>
        <footer id="foot">Footer text</footer>`;
});

describe('extractPageText', () => {
    test('returns the first selector with enough text', () => {
        const text = extractPageText('nav, footer', ['.missing', 'article'], 150, 8000);
        expect(text).toContain('real article content');
    });

    test('falls back to body text when no selector matches', () => {
        const text = extractPageText('nav', ['.missing'], 150, 8000);
        expect(text).toContain('Footer text');
    });

    test('caps the returned length', () => {
        expect(extractPageText('nav', ['article'], 10, 50)).toHaveLength(50);
    });

    test('hides noise while reading', () => {
        const seen = [];
        // Observe the nav's computed display at the moment the article is read
        const article = document.getElementById('art');
        Object.defineProperty(article, 'innerText', {
            get() {
                seen.push(document.getElementById('nav').style.display);
                return LONG;
            },
        });

        extractPageText('nav', ['article'], 10, 8000);

        expect(seen).toEqual(['none']);
    });

    test('restores the page exactly — no removed nodes, original inline styles intact', () => {
        const before = document.body.innerHTML;

        extractPageText('nav, footer, .share-bar', ['article'], 10, 8000);

        expect(document.body.innerHTML).toBe(before);
        expect(document.getElementById('nav').style.color).toBe('red');
        expect(document.getElementById('share').style.getPropertyValue('display')).toBe('flex');
        expect(document.getElementById('share').style.getPropertyPriority('display')).toBe('important');
    });

    test('restores the page even when reading throws', () => {
        const before = document.body.innerHTML;
        const article = document.getElementById('art');
        Object.defineProperty(article, 'innerText', { get() { throw new Error('boom'); } });

        expect(() => extractPageText('nav, footer', ['article'], 10, 8000)).toThrow('boom');
        expect(document.body.innerHTML).toBe(before);
    });
});
