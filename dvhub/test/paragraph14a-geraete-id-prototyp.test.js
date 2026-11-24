// §14a: Geräte-IDs wie „__proto__“ oder „constructor“ (per API setzbar, PUT /api/p14a/devices) in den Ergebnis-Tabellen
// (Christin 21.11.2026, A13).
//
// Bis 8f0f1346 schrieb DVhub Zuteilung, Reservierung und Anzeige mit `tabelle[id] = …` in gewöhnliche Objekte. Bei
// id „__proto__“ ging die Zuweisung an den Prototyp-Setter und verschwand: allocateBudget lieferte das Gerät nicht, und
// im Dienst wurde aus `free -= reserved[id]` NaN — dann bekam kein steuerbares Gerät einen Anteil, die Wallbox stand
// ohne Grenze (wallboxCapW null = „keine Grenze“). Beim Lesen einer fehlenden id „constructor“ kam eine Funktion statt
// null. Jetzt: eigene Dateneigenschaften und Lesen nur eigener Schlüssel; für gewöhnliche IDs bleibt die Ausgabe gleich.
import test from 'node:test';
import assert from 'node:assert/strict';

import { allocateBudget } from '../services/paragraph14a/rules.js';
import { createParagraph14aService } from '../services/paragraph14a/index.js';

function service(devices, limitW = 10500) {
  const cfg = {
    gridPositiveMeans: 'grid_import',
    optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000, maxChargeW: 10000 },
    wallbox: { type: 'evcc' },
    paragraph14a: { devices },
  };
  const state = { ctrl: { eebusConsumptionLimitW: limitW }, victron: { batteryPowerW: 0 }, meter: { ok: true, grid_total_w: 0, updatedAt: Date.now() } };
  const ctx = {
    state, getCfg: () => cfg, pushLog: () => {}, mqttHub: { subscribe() {} },
    evccIntegration: { getStatus: () => ({ lastError: null, lastPolledAt: Date.now(), loadpoints: [{ chargePowerW: 0, connected: true }] }) },
    eebus: { consumptionDevices: () => [], lostConsumptionDevices: () => [], controlIssues: () => [], applyConsumptionShares() {} },
  };
  const svc = createParagraph14aService(ctx, { setInterval: () => 0, clearInterval: () => {} });
  svc.update();
  return { svc, state };
}

test('allocateBudget: Gerät mit id „__proto__“ steht im Ergebnis (eigener Eintrag), gewöhnliche IDs unverändert', () => {
  const consumers = [{ id: '__proto__', kind: 'waermepumpe', maxW: 6000 }, { id: 'wb', kind: 'ladepunkt', maxW: 11000 }];
  for (const [budget, wbW] of [[8000, 2000], [20000, 11000]]) {
    const out = allocateBudget(budget, consumers);
    assert.ok(Object.hasOwn(out, '__proto__'), `Budget ${budget}: Eintrag fehlt (${JSON.stringify(out)})`);
    assert.deepEqual(Object.keys(out).sort(), ['__proto__', 'wb']);
    assert.equal(out['__proto__'], 6000);
    assert.equal(out.wb, wbW);
    assert.equal(JSON.parse(JSON.stringify(out))['__proto__'], 6000, 'auch in der JSON-Ausgabe');
    assert.equal(Object.getPrototypeOf(out), Object.prototype, 'gewöhnliches Objekt');
  }
  assert.deepEqual(allocateBudget(8000, [{ id: 'wp', kind: 'waermepumpe', maxW: 6000 }, { id: 'wb', kind: 'ladepunkt', maxW: 11000 }]), { wp: 6000, wb: 2000 }, 'gewöhnliche IDs: Ausgabe wie bisher');
});

test('§14a-Dienst: Hand-Gerät (EMS) mit id „__proto__“ → Nennleistung reserviert, Wallbox behält ihre Grenze', () => {
  const ref = service([{ id: 'wp', name: 'WP', kind: 'waermepumpe', powerW: 6000 }]).state.p14a;
  const { state } = service([{ id: '__proto__', name: 'WP', kind: 'waermepumpe', powerW: 6000 }]);
  const p = state.p14a;
  assert.ok(Object.hasOwn(p.reserved, '__proto__'), `Reservierung fehlt: ${JSON.stringify(p.reserved)}`);
  assert.equal(p.reserved['__proto__'], 6000);
  assert.deepEqual(p.shares, ref.shares, 'gleiche Anteile wie mit id „wp“');
  assert.equal(p.wallboxCapW, ref.wallboxCapW);
  assert.ok(Number.isFinite(p.wallboxCapW), `Wallbox ohne Grenze: ${p.wallboxCapW}`);
  const sum = Object.values(p.shares).reduce((a, w) => a + w, 0);
  assert.ok(sum + 6000 <= 10500, `Summe ${sum} + 6000 > 10500`);
  const dev = p.devices.find((d) => d.id === '__proto__');
  assert.equal(dev.reservedW, 6000);
});

test('§14a-Dienst: Hand-Gerät mit id „constructor“ / „toString“ ohne Reservierung (Direktsteuerung) → reservedW/needW null, keine Funktion', () => {
  const { state } = service([
    { id: 'constructor', name: 'WP', kind: 'waermepumpe', powerW: 6000, control: 'direct' },
    { id: 'toString', name: 'Klima', kind: 'klima', powerW: 3000, control: 'direct' },
  ], 7560);
  for (const id of ['constructor', 'toString']) {
    const dev = state.p14a.devices.find((d) => d.id === id);
    assert.equal(dev.reservedW, null, `${id}: reservedW`);
    assert.equal(dev.needW, null, `${id}: needW`);
  }
  assert.doesNotThrow(() => JSON.stringify(state.p14a));
});
