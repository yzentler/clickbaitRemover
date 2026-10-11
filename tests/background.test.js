// tests/background.test.js — the service worker entry point should only wire events to flows

jest.mock('../spoiler-flow', () => ({
    handleLinkClick: jest.fn(),
    handlePageClick: jest.fn(),
    handleRevealVisibleSpoilers: jest.fn(),
}));
jest.mock('../card-state', () => ({
    reinjectOverlay: jest.fn(),
    clearCards: jest.fn(),
}));
jest.mock('../ui-bridge', () => ({ restoreCards: jest.fn() }));
jest.mock('../cache', () => ({ pruneCache: jest.fn() }));

const flow = require('../spoiler-flow');
const cards = require('../card-state');
const bridge = require('../ui-bridge');
const cache = require('../cache');

const handlers = {};
const capture = (name) => ({ addListener: jest.fn((fn) => { handlers[name] = fn; }) });

beforeAll(() => {
    global.chrome = {
        runtime: { onInstalled: capture('installed'), onStartup: capture('startup'), onMessage: capture('message') },
        contextMenus: { create: jest.fn(), onClicked: capture('menu') },
        commands: { onCommand: capture('command') },
        webNavigation: { onCompleted: capture('nav') },
        tabs: { onRemoved: capture('removed'), query: jest.fn() },
    };
    require('../background');
});

beforeEach(() => jest.clearAllMocks());

test('creates both context menus and prunes the cache on install', () => {
    handlers.installed();
    const ids = chrome.contextMenus.create.mock.calls.map(c => c[0].id);
    expect(ids).toEqual(['summarizePage', 'revealVisibleSpoilers']);
    expect(cache.pruneCache).toHaveBeenCalled();
});

test('prunes the cache on browser startup', () => {
    handlers.startup();
    expect(cache.pruneCache).toHaveBeenCalled();
});

describe('context menu routing', () => {
    const tab = { id: 1, url: 'https://a.com', title: 't' };

    test('link → link flow', () => {
        handlers.menu({ menuItemId: 'summarizePage', linkUrl: 'https://a.com/x' }, tab);
        expect(flow.handleLinkClick).toHaveBeenCalledWith(tab, 'https://a.com/x');
    });

    test('selection / page → page flow with the selection text', () => {
        handlers.menu({ menuItemId: 'summarizePage', selectionText: 'chosen text' }, tab);
        expect(flow.handlePageClick).toHaveBeenCalledWith(tab, 'chosen text');
    });

    test('reveal-visible menu → viewport flow', () => {
        handlers.menu({ menuItemId: 'revealVisibleSpoilers' }, tab);
        expect(flow.handleRevealVisibleSpoilers).toHaveBeenCalledWith(tab);
    });

    test('ignores unknown menus and tab-less clicks', () => {
        handlers.menu({ menuItemId: 'other' }, tab);
        handlers.menu({ menuItemId: 'summarizePage', linkUrl: 'x' }, undefined);
        expect(flow.handleLinkClick).not.toHaveBeenCalled();
    });
});

describe('keyboard command', () => {
    test('Alt+V runs the viewport flow on the active tab', async () => {
        const tab = { id: 2, url: 'https://a.com' };
        chrome.tabs.query.mockResolvedValue([tab]);
        await handlers.command('reveal-visible-spoilers');
        expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
        expect(flow.handleRevealVisibleSpoilers).toHaveBeenCalledWith(tab);
    });

    test('ignores other commands', async () => {
        await handlers.command('something-else');
        expect(chrome.tabs.query).not.toHaveBeenCalled();
    });
});

describe('tab lifecycle', () => {
    test('restores cards after main-frame http(s) navigation only', () => {
        handlers.nav({ frameId: 0, url: 'https://a.com', tabId: 3 });
        expect(cards.reinjectOverlay).toHaveBeenCalledWith(3, bridge.restoreCards);

        cards.reinjectOverlay.mockClear();
        handlers.nav({ frameId: 2, url: 'https://a.com', tabId: 3 });
        handlers.nav({ frameId: 0, url: 'chrome://settings', tabId: 3 });
        expect(cards.reinjectOverlay).not.toHaveBeenCalled();
    });

    test('forgets cards when a tab closes', () => {
        handlers.removed(8);
        expect(cards.clearCards).toHaveBeenCalledWith(8);
    });

    test('clearCards message is honoured only from a tab', () => {
        handlers.message({ action: 'clearCards' }, { tab: { id: 6 } });
        expect(cards.clearCards).toHaveBeenCalledWith(6);

        cards.clearCards.mockClear();
        handlers.message({ action: 'clearCards' }, {});
        expect(cards.clearCards).not.toHaveBeenCalled();
    });
});
