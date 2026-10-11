/**
 * @jest-environment jsdom
 */
// tests/overlay-ui.test.js — real DOM: the overlay is the only owner of card markup

let listener;
let sendMessage;

beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = '';
    delete window.__cbrOverlayInstalled;
    sendMessage = jest.fn().mockResolvedValue(undefined);
    global.chrome = {
        runtime: {
            sendMessage,
            onMessage: { addListener: jest.fn((fn) => { listener = fn; }) },
        },
    };
});

const load = () => require('../overlay-ui');
const msg = (op, rest) => listener({ cbr: 'overlay', op, ...rest });
const shadowOf = () => document.getElementById('cbr-overlay-host');

describe('overlay-ui', () => {
    test('installs once even if the script is injected repeatedly', () => {
        load();
        jest.resetModules();
        load();   // flag is set → second injection is a no-op
        expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    });

    test('upsert renders a card in a shadow root, hidden from page CSS/DOM queries', () => {
        const api = load();
        msg('upsert', { card: { id: 'c1', headline: 'Headline', url: 'https://a.com/x', status: 'loading', text: 'Fetching…' } });

        const { shadow } = api.ensureUi();
        expect(shadowOf()).not.toBeNull();
        expect(document.querySelector('.card')).toBeNull();           // not in the light DOM
        expect(shadow.querySelector('.headline').textContent).toBe('Headline');
        expect(shadow.querySelector('.loading span').textContent).toBe('Fetching…');
    });

    test('upsert with the same id replaces the card instead of duplicating it', () => {
        const api = load();
        msg('upsert', { card: { id: 'c1', headline: 'H', url: 'https://a.com', status: 'loading', text: 'a' } });
        msg('upsert', { card: { id: 'c1', headline: 'H', url: 'https://a.com', status: 'done', text: 'answer', elapsedMs: 3200 }, showTiming: true });

        const { shadow } = api.ensureUi();
        expect(shadow.querySelectorAll('.card')).toHaveLength(1);
        expect(shadow.querySelector('.text').textContent).toBe('answer');
        expect(shadow.querySelector('.loading')).toBeNull();
        expect(shadow.querySelector('.timing').textContent).toBe('⏱ 3.2s');
    });

    test('timing is hidden when disabled, and error cards are styled', () => {
        const api = load();
        msg('upsert', { card: { id: 'c1', headline: 'H', url: 'https://a.com', status: 'done', text: 't', elapsedMs: 1000 }, showTiming: false });
        msg('upsert', { card: { id: 'c2', headline: 'H', url: 'https://a.com', status: 'error', text: 'Error: nope' } });

        const { shadow } = api.ensureUi();
        expect(shadow.querySelector('.timing')).toBeNull();
        expect(shadow.querySelector('.text.error').textContent).toBe('Error: nope');
    });

    test('stream updates answer text in place and removes the spinner', () => {
        const api = load();
        msg('upsert', { card: { id: 'c1', headline: 'H', url: 'https://a.com', status: 'loading', text: 'Analyzing…' } });
        msg('stream', { id: 'c1', text: '❓ Q' });
        msg('stream', { id: 'c1', text: '❓ Q\n💡 A' });

        const { shadow } = api.ensureUi();
        expect(shadow.querySelectorAll('.text')).toHaveLength(1);
        expect(shadow.querySelector('.text').textContent).toBe('❓ Q\n💡 A');
        expect(shadow.querySelector('.loading')).toBeNull();
    });

    test('stream for an unknown card or closed overlay is ignored', () => {
        load();
        expect(() => msg('stream', { id: 'nope', text: 'x' })).not.toThrow();
        expect(shadowOf()).toBeNull();
    });

    test('restore is idempotent', () => {
        const api = load();
        const cards = [
            { id: 'a', headline: 'A', url: 'https://a.com', status: 'done', text: '1' },
            { id: 'b', headline: 'B', url: 'https://b.com', status: 'done', text: '2' },
        ];
        msg('restore', { cards });
        msg('restore', { cards });

        expect(api.ensureUi().shadow.querySelectorAll('.card')).toHaveLength(2);
        expect(document.querySelectorAll('#cbr-overlay-host')).toHaveLength(1);
    });

    describe('untrusted content', () => {
        test('headline, answer and error text are rendered as text, never markup', () => {
            const api = load();
            const evil = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
            msg('upsert', { card: { id: 'c1', headline: evil, url: 'https://a.com', status: 'done', text: evil } });
            msg('upsert', { card: { id: 'c2', headline: 'H', url: 'https://a.com', status: 'error', text: evil } });

            const { shadow } = api.ensureUi();
            expect(shadow.querySelector('.card img')).toBeNull();
            expect(shadow.querySelector('.card script')).toBeNull();
            expect(shadow.querySelector('.headline').textContent).toBe(evil);
            expect(window.pwned).toBeUndefined();
        });

        test('non-http(s) URLs never become hrefs', () => {
            const api = load();
            msg('upsert', { card: { id: 'c1', headline: 'H', url: 'javascript:alert(1)', status: 'done', text: 't' } });
            msg('upsert', { card: { id: 'c2', headline: 'H', url: 'https://ok.example/x', status: 'done', text: 't' } });

            const links = api.ensureUi().shadow.querySelectorAll('.headline');
            expect(links[0].getAttribute('href')).toBeNull();
            expect(links[1].getAttribute('href')).toBe('https://ok.example/x');
        });

        test('quotes in headlines cannot break out of attributes', () => {
            const api = load();
            msg('upsert', { card: { id: 'c1', headline: '" onmouseover="x', url: 'https://a.com/"onclick="y', status: 'done', text: 't' } });

            const a = api.ensureUi().shadow.querySelector('.headline');
            expect(a.getAttributeNames().sort()).toEqual(['class', 'dir', 'href', 'rel', 'target', 'title']);
        });
    });

    test('text direction follows the content (dir=auto) so Hebrew and English both read correctly', () => {
        const api = load();
        msg('upsert', { card: { id: 'c1', headline: 'כותרת', url: 'https://a.com', status: 'done', text: '❓ מה קרה?\n💡 תשובה' } });

        const { shadow } = api.ensureUi();
        expect(shadow.querySelector('.headline').dir).toBe('auto');
        expect(shadow.querySelector('.text').dir).toBe('auto');
    });

    test('close removes the overlay and tells the background to forget the cards', () => {
        const api = load();
        msg('upsert', { card: { id: 'c1', headline: 'H', url: 'https://a.com', status: 'done', text: 't' } });

        api.ensureUi().shadow.querySelector('.close').click();

        expect(shadowOf()).toBeNull();
        expect(sendMessage).toHaveBeenCalledWith({ action: 'clearCards' });
    });

    test('a card arriving after close re-creates the overlay', () => {
        const api = load();
        msg('upsert', { card: { id: 'c1', headline: 'H', url: 'https://a.com', status: 'done', text: 't' } });
        api.ensureUi().shadow.querySelector('.close').click();
        msg('upsert', { card: { id: 'c2', headline: 'H2', url: 'https://a.com', status: 'done', text: 't' } });

        expect(shadowOf()).not.toBeNull();
        expect(api.ensureUi().shadow.querySelectorAll('.card')).toHaveLength(1);
    });

    test('ignores unrelated runtime messages', () => {
        load();
        expect(() => listener({ action: 'other' })).not.toThrow();
        expect(() => listener(undefined)).not.toThrow();
        expect(shadowOf()).toBeNull();
    });
});
