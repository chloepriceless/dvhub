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

function makeStorageStub(seed) {
  const map = new Map(seed || []);
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); }
  };
}

function loadCommonScript() {
  const commonPath = path.join(publicDir, 'common.js');
  const source = fs.readFileSync(commonPath, 'utf8');
  const localStore = new Map([[legacyTokenKey, 'legacy-token']]);
  // common.js stores the API token in localStorage so it survives closing the
  // tab/browser (operator decision 2026-06-27; see common.js tokenStore()). A
  // sessionStorage stub is still provided because migrateLegacyToken() reads the
  // old sessionStorage home (and clears it) for the one-time migration path.
  const sessionStore = makeStorageStub();
  const events = [];
  const sandbox = {
    console,
    URL,
    Headers,
    CustomEvent,
    fetch: async () => ({ status: 401 }),
    globalThis: {},
    // Plan 16-04 (D-06 triage, brittle test): common.js legitimately grew a
    // top-level `document` reference (Aurora topbar nav-toggle wiring at
    // common.js:280). The sandbox lacked `document`, so loading common.js threw
    // `ReferenceError: document is not defined`. This is a MINIMAL document stub
    // sufficient for the module-load path — readyState !== 'loading' so the
    // wire fn runs once and only does `getElementById` lookups (all null here).
    document: {
      readyState: 'complete',
      documentElement: null,
      getElementById() { return null; },
      addEventListener() {},
      createElement() { return { style: {}, setAttribute() {}, appendChild() {} }; }
    },
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
      sessionStorage: sessionStore,
      // Plan 16-04 (D-06 triage, brittle test): syncTokenFromUrl() calls
      // window.history.replaceState after persisting the token — provide a
      // no-op history stub so the rewrite path does not throw.
      history: { replaceState() {} },
      dispatchEvent(event) {
        events.push(event.type);
      },
      // Plan 16-04 (D-06 triage, brittle test): common.js grew a
      // window.addEventListener call — extend the sandbox window stub to match.
      addEventListener() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'common.js' });
  return { sandbox, localStore, sessionStore, events };
}

test('common script exposes DVhub branding, migrates legacy token storage, and emits the DVhub event', async () => {
  const { sandbox, localStore, events } = loadCommonScript();

  assert.ok(sandbox.window.DVhubCommon);
  assert.equal(sandbox.window[`${legacyBrand}Common`], undefined);
  // The URL `?token=` value is persisted into localStorage (canonical token
  // store — survives tab/browser close), and read back by getStoredApiToken().
  assert.equal(localStore.get('dvhub.apiToken'), 'url-token');
  assert.equal(sandbox.window.DVhubCommon.getStoredApiToken(), 'url-token');

  await sandbox.window.DVhubCommon.apiFetch('/api/status');
  assert.deepEqual(events, ['dvhub:unauthorized']);
});

test('all public HTML entrypoints use DVhub branding and remove legacy product copy', () => {
  // tools.html is a meta-refresh stub since Plan 08-10 (redirects to /settings.html#system),
  // so it is no longer a full HTML entrypoint. It still contains "DVhub" in the title.
  for (const fileName of ['index.html', 'settings.html', 'tools.html', 'setup.html']) {
    const html = fs.readFileSync(path.join(publicDir, fileName), 'utf8');
    assert.match(html, /DVhub/);
    assert.doesNotMatch(html, new RegExp(`${legacyBrand}|${legacyBrandLower}`));
  }
});

test('shell navigation uses Leitstand and Einstellungen without Wartung link', () => {
  // Plan 16-04 (D-06 triage, UI-drift): setup.html is a kiosk-style first-run
  // wizard with NO top-nav by design (the user is mid-bootstrap and must not
  // navigate away) — see the explicit comment in setup.html. Only the shell
  // pages index.html + settings.html carry the topbar nav.
  for (const fileName of ['index.html', 'settings.html']) {
    const html = fs.readFileSync(path.join(publicDir, fileName), 'utf8');
    assert.match(html, />Leitstand</);
    assert.match(html, />Einstellungen</);
    assert.doesNotMatch(html, />Tools</);
    assert.doesNotMatch(html, />Wartung</);
  }
});

test('shell branding includes the DVhub logo asset', () => {
  // Plan 16-04 (D-06 triage, UI-drift): rebuilt as a targeted assertion. The
  // Aurora redesign replaced the pre-Aurora `.app-brand-logo` / `.app-nav-link`
  // shell CSS (in the now-removed styles.css) with the `topbar-brand` shell.
  // The load-bearing branding fact — the DVhub wordmark asset is wired into the
  // shell topbar and no legacy product copy survives — is preserved.
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

  assert.match(html, /\/assets\/dvhub-wordmark\.png/);
  assert.match(html, /class="topbar-brand"/);
  assert.doesNotMatch(html, /Produktbild|Dunkler Energy-Tech-Leitstand für Routing, Messwerte und Steuerung\./);
});

// Plan 16-04 (D-06 triage, UI-drift): three pre-Aurora settings/topbar markup
// snapshot tests were DELETED here as redundant — they asserted the pre-Aurora
// `settings-compact-bar` / `compact-topbar` / `settings-topbar-status` /
// `settingsNavTree` chrome that the Phase-09.1 Aurora redesign replaced
// wholesale with a tab-based settings page. The shipped Aurora settings page
// is covered by settings-shell.test.js (destination workspace, tabs, real
// config definition). Re-baselining these full-markup snapshots would add no
// value over that targeted suite.

test('setup review flow no longer uses the review öffnen wording', () => {
  const html = fs.readFileSync(path.join(publicDir, 'setup.html'), 'utf8');
  const js = fs.readFileSync(path.join(publicDir, 'setup.js'), 'utf8');

  assert.doesNotMatch(html, /Review öffnen/);
  assert.doesNotMatch(js, /Review öffnen/);
});

test('setup review copy makes clear that the summary is not saved yet and saving is still required', () => {
  const js = fs.readFileSync(path.join(publicDir, 'setup.js'), 'utf8');

  assert.match(js, /noch nicht gespeichert/i);
  assert.match(js, /Jetzt speichern/i);
});

test('setup page positions itself as guided entry into the full Einrichtung workspace', () => {
  const html = fs.readFileSync(path.join(publicDir, 'setup.html'), 'utf8');

  assert.match(html, /Geführter Einstieg/);
  assert.match(html, /Zur Einrichtung/);
  assert.match(html, /vollständige Einrichtung|vollstaendige Einrichtung/);
});

test('setup validation copy explains when the review step is still locked', () => {
  const js = fs.readFileSync(path.join(publicDir, 'setup.js'), 'utf8');

  assert.match(js, /Prüfung ist erst verfügbar|Pruefung ist erst verfuegbar/);
});

// Plan 16-04 (D-06 triage, UI-drift): the pre-Aurora "settings page moves the
// status block into the top row" snapshot test was DELETED here as redundant —
// see the note above; the Aurora tab-based settings page is covered by
// settings-shell.test.js.

test('tools.html is a meta-refresh stub redirecting to /settings.html#system (Plan 08-10)', () => {
  // Plan 08-10 retired the standalone "Wartung" page in favour of the System tab
  // inside Einstellungen. tools.html now ships only as a redirect shim.
  // Plan 16-04 (D-06 triage, UI-drift): Plan 09.1-07 removed the inline
  // `window.location.replace()` belt-and-suspenders fallback — the CSP
  // script-src no longer allows 'unsafe-inline', so it could never run anyway.
  // The redirect is driven solely by the <meta http-equiv="refresh"> now.
  const html = fs.readFileSync(path.join(publicDir, 'tools.html'), 'utf8');
  const lineCount = html.split('\n').length;

  assert.ok(lineCount <= 20, `tools.html should be <= 20 lines, got ${lineCount}`);
  assert.match(html, /<meta\s+http-equiv="refresh"\s+content="0;\s*url=\/settings\.html#system"/);
  // No inline script — CSP-clean redirect shim. (Strip HTML comments first so
  // the explanatory comment that mentions the removed <script> is not matched.)
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(htmlNoComments, /<script/);
  // Must NOT contain the old page bodies
  assert.doesNotMatch(html, /Modbus-Scan|Schedule \/ Control|VRM-L/);
});

test('global styles use the Aurora DVhub design tokens', () => {
  // Plan 16-04 (D-06 triage, UI-drift): the Phase-09.1 Aurora redesign replaced
  // the pre-Aurora design tokens (--dvhub-bg / --dvhub-electric / "Rajdhani" /
  // "Inter") with the Aurora design system in dvhub-app.css. Rebuilt to assert
  // the tokens that actually ship today, and that the legacy fonts are gone.
  const css = fs.readFileSync(path.join(publicDir, 'dvhub-app.css'), 'utf8');

  assert.match(css, /:root\s*\{/);
  assert.match(css, /--accent:\s*var\(--cyan\)/);
  assert.match(css, /--cyan:\s*#/i);
  assert.match(css, /--f-body:/);
  assert.doesNotMatch(css, new RegExp(`${legacyHeadingFont}|${legacyBodyFont}`));
});

// Plan 16-04 (D-06 triage, UI-drift): two pre-Aurora CSS-snapshot tests were
// DELETED here ("compact settings and maintenance layout primitives" and
// "settings disclosures affordance styling"). They asserted ~14 specific
// pre-Aurora CSS class declarations in the now-removed styles.css. The Aurora
// redesign replaced that whole settings stylesheet; re-baselining a full-CSS
// snapshot of the rebuilt settings.css would add no value (D-05: no blind
// re-baselining). The settings page's actual behaviour is exercised by
// settings-shell.test.js.

test('readme references the DVhub assets folder for logo and screenshot gallery', () => {
  // Plan 16-04 (D-06 triage, UI-drift): the screenshot filenames in the README
  // were refreshed (the 2026-03-24 captures were replaced by the 2026-05-18
  // Aurora-UI captures). Assert the shipped asset paths.
  const readme = fs.readFileSync(readmePath, 'utf8');

  assert.match(readme, /assets\/dvhub-wordmark\.png/);
  assert.match(readme, /assets\/screenshots\/[a-z0-9-]+\.png/);
  assert.doesNotMatch(readme, /docs\/dvhub-logo\.png|docs\/dashboard-desktop\.png/);
  assert.doesNotMatch(readme, /cd \/opt\/dvhub\/dv-control-webapp|WorkingDirectory=\/opt\/dvhub\/dv-control-webapp|ExecStart=\/usr\/bin\/node --experimental-sqlite \/opt\/dvhub\/dv-control-webapp\/server\.js/);
});
