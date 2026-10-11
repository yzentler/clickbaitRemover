// e2e/smoke.mjs — Loads the real extension in Chrome for Testing and drives it against a local
// fake news site and a fake Ollama server. Run: cd e2e && npm install && npm run smoke
//
// Context-menu clicks are simulated by dispatching the event inside the service worker.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT_DIR || path.resolve(HERE, '..');   // EXT_DIR: test an unzipped release build
const OUT = path.join(HERE, 'out') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const SITE = 8099, LLM = 11500;

const BODY = (n) => `Article ${n}: the city council voted to close the main bridge for repairs from March through August, redirecting all traffic to the southern ring road. Officials said the project costs forty million and will add a new cycle lane. `.repeat(2);

// ── fake news site ──
const site = http.createServer((req, res) => {
    const m = req.url.match(/^\/a\/(\d+)/);
    const js = req.url.match(/^\/js\/(\d+)/);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (m) {
        const body = BODY(m[1]);
        return res.end(`<html><head><title>Story ${m[1]}</title><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script></head><body><article><p>${body}</p></article></body></html>`);
    }
    if (js) {   // client-rendered: fast fetch sees only a shell, so the hidden-tab path must work
        return res.end(`<html><head><title>JS ${js[1]}</title>${'<script>1</script>'.repeat(12)}</head><body><div id="app"></div><script>setTimeout(()=>{document.getElementById('app').innerHTML='<article><p>${BODY('js' + js[1]).replace(/'/g, '')}</p></article>'},300)</script></body></html>`);
    }
    const items = [1, 2, 3].map(n => `<div style="margin:40px 120px"><h2><a href="/a/${n}">Shocking: you will not believe what happens to bridge number ${n} this year</a></h2><p>Teaser</p></div>`).join('');
    const jsItem = `<div style="margin:40px 120px"><h2><a href="/js/4">Unbelievable: the one trick the council used on the client side bridge</a></h2></div>`;
    res.end(`<html><head><title>Home</title></head><body style="font-family:sans-serif"><header><h1>News</h1></header><main>${items}${jsItem}<footer>© footer</footer></main></body></html>`);
}).listen(SITE);

// ── fake Ollama ──
const llmCalls = [];
let llmFail = false;
const llm = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
        if (req.url.startsWith('/api/tags')) return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }] }));
        if (llmFail) { res.statusCode = 500; return res.end('boom'); }
        const body = JSON.parse(data || '{}');
        llmCalls.push({ stream: body.stream, batch: /--- ARTICLE 1 ---/.test(body.prompt), len: body.prompt.length });
        const batch = /--- ARTICLE 1 ---/.test(body.prompt);
        const count = (body.prompt.match(/--- ARTICLE \d+ ---/g) || []).length;
        if (batch) {
            const out = Array.from({ length: count }, (_, i) => `--- ${i + 1} ---\n❓ When does bridge ${i + 1} close?\n💡 March through August`).join('\n\n');
            return res.end(JSON.stringify({ response: out }));
        }
        const answer = '❓ When does the bridge close?\n💡 March through August <img src=x onerror=alert(1)>';
        if (body.stream) {
            res.setHeader('content-type', 'application/x-ndjson');
            const parts = [answer.slice(0, 20), answer.slice(20, 45), answer.slice(45)];
            let i = 0;
            const tick = () => { if (i < parts.length) { res.write(JSON.stringify({ response: parts[i++] }) + '\n'); setTimeout(tick, 80); } else res.end(JSON.stringify({ done: true }) + '\n'); };
            return tick();
        }
        res.end(JSON.stringify({ response: answer }));
    });
}).listen(LLM);

const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const browser = await puppeteer.launch({
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});

try {
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
    check('service worker (ES module) starts', true, swTarget.url());
    const sw = await swTarget.worker();
    // extension APIs are bound shortly after the worker target appears
    for (let i = 0; i < 50 && !(await sw.evaluate(() => typeof chrome.storage !== 'undefined').catch(() => false)); i++) await new Promise(r => setTimeout(r, 100));

    await sw.evaluate((port) => chrome.storage.local.set({ provider: 'ollama', apiUrl: `http://localhost:${port}/api/generate`, modelName: 'qwen2.5:3b', showTiming: true }), LLM);

    const menus = await sw.evaluate(() => new Promise(r => chrome.contextMenus.create({ id: '__probe', title: 'p' }, () => r(!chrome.runtime.lastError))));
    check('chrome APIs usable from the module worker', menus === true);

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(`http://localhost:${SITE}/`, { waitUntil: 'load' });
    await page.bringToFront();

    const tab = await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return { id: t.id, url: t.url, title: t.title }; });
    log('active tab:', JSON.stringify(tab));

    const cdp = await page.createCDPSession();
    const shadowText = async () => {
        const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
        const out = [];
        const walk = (n) => { if (n.nodeType === 3 && n.nodeValue.trim()) out.push(n.nodeValue.trim()); (n.children || []).forEach(walk); (n.shadowRoots || []).forEach(walk); if (n.contentDocument) walk(n.contentDocument); };
        walk(root);
        return out;
    };
    const waitFor = async (pred, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await pred(); if (v) return v; await new Promise(r => setTimeout(r, 200)); } return null; };

    // ── 1. right-click a link → card ──
    const linkUrl = `http://localhost:${SITE}/a/1`;
    await sw.evaluate((tab, linkUrl) => chrome.contextMenus.onClicked.dispatch({ menuItemId: 'summarizePage', linkUrl }, tab), tab, linkUrl);
    const gotAnswer = await waitFor(async () => (await shadowText()).some(t => t.includes('March through August')));
    check('link right-click → card with streamed answer in shadow DOM', !!gotAnswer);
    let texts = await shadowText();
    check('card shows headline from the page', texts.some(t => t.includes('bridge number 1')), texts.filter(t => t.includes('bridge')).join(' | ').slice(0, 80));
    check('LLM-injected <img onerror> rendered as text, not markup', texts.some(t => t.includes('<img src=x')) );
    const imgCount = await page.evaluate(() => document.querySelectorAll('img').length);
    check('no <img> element created in the page', imgCount === 0);
    check('timing label shown', texts.some(t => t.startsWith('⏱')), JSON.stringify(texts.slice(-6)));
    await page.screenshot({ path: OUT + 'card.png' });

    await new Promise(r => setTimeout(r, 500));   // let the cache write land
    // ── 2. same link again → cache hit (no extra LLM call) ──
    const before = llmCalls.length;
    await sw.evaluate((tab, linkUrl) => chrome.contextMenus.onClicked.dispatch({ menuItemId: 'summarizePage', linkUrl }, tab), tab, linkUrl);
    await waitFor(async () => (await shadowText()).filter(t => t.includes('March through August')).length >= 2, 8000);
    check('second click served from cache (no LLM call)', llmCalls.length === before, `llm calls ${before}→${llmCalls.length}`);

    // ── 3. navigation restores cards ──
    await page.goto(`http://localhost:${SITE}/a/2`, { waitUntil: 'load' });
    const restored = await waitFor(async () => (await page.evaluate(() => document.querySelectorAll('#cbr-overlay-host').length)) > 0, 8000);
    check('overlay restored after navigation', !!restored);
    await new Promise(r => setTimeout(r, 1500));   // let any duplicate restore land
    const hosts = await page.evaluate(() => document.querySelectorAll('#cbr-overlay-host').length);
    const restoredText = (await shadowText()).filter(t => t.includes('bridge number 1')).length;
    check('restored card is the one from the previous page', restoredText >= 1, `matches=${restoredText}`);
    check('exactly one overlay host after navigation', hosts === 1, `hosts=${hosts}`);

    // ── 4. SW restart keeps card state (storage.session) ──
    const stored = await sw.evaluate(async () => Object.keys(await chrome.storage.session.get(null)));
    check('card state persisted in storage.session', stored.some(k => k.startsWith('cbr_cards_')), stored.join(','));

    // ── 5. viewport batch (Alt+V path) ──
    await page.goto(`http://localhost:${SITE}/`, { waitUntil: 'load' });
    await page.bringToFront();
    const tab2 = await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return { id: t.id, url: t.url }; });
    const callsBefore = llmCalls.length;
    await sw.evaluate((tab) => chrome.contextMenus.onClicked.dispatch({ menuItemId: 'revealVisibleSpoilers' }, tab), tab2);
    const badges = await waitFor(async () => {
        const n = await page.evaluate(() => [...document.querySelectorAll('.cbr-inline-spoiler:not(.cbr-loading)')].map(b => b.textContent.trim()));
        return n.length >= 4 ? n : null;
    }, 30000);
    check('viewport spoilers: 4 inline badges resolved', !!badges, badges ? `${badges.length} badges` : 'timed out');
    const batchCalls = llmCalls.slice(callsBefore);
    check('batched: ≤2 LLM calls for 4 articles (3 per call)', batchCalls.length <= 2 && batchCalls.some(c => c.batch), JSON.stringify(batchCalls));
    const openTabs = (await browser.pages()).length;
    check('no orphaned hidden tabs left behind', openTabs <= 2, `pages=${openTabs}`);
    await page.screenshot({ path: OUT + 'inline.png' });

    // ── 5b. page click on an article page (no link): reads the live page without modifying it ──
    await page.goto(`http://localhost:${SITE}/a/3`, { waitUntil: 'load' });
    await page.bringToFront();
    await page.evaluate(() => { document.querySelectorAll('#cbr-overlay-host').forEach(h => h.remove()); });
    const tab3 = await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return { id: t.id, url: t.url, title: t.title }; });
    const domBefore = await page.evaluate(() => document.body.innerHTML);
    await sw.evaluate((tab) => chrome.contextMenus.onClicked.dispatch({ menuItemId: 'summarizePage' }, tab), tab3);
    const pageCard = await waitFor(async () => (await shadowText()).some(t => t.startsWith('⏱')), 15000);
    check('page right-click → card for the current page', !!pageCard);
    const domAfter = await page.evaluate(() => [...document.body.children].filter(c => c.id !== 'cbr-overlay-host').map(c => c.outerHTML).join(''));
    check('live page DOM untouched by extraction', domAfter === domBefore, domAfter === domBefore ? '' : 'DOM changed');

    // ── 5c. LLM failure → error card ──
    llmFail = true;
    await sw.evaluate(() => chrome.storage.local.set({ modelName: 'other-model' }));   // new cache key → forces a real call
    await sw.evaluate((tab, linkUrl) => chrome.contextMenus.onClicked.dispatch({ menuItemId: 'summarizePage', linkUrl }, tab), tab3, `http://localhost:${SITE}/a/1`);
    const errCard = await waitFor(async () => (await shadowText()).some(t => t.startsWith('Error:')), 20000);
    check('LLM failure shows an error card', !!errCard);
    llmFail = false;

    // ── 6. the page itself was not modified by extraction ──
    await page.goto(`http://localhost:${SITE}/`, { waitUntil: 'load' });
    check('home page header/footer intact', await page.evaluate(() => !!document.querySelector('header') && !!document.querySelector('footer')));

    // ── 7. close button ──
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
    check('smoke test ran to completion', false, e.stack);
} finally {
    await browser.close();
    site.close(); llm.close();
    log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
}
