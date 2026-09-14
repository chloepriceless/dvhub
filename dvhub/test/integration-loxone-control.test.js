// test/integration-loxone-control.test.js -- Steuerbefehle als flache Zeilen
// im Loxone-Text-Endpunkt (2026-09-14). Loxone Virtual HTTP Input parst
// "key=value"-Zeilen; ein JSON-Blob (scheduleActive) ist dort unbrauchbar.
// Neue Zeilen sind dvhub_control_* (namespaced, D-18) — die bestehenden
// Felder bleiben unverändert.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createApiRoutes } from '../routes-api.js';

const TEST_TOKEN = 'x'.repeat(64);
const T0 = 1_789_000_000_000;

function makeCtx() {
  const raw = { apiToken: TEST_TOKEN, trustProxy: true, trustedProxyIps: ['127.0.0.1'], allowedHosts: [], corsAllowedOrigins: [], gridPositiveMeans: 'import' };
  return {
    state: {
      ctrl: { forcedOff: false, discretionaryWritesPaused: false },
      meter: { grid_total_w: 120 },
      victron: { gridSetpointW: -100, minSocPct: 20, maxDischargeW: -1, soc: 55, batteryPowerW: -300, pvTotalW: 900 },
      schedule: {
        rules: [{ id: 'abend', source: 'forecast_optimizer', optimizer: 'eos' }],
        active: { gridSetpointW: { value: -3000, source: 'rule:abend', at: T0 } }, lastWrite: {}
      },
      costs: {}, energy: { day: '2026-09-14', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 }, epex: { data: [] }
    },
    pushLog: () => {},
    getCfg: () => raw,
    getRawCfg: () => raw,
    controlValue: () => 1,
    epexNowNext: () => ({ current: null, next: null }),
    needsSetup: () => false,
    getAppDir: () => process.cwd(),
    getAppVersion: () => ({ versionLabel: 'test' })
  };
}

async function startHandler(ctx) {
  const routes = createApiRoutes(ctx);
  const srv = createServer((req, res) => {
    Promise.resolve()
      .then(() => routes.handleRequest(req, res, new URL(req.url, `http://${req.headers.host}`)))
      .then((handled) => { if (handled === false) routes.serveStatic(req, res); })
      .catch((e) => { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e && e.stack || e)); } });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, baseUrl: `http://127.0.0.1:${srv.address().port}` };
}

describe('GET /api/integration/loxone — dvhub_control_* Zeilen', () => {
  it('liefert flache Steuerbefehl-Zeilen neben den bestehenden Feldern', async () => {
    const { srv, baseUrl } = await startHandler(makeCtx());
    after(() => new Promise((r) => srv.close(r)));
    const res = await fetch(baseUrl + '/api/integration/loxone', { headers: { 'Authorization': 'Bearer ' + TEST_TOKEN } });
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    const lines = Object.fromEntries(text.split('\n').filter(Boolean).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    assert.equal(lines.gridSetpointW, '-100', 'bestehendes Feld unverändert (Rücklesung)');
    assert.equal(lines.dvhub_control_grid_setpoint_w, '-3000', 'aktiver Sollwert');
    assert.equal(lines.dvhub_control_min_soc_pct, '20');
    assert.equal(lines.dvhub_control_max_discharge_w, '-1');
    assert.equal(lines.dvhub_control_charge_current_a, 'null');
    assert.equal(lines.dvhub_control_source, 'eos', 'EOS-Regel → Herkunft eos');
    assert.equal(lines.dvhub_control_rule, 'abend');
    assert.equal(lines.dvhub_control_updated_at, new Date(T0).toISOString());
    assert.equal(lines.dvhub_control_paused, 'false');
    assert.equal(Object.keys(lines).some(k => /feed_excess/i.test(k)), false);
  });
});
