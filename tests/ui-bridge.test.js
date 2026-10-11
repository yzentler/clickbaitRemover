// tests/ui-bridge.test.js
const bridge = require('../ui-bridge');

let executeScript, sendMessage, local;

beforeEach(() => {
    executeScript = jest.fn().mockResolvedValue([{ result: undefined }]);
    sendMessage = jest.fn().mockResolvedValue(undefined);
    local = { showTiming: undefined };
    global.chrome = {
        scripting: { executeScript, insertCSS: jest.fn().mockResolvedValue(undefined) },
        tabs: { sendMessage },
        storage: { local: { get: jest.fn(async () => ({ ...local })) } },
    };
});

describe('cards', () => {
    test('upsertCard injects the overlay first, then sends state with the timing preference', async () => {
        const order = [];
        executeScript.mockImplementation(async () => { order.push('inject'); return []; });
        sendMessage.mockImplementation(async () => { order.push('send'); });

        await bridge.upsertCard(3, { id: 'c1', status: 'done' });

        expect(order).toEqual(['inject', 'send']);
        expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 3 }, files: ['overlay-ui.js'] });
        expect(sendMessage).toHaveBeenCalledWith(3, { cbr: 'overlay', op: 'upsert', card: { id: 'c1', status: 'done' }, showTiming: true });
    });

    test('showTiming=false is respected', async () => {
        local.showTiming = false;
        await bridge.upsertCard(3, { id: 'c1' });
        expect(sendMessage.mock.calls[0][1].showTiming).toBe(false);
    });

    test('streamCard is fire-and-forget and swallows a closed tab', async () => {
        sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
        await expect(bridge.streamCard(3, 'c1', 'text')).resolves.toBeUndefined();
        expect(executeScript).not.toHaveBeenCalled();   // no re-injection per chunk
    });

    test('restoreCards sends every card in one message', async () => {
        await bridge.restoreCards(9, [{ id: 'a' }, { id: 'b' }]);
        expect(sendMessage).toHaveBeenCalledWith(9, expect.objectContaining({ op: 'restore', cards: [{ id: 'a' }, { id: 'b' }] }));
    });
});

describe('page text and viewport', () => {
    test('extractCurrentPageText injects the extractor then calls it with the selectors', async () => {
        executeScript
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ result: 'article text' }]);

        const text = await bridge.extractCurrentPageText(4, 'nav', ['article'], 150, 8000);

        expect(text).toBe('article text');
        expect(executeScript.mock.calls[0][0].files).toEqual(['page-extract.js']);
        expect(executeScript.mock.calls[1][0].args).toEqual(['nav', ['article'], 150, 8000]);
    });

    test('scanViewport returns candidates and tolerates empty results', async () => {
        executeScript
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ result: [{ id: 'x' }] }]);
        expect(await bridge.scanViewport(4)).toEqual([{ id: 'x' }]);

        executeScript.mockReset().mockResolvedValue(undefined);
        expect(await bridge.scanViewport(4)).toEqual([]);
    });

    test('updateBadge never throws (tab may have navigated away)', async () => {
        executeScript.mockRejectedValue(new Error('No tab with id'));
        await expect(bridge.updateBadge(4, 'cbr-1', 'x')).resolves.toBeUndefined();
    });

    test('extractHeadlineFromLink returns an empty string when nothing matches', async () => {
        executeScript.mockResolvedValue([{ result: null }]);
        expect(await bridge.extractHeadlineFromLink(4, 'https://a.com/x')).toBe('');
    });
});
