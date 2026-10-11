// tests/packaging.test.js — guards against shipping a broken extension zip

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const rootJs = fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && f !== 'babel.config.js');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('manifest', () => {
    test('versions match package.json (the release workflow also checks the tag)', () => {
        expect(manifest.version).toBe(pkg.version);
    });

    test('service worker is an ES module so static imports work', () => {
        expect(manifest.background.type).toBe('module');
        expect(exists(manifest.background.service_worker)).toBe(true);
    });

    test('every referenced icon and the popup exist', () => {
        const icons = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
        for (const icon of icons) expect(exists(icon)).toBe(true);
        expect(exists(manifest.action.default_popup)).toBe(true);
    });

    test('requests no unused permissions', () => {
        expect(manifest.permissions.sort()).toEqual(['contextMenus', 'scripting', 'storage', 'webNavigation']);
    });
});

describe('module graph', () => {
    test('every relative import resolves to a shipped file', () => {
        const importRe = /^\s*(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/gm;
        for (const file of rootJs) {
            for (const [, spec] of read(file).matchAll(importRe)) {
                expect({ file, spec, found: exists(spec) }).toEqual({ file, spec, found: true });
            }
        }
    });

    test('files injected by name exist', () => {
        const filesRe = /files:\s*\[([^\]]+)\]/g;
        const injected = new Set();
        for (const file of rootJs) {
            for (const [, list] of read(file).matchAll(filesRe)) {
                for (const [, name] of list.matchAll(/['"]([^'"]+)['"]/g)) injected.add(name);
            }
        }
        expect([...injected].sort()).toEqual(['inline-spoiler.css', 'overlay-ui.js', 'page-extract.js', 'viewport-scanner.js']);
        for (const name of injected) expect(exists(name)).toBe(true);
    });

    test('injected content scripts are classic scripts (no import/export)', () => {
        for (const name of ['overlay-ui.js', 'page-extract.js', 'viewport-scanner.js']) {
            expect(read(name)).not.toMatch(/^\s*(import|export)\s/m);
        }
    });

    test('popup loads its script as a module', () => {
        expect(read('popup.html')).toContain('<script type="module" src="popup.js">');
    });
});
