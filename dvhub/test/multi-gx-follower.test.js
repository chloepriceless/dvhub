// test/multi-gx-follower.test.js -- Regler fuer die zweite Victron-GX-Anlage am
// selben Netzanschluss (ohne PV, ohne eigenen Zaehler; Chrissi 21.10.2026).
//
// Die Hauptanlage (mit Zaehler) regelt den Anschluss schnell. Die zweite Anlage
// regelt traege ihren Anteil an der GESAMTEN Akkuleistung; der Anteil folgt der
// nutzbaren Energie (Entladen: ueber Mindest-SoC, Laden: bis Max-SoC), so
// gleichen sich die Ladestaende an und EOS kann beide Akkus als einen planen.
// Stellgroesse ist der Netz-Sollwert der zweiten GX (2716/2717): ohne eigenen
// Zaehler wirkt er auf ihren AC-IN. Vorzeichen wie ueberall: + = Laden/Bezug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFollowerController } from '../services/multi-gx/follower-controller.js';

const SIDE = { capacityWh: 64000, minSocPct: 10, maxSocPct: 100 };
const cfg = (over = {}) => ({ maxChargeW: 10000, maxDischargeW: 10000, ...over });

// Anlagenmodell: Netz bleibt auf dem Ziel (Hauptanlage regelt schnell). Die
// zweite GX setzt ihren AC-IN-Sollwert einen Takt spaeter um (Verzug).
// Gesamte Akkuleistung = PV - Hausverbrauch beider Haelften (Netz 0).
function plant({ pvW = 0, mainLoadW = 3000, tenantLoadW = 1000, primarySoc = 50, followerSoc = 50 } = {}) {
  let appliedS = 0;
  return {
    measure() {
      const totalW = pvW - mainLoadW - tenantLoadW;
      const followerBatteryW = appliedS - tenantLoadW; // AC-IN deckt Mieter-Last + Akku
      return {
        primaryBatteryW: totalW - followerBatteryW,
        followerBatteryW,
        followerAcInW: appliedS, // ohne eigenen Zaehler meldet die GX ihren AC-IN als Netz
        primary: { ...SIDE, socPct: primarySoc },
        follower: { ...SIDE, socPct: followerSoc },
      };
    },
    apply(s) { appliedS = s; },
  };
}

function run(ctrl, p, { ticks = 60, stepMs = 5000, extra = {} } = {}) {
  const out = [];
  for (let i = 0; i < ticks; i++) {
    const o = ctrl.tick({ nowMs: i * stepMs, ...p.measure(), ...extra });
    p.apply(o.setpointW);
    out.push(o);
  }
  return out;
}

test('Eigenverbrauch 4 kW, gleiche Ladestaende: zweite Anlage traegt die Haelfte, eingeschwungen', () => {
  const c = createFollowerController(cfg());
  const p = plant();
  const out = run(c, p);
  const last = out.at(-1);
  assert.equal(last.desiredFollowerBatteryW, -2000);
  assert.ok(Math.abs(p.measure().followerBatteryW - -2000) <= 300, `Akku zweite Anlage ${p.measure().followerBatteryW}`);
  // AC-IN-Sollwert = Akku-Anteil + Mieter-Last
  assert.ok(Math.abs(last.setpointW - -1000) <= 300);
});

test('Netzziel 0 laesst die zweite Anlage NICHT brachliegen (Unterschied zum Vorschlag vom 26.09.)', () => {
  const c = createFollowerController(cfg());
  const p = plant({ mainLoadW: 5000, tenantLoadW: 0 });
  run(c, p);
  assert.ok(p.measure().followerBatteryW <= -2200, 'zweiter Akku entlaedt mit');
});

test('Ladestaende angleichen: voller zweiter Akku entlaedt mehr', () => {
  const c = createFollowerController(cfg());
  const p = plant({ primarySoc: 30, followerSoc: 80 }); // nutzbar 20 % vs 70 %
  const last = run(c, p).at(-1);
  assert.equal(last.desiredFollowerBatteryW, Math.round(-4000 * 70 / 90));
  assert.equal(last.followerWeightPct, Number((70 / 90 * 100).toFixed(1)));
});

test('Laden: Anteil nach freiem Platz', () => {
  const c = createFollowerController(cfg());
  const p = plant({ pvW: 9000, mainLoadW: 1000, tenantLoadW: 0, primarySoc: 40, followerSoc: 90 }); // frei 60 % vs 10 %
  const last = run(c, p).at(-1);
  assert.equal(last.desiredFollowerBatteryW, Math.round(8000 * 10 / 70));
});

test('zweiter Akku am Mindest-SoC: kein Entlade-Anteil', () => {
  const c = createFollowerController(cfg());
  const p = plant({ followerSoc: 10 });
  const last = run(c, p).at(-1);
  assert.equal(last.desiredFollowerBatteryW, 0);
});

test('Anteil auf die Leistung der zweiten Anlage begrenzt, Sollwert ebenso', () => {
  const c = createFollowerController(cfg({ maxDischargeW: 1500, maxChargeW: 1500 }));
  const p = plant({ mainLoadW: 9000, tenantLoadW: 0 });
  const out = run(c, p);
  assert.equal(out.at(-1).desiredFollowerBatteryW, -1500);
  assert.ok(out.every((o) => o.setpointW >= -1500 && o.setpointW <= 1500));
});

test('traege: erster Takt bewegt nichts, danach hoechstens Rampe x Sekunden', () => {
  const c = createFollowerController(cfg({ rampWPerS: 100 }));
  const p = plant();
  const out = run(c, p, { ticks: 4 });
  assert.equal(out[0].setpointW, 0);
  for (let i = 1; i < out.length; i++) {
    assert.ok(Math.abs(out[i].setpointW - out[i - 1].setpointW) <= 500, `Schritt ${i}: ${out[i - 1].setpointW} → ${out[i].setpointW}`);
  }
});

test('Totband: kleine Abweichung bewegt den Sollwert nicht', () => {
  const c = createFollowerController(cfg({ deadbandW: 300 }));
  const m = { primary: { ...SIDE, socPct: 50 }, follower: { ...SIDE, socPct: 50 } };
  c.tick({ nowMs: 0, primaryBatteryW: -1200, followerBatteryW: -800, ...m }); // Soll -1000, Abweichung 200
  const o = c.tick({ nowMs: 5000, primaryBatteryW: -1200, followerBatteryW: -800, ...m });
  assert.equal(o.setpointW, 0);
  assert.equal(o.reason, 'deadband');
});

test('kein Aufschwingen: sekuendlich springende Last bewegt den Sollwert kaum', () => {
  const c = createFollowerController(cfg());
  let appliedS = 0;
  const seen = [];
  for (let i = 0; i < 300; i++) {
    const mainLoadW = i % 2 ? 6000 : -2000; // Last springt jede Sekunde (-2000 = PV-Spitze)
    const totalW = -mainLoadW;
    const o = c.tick({ nowMs: i * 1000, primaryBatteryW: totalW - appliedS, followerBatteryW: appliedS,
      primary: { ...SIDE, socPct: 50 }, follower: { ...SIDE, socPct: 50 } });
    appliedS = o.setpointW;
    if (i >= 240) seen.push(o.setpointW);
  }
  const spread = Math.max(...seen) - Math.min(...seen);
  assert.ok(spread <= 400, `Sollwert pendelt um ${spread} W`);
  assert.ok(Math.abs(seen.at(-1) - -1000) <= 400, `mittlerer Anteil ${seen.at(-1)}`);
});

test('offline: sofort 0; wieder da: von 0 aus traege hoch', () => {
  const c = createFollowerController(cfg());
  const p = plant();
  run(c, p, { ticks: 30 });
  const off = c.tick({ nowMs: 200000, ...p.measure(), online: false });
  assert.deepEqual([off.setpointW, off.reason], [0, 'follower_offline']);
  const back = c.tick({ nowMs: 205000, ...p.measure() });
  assert.ok(Math.abs(back.setpointW) <= 1000);
});

test('Not-Halt/Pause: sofort 0', () => {
  const c = createFollowerController(cfg());
  const p = plant();
  run(c, p, { ticks: 30 });
  const o = c.tick({ nowMs: 200000, ...p.measure(), stop: true });
  assert.deepEqual([o.setpointW, o.reason], [0, 'stop']);
});

test('Einspeisung gesperrt (Abregelung, negativer Preis): zweite Anlage speist nicht ins Hausnetz', () => {
  const c = createFollowerController(cfg());
  const p = plant();
  const out = run(c, p, { extra: { exportBlocked: true } });
  assert.ok(out.every((o) => o.setpointW >= 0));
  assert.equal(out.at(-1).reason, 'export_blocked');
});

test('Messwerte fehlen: Sollwert laeuft traege Richtung 0', () => {
  const c = createFollowerController(cfg({ rampWPerS: 100 }));
  const p = plant();
  run(c, p, { ticks: 40 });
  const before = c.tick({ nowMs: 400000, ...p.measure() }).setpointW;
  const o = c.tick({ nowMs: 405000, primaryBatteryW: null, followerBatteryW: -1000, primary: { ...SIDE, socPct: 50 }, follower: { ...SIDE, socPct: 50 } });
  assert.equal(o.reason, 'no_data');
  assert.ok(Math.abs(o.setpointW) < Math.abs(before) && Math.abs(before - o.setpointW) <= 500);
});

test('ganze Watt, kein -0', () => {
  const c = createFollowerController(cfg());
  const o = c.tick({ nowMs: 0, primaryBatteryW: -0.4, followerBatteryW: 0, primary: { ...SIDE, socPct: 50 }, follower: { ...SIDE, socPct: 50 } });
  for (const k of ['setpointW', 'desiredFollowerBatteryW']) assert.ok(Number.isInteger(o[k]) && !Object.is(o[k], -0), k);
});

test('ungueltige Konfiguration wirft', () => {
  assert.throws(() => createFollowerController({ maxChargeW: 1000 }), /maxDischargeW/);
  assert.throws(() => createFollowerController({ maxChargeW: -1, maxDischargeW: 1000 }), /maxChargeW/);
  assert.throws(() => createFollowerController({ maxChargeW: '', maxDischargeW: 1000 }), /maxChargeW/);
});

// Codex-Gegenpruefung 21.10.: Hauptanlage leer → gemessene Summe 0, der Bedarf
// zeigt sich nur als Netzbezug ueber dem Sollwert. Den muss die zweite Anlage
// uebernehmen koennen (unmetW = Netz − Sollwert der Hauptanlage, nur > 0).
test('Hauptanlage leer: zweite Anlage deckt den ungedeckten Bedarf', () => {
  const c = createFollowerController(cfg());
  let s = 0;
  for (let i = 0; i < 60; i++) {
    const unmetW = Math.max(0, 3000 + s); // Haus 3 kW, zweite Anlage schiebt -s ins Hausnetz
    const o = c.tick({ nowMs: i * 5000, primaryBatteryW: 0, followerBatteryW: s, unmetW,
      primary: { ...SIDE, socPct: 10 }, follower: { ...SIDE, socPct: 70 } });
    s = o.setpointW;
  }
  assert.ok(Math.abs(s - -3000) <= 300, `zweite Anlage ${s}`);
});

test('Mieter-Last 4 kW, Akku-Grenze 1,5 kW: AC-IN darf ueber 1,5 kW, Akku bleibt bei -1,5 kW', () => {
  const c = createFollowerController(cfg({ maxChargeW: 1500, maxDischargeW: 1500 }));
  const p = plant({ mainLoadW: 0, tenantLoadW: 4000, followerSoc: 90, primarySoc: 10 });
  run(c, p, { ticks: 80 });
  const fb = p.measure().followerBatteryW;
  assert.ok(fb >= -1500 - 300 && fb <= -1500 + 300, `Akku zweite Anlage ${fb}`);
});

// Codex-Gegenpruefung Runde 2 (21.10.)
test('BMS drosselt das Laden: Sollwert laeuft dem gemessenen AC-IN nicht davon (kein Aufschaukeln)', () => {
  const c = createFollowerController(cfg({ maxChargeW: 5000 }));
  let s = 0;
  let capped = true;
  const seen = [];
  for (let i = 0; i < 120; i++) {
    if (i === 80) capped = false; // BMS gibt wieder frei
    const fb = capped ? Math.min(1000, s) : s;   // Akku nimmt hoechstens 1 kW
    const acIn = fb;                              // keine eigene Last
    const o = c.tick({ nowMs: i * 5000, primaryBatteryW: 5000, followerBatteryW: fb, followerAcInW: acIn,
      primary: { ...SIDE, socPct: 50 }, follower: { ...SIDE, socPct: 50 } });
    s = o.setpointW;
    seen.push(s);
  }
  assert.ok(Math.max(...seen.slice(0, 80)) <= 2500, `gedrosselt: Sollwert bis ${Math.max(...seen.slice(0, 80))}`);
  assert.ok(Math.max(...seen) <= 5000, `nach Freigabe kein Sprung ueber die Ladegrenze (${Math.max(...seen)})`);
});

test('ungedeckter LADE-Bedarf (Hauptanlage voll): zweite Anlage laedt', () => {
  const c = createFollowerController(cfg());
  let s = 0;
  for (let i = 0; i < 60; i++) {
    const unmetW = -Math.max(0, 4000 - s); // Netz soll +4 kW beziehen, Hauptanlage voll
    const o = c.tick({ nowMs: i * 5000, primaryBatteryW: 0, followerBatteryW: s, unmetW,
      primary: { ...SIDE, socPct: 100 }, follower: { ...SIDE, socPct: 30 } });
    s = o.setpointW;
  }
  assert.ok(Math.abs(s - 4000) <= 300, `zweite Anlage laedt ${s}`);
});
