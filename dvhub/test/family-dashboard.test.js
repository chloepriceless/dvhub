// test/family-dashboard.test.js -- Smoke tests for the Phase 03 Plan 02 family
// dashboard static assets (DASH-01). Verifies that family.html/family.js exist,
// load the local Chart.js vendor, contain the 5 main tags + widgets + touch
// panels, poll /api/family/status via window.DVhubCommon.apiFetch, namespace
// localStorage, and that /family is wired in routes-api.js. File-level regex
// assertions keep this cheap — no HTTP server spin-up.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FAMILY_HTML = path.join(ROOT, 'public', 'family.html');
const FAMILY_JS = path.join(ROOT, 'public', 'family.js');
const ROUTES = path.join(ROOT, 'routes-api.js');

function readFileOnce(p) {
  return fs.readFileSync(p, 'utf8');
}

describe('family dashboard static assets (DASH-01)', () => {
  it('public/family.html exists', () => {
    assert.ok(fs.existsSync(FAMILY_HTML), 'family.html missing');
  });

  it('public/family.js exists', () => {
    assert.ok(fs.existsSync(FAMILY_JS), 'family.js missing');
  });

  it('family.html uses local /chart.min.js (not CDN)', () => {
    const html = readFileOnce(FAMILY_HTML);
    assert.ok(html.includes('/chart.min.js'), 'must use local chart.min.js');
    assert.ok(!html.includes('cdn.jsdelivr.net'), 'CDN reference must be removed');
  });

  it('family.html contains all 5 main tag elements', () => {
    // Plan 16-04 (D-06 triage, UI-drift): the Phase-11 House-centre redesign
    // split the 5 tiles into 4 corner `tag-*` tiles + 1 central power-flow
    // readout (`pfCenter`, the "home" tile). The 5 tiles are still all present,
    // but the "home" tile is no longer a uniform `id="tag-home"` — adapt.
    for (const id of ['tag-solar', 'tag-bat', 'tag-ev', 'tag-grid']) {
      const html = readFileOnce(FAMILY_HTML);
      assert.ok(html.includes(`id="${id}"`), `missing corner tag: ${id}`);
    }
    const html = readFileOnce(FAMILY_HTML);
    // The central "home" tile is the power-flow readout (data-panel="home").
    assert.ok(html.includes('id="pfCenter"') && html.includes('data-panel="home"'),
      'missing the central home tile (pfCenter / data-panel="home")');
  });

  it('family.html has data-panel attributes for touch panels', () => {
    const html = readFileOnce(FAMILY_HTML);
    for (const panel of [
      'data-panel="solar"',
      'data-panel="home"',
      'data-panel="bat"',
      'data-panel="ev"',
      'data-panel="grid"'
    ]) {
      assert.ok(html.includes(panel), `missing ${panel}`);
    }
  });

  it('family.html loads /common.js for apiFetch helper', () => {
    const html = readFileOnce(FAMILY_HTML);
    assert.ok(html.includes('/common.js'), 'must load common.js');
  });

  it('family.html has NO topbar (D-02 Kiosk-feel)', () => {
    const html = readFileOnce(FAMILY_HTML);
    assert.ok(!html.includes('topbar-nav'), 'family.html must not have topbar-nav');
  });

  it('family.html has forecast/price/optimizer widget elements (D-10)', () => {
    const html = readFileOnce(FAMILY_HTML);
    assert.ok(html.includes('id="forecast-chart"'), 'missing forecast widget');
    assert.ok(html.includes('id="price-now"'), 'missing price widget');
    assert.ok(html.includes('id="optimizer-action"'), 'missing optimizer widget');
  });

  it('family.html uses external /family.js (no inline script blocks with logic)', () => {
    const html = readFileOnce(FAMILY_HTML);
    // Plan 16-04 (D-06 triage, UI-drift): family.html ships the script with a
    // cache-bust query (`/family.js?v=12`). Match the path, tolerate the query.
    assert.ok(/src="\/family\.js(\?[^"]*)?"/.test(html),
      'must load /family.js as external script');
    // CSP pre-check: SECURITY_HEADERS script-src does not allow 'unsafe-inline',
    // so any non-trivial inline <script>...</script> block would be blocked.
    assert.ok(!/<script>\s*var\s+API_URL/.test(html), 'must not contain original inline API block');
    assert.ok(!/onclick=/.test(html), 'must not contain inline onclick handlers (CSP)');
  });

  it('family.js polls /api/family/status every 5s via window.DVhubCommon.apiFetch', () => {
    const js = readFileOnce(FAMILY_JS);
    assert.ok(js.includes('/api/family/status'), 'must poll /api/family/status');
    assert.ok(js.includes('POLL_INTERVAL_MS') || js.includes('5000'), 'must have 5s interval');
    assert.ok(js.includes('apiFetch'), 'must use window.DVhubCommon.apiFetch');
  });

  it('family.js uses namespaced localStorage key dvhub.family.slots (Pitfall 3)', () => {
    const js = readFileOnce(FAMILY_JS);
    assert.ok(js.includes('dvhub.family.slots'), 'must use namespaced key');
    assert.ok(!js.match(/['"]energy_slots['"]/), 'must not use generic energy_slots key');
  });

  it('family.js has offline fallback (D-22 revised 08-11 — does not clear lastStatus on error, no banner)', () => {
    const js = readFileOnce(FAMILY_JS);
    assert.ok(js.includes('lastStatus'), 'must track lastStatus');
    // Plan 08-11 Task 2: showOfflineBanner / offline-banner element removed.
    // DVhub is a LAN-only app (no SW). On poll failure, the dashboard keeps
    // last-known values; staleness is implicit via the timestamp widget.
    assert.ok(
      !js.includes('showOfflineBanner') && !js.includes("getElementById('offline-banner')"),
      'must NOT register an offline banner (08-11 removed it)'
    );
    assert.ok(
      /failedPolls\s*\+=\s*1[^}]*lastStatus\s*=\s*null/s.test(js) === false,
      'must NOT clear lastStatus when a poll fails (D-22 — last known values remain visible)'
    );
  });

  it('family.js renders forecast/price/optimizer widgets (D-10)', () => {
    const js = readFileOnce(FAMILY_JS);
    assert.ok(js.includes('renderForecastWidget'), 'missing forecast widget renderer');
    assert.ok(js.includes('renderPriceWidget'), 'missing price widget renderer');
    assert.ok(js.includes('renderOptimizerWidget'), 'missing optimizer widget renderer');
  });

  it('family.js handles visibilitychange (Pitfall 2 — re-poll on tab focus)', () => {
    const js = readFileOnce(FAMILY_JS);
    assert.ok(js.includes('visibilitychange'), 'must handle visibilitychange');
  });

  it('routes-api.js registers /family route and references family.html', () => {
    const routes = readFileOnce(ROUTES);
    assert.ok(routes.includes("'/family'"), 'must register /family route');
    assert.ok(routes.includes("'family.html'"), "must reference 'family.html' in servePage call");
  });
});
