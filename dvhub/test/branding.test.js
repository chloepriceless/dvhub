import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = path.join(repoRoot, 'public');
const readmePath = path.resolve(repoRoot, '..', 'README.md');
const legacyBrand = ['P', 'lex', 'Lite'].join('');
const legacyBrandLower = ['P', 'lex', 'lite'].join('');
const legacyTokenKey = ['plex', 'lite.apiToken'].join('');
const legacyHeadingFont = ['Saira', ' ', 'Condensed'].join('');
const legacyBodyFont = ['Man', 'rope'].join('');

function loadCommonScript() {
  const commonPath = path.join(publicDir, 'common.js');
  const source = fs.readFileSync(commonPath, 'utf8');
  const localStore = new Map([[legacyTokenKey, 'legacy-token']]);
  const events = [];
  const sandbox = {
    console,
    URL,
    Headers,
    CustomEvent,
    fetch: async () => ({ status: 401 }),
    globalThis: {},
    window: {
      location: {
        href: 'http://localhost:8080/?token=url-token',
        origin: 'http://localhost:8080'
      },
      localStorage: {
        getItem(key) {
          return localStore.has(key) ? localStore.get(key) : null;
        },
        setItem(key, value) {
          localStore.set(key, String(value));
        },
        removeItem(key) {
          localStore.delete(key);
        }
      },
      dispatchEvent(event) {
        events.push(event.type);
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'common.js' });
  return { sandbox, localStore, events };
}

test('common script exposes DVhub branding, migrates legacy token storage, and emits the DVhub event', async () => {
  const { sandbox, localStore, events } = loadCommonScript();

  assert.ok(sandbox.window.DVhubCommon);
  assert.equal(sandbox.window[`${legacyBrand}Common`], undefined);
  assert.equal(localStore.get('dvhub.apiToken'), 'url-token');
  assert.equal(sandbox.window.DVhubCommon.getStoredApiToken(), 'url-token');

  await sandbox.window.DVhubCommon.apiFetch('/api/status');
  assert.deepEqual(events, ['dvhub:unauthorized']);
});

test('all public HTML entrypoints use DVhub branding and remove legacy product copy', () => {
  for (const fileName of ['index.html', 'settings.html', 'tools.html', 'setup.html']) {
    const html = fs.readFileSync(path.join(publicDir, fileName), 'utf8');
    assert.match(html, /DVhub/);
    assert.doesNotMatch(html, new RegExp(`${legacyBrand}|${legacyBrandLower}`));
  }
});

test('shell navigation uses the simplified Leitstand, Einrichtung, and Wartung structure', () => {
  for (const fileName of ['index.html', 'settings.html', 'tools.html', 'setup.html']) {
    const html = fs.readFileSync(path.join(publicDir, fileName), 'utf8');
    assert.match(html, />Leitstand</);
    assert.match(html, />Einrichtung</);
    assert.match(html, />Wartung</);
    assert.doesNotMatch(html, />Tools</);
  }
});

test('shell branding includes the DVhub logo asset and menu buttons are solid-color buttons', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

  assert.match(html, /\/assets\/dvhub\.jpg/);
  assert.doesNotMatch(html, /Produktbild|Dunkler Energy-Tech-Leitstand für Routing, Messwerte und Steuerung\./);
  assert.match(css, /\.app-brand-logo\s*\{/);
  assert.match(css, /\.app-nav-link\s*\{[^}]*background:\s*rgba\(/s);
  assert.match(css, /\.app-nav-link\.is-active\s*\{[^}]*background:\s*rgba\(/s);
  assert.doesNotMatch(css, /\.app-nav-link\.is-active\s*\{[^}]*linear-gradient/s);
  assert.doesNotMatch(css, /\.btn-primary\s*\{[^}]*linear-gradient/s);
});

test('settings page uses a compact control bar and no longer exposes service cards in the header', () => {
  const html = fs.readFileSync(path.join(publicDir, 'settings.html'), 'utf8');

  assert.match(html, /settings-compact-bar/);
  assert.doesNotMatch(html, /settings-service-panel/);
  assert.doesNotMatch(html, /Health &amp; Service/);
});

test('public pages use compact topbars instead of large hero-style headers', () => {
  for (const fileName of ['index.html', 'settings.html', 'tools.html', 'setup.html']) {
    const html = fs.readFileSync(path.join(publicDir, fileName), 'utf8');
    assert.match(html, /compact-topbar/);
    assert.doesNotMatch(html, /page-topbar/);
  }
});

test('settings page moves the status block into the top row and removes the permanent start panel', () => {
  const html = fs.readFileSync(path.join(publicDir, 'settings.html'), 'utf8');
  const settingsJs = fs.readFileSync(path.join(publicDir, 'settings.js'), 'utf8');

  assert.match(html, /settings-topbar-status/);
  assert.match(html, /settingsNavTree/);
  assert.doesNotMatch(html, /settings-topbar-side/);
  assert.doesNotMatch(html, /data-settings-target="overview"/);
  assert.doesNotMatch(html, /settingsOverview/);
  assert.doesNotMatch(settingsJs, /Was möchtest du einrichten\?/);
  assert.doesNotMatch(settingsJs, /settings-workspace-guide/);
  assert.doesNotMatch(html, /Dienst neu starten/);
});

test('maintenance page groups status, import export, history, and diagnose sections', () => {
  const html = fs.readFileSync(path.join(publicDir, 'tools.html'), 'utf8');

  assert.match(html, /DVhub Wartung/);
  assert.match(html, /Systemstatus/);
  assert.match(html, /Import &amp; Export/);
  assert.match(html, /Historie/);
  assert.match(html, /Diagnose/);
});

test('global styles use the DVhub palette and typography', () => {
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

  assert.match(css, /--dvhub-bg:\s*#071A2F/i);
  assert.match(css, /--dvhub-electric:\s*#00A8FF/i);
  assert.match(css, /--font-title:\s*"Rajdhani"/);
  assert.match(css, /--font-body:\s*"Inter"/);
  assert.doesNotMatch(css, new RegExp(`${legacyHeadingFont}|${legacyBodyFont}`));
});

test('styles define compact settings and maintenance layout primitives', () => {
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

  assert.match(css, /\.settings-compact-bar\s*\{/);
  assert.match(css, /\.maintenance-grid\s*\{/);
  assert.match(css, /\.compact-topbar\s*\{/);
  assert.match(css, /\.settings-topbar-status\s*\{/);
  assert.match(css, /\.app-nav-subtree\s*\{/);
  assert.doesNotMatch(css, /\.settings-topbar-side\s*\{/);
});

test('readme references the DVhub assets folder for logo and screenshot gallery', () => {
  const readme = fs.readFileSync(readmePath, 'utf8');

  assert.match(readme, /assets\/dvhub\.jpg/);
  assert.match(readme, /assets\/screenshots\/dashboard-live-full-2026-03-11\.png/);
  assert.match(readme, /assets\/screenshots\/history-day-2026-03-10-full\.png/);
  assert.match(readme, /assets\/screenshots\/history-month-2026-03-full\.png/);
  assert.match(readme, /assets\/screenshots\/history-year-2025-full\.png/);
  assert.doesNotMatch(readme, /docs\/dvhub-logo\.png|docs\/dashboard-desktop\.png/);
  assert.doesNotMatch(readme, /cd \/opt\/dvhub\/dv-control-webapp|WorkingDirectory=\/opt\/dvhub\/dv-control-webapp|ExecStart=\/usr\/bin\/node --experimental-sqlite \/opt\/dvhub\/dv-control-webapp\/server\.js/);
});
