// Gemeinsames Wiedergabe-Geschirr für die Golden-Master des Node-Schreibtors (H-1, Nachweis D.4(2) des
// VCL-Vertrags): Fake-Transport, der jede Draht-Operation geordnet aufzeichnet ({Art, Adresse/Topic, FC,
// Wörter/Nutzlast}) und Geräteantworten abspielt, feste Uhr und ein Schritt-Rekorder (Draht-Folge, `ok`,
// Log-Ereignisnamen). Die Netze rufen nur exportierte Produktionsfunktionen auf.
import assert from 'node:assert/strict';
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../../config-model.js';
import { createScheduleEvaluator } from '../../schedule-eval.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(HERE, '..', '..', 'hersteller');

export const FREEZE = process.env.GOLDEN_FREEZE === '1';
// Feste Uhr für alle Netze: 18.11.2026 10:00 UTC. Date wird je Test über t.mock.timers gestellt.
export const GOLDEN_T0 = Date.UTC(2026, 10, 18, 10, 0, 0);
// Test-Netz-Adressen (RFC 5737) — nie ein echtes Gerät.
export const HOST = '192.0.2.10';

/** Feste Uhr (und auf Wunsch Timer) für den Test; liefert advance(ms) = Uhr vorstellen + Mikrotasks leeren. */
export function fixClock(t, apis = ['Date']) {
  t.mock.timers.enable({ apis, now: GOLDEN_T0 });
  return async (ms = 0) => {
    if (ms > 0) t.mock.timers.tick(ms);
    // setImmediate ist nicht gemockt: zwei Runden reichen für die verketteten awaits im Verify-Pfad.
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
  };
}

/** Ausgeliefertes Herstellerprofil durch den echten Ladeweg (loadConfigFile) → effektive Config. */
export function loadProfileConfig(profile, persisted = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dvhub-gate-${profile}-`));
  try {
    fs.mkdirSync(path.join(root, 'hersteller'));
    fs.copyFileSync(path.join(PROFILE_DIR, `${profile}.json`), path.join(root, 'hersteller', `${profile}.json`));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ manufacturer: profile, ...persisted }));
    const loaded = loadConfigFile(path.join(root, 'config.json'));
    assert.equal(loaded.manufacturerProfileError, null, `Profil ${profile} lädt nicht`);
    return loaded.effectiveConfig;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Temporäres Verzeichnis für Merker-Dateien (dv_seq_saved.json, dv_seq_writeday.json). */
export function tempDir(t, tag = 'merker') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dvhub-gate-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Modbus-Attrappe mit Register-Abbild. Jede Operation landet als stabiler String in `ops`:
 *   R<fc> <host>/u<unit> @<addr> x<qty>[ !fehler]       Lesen
 *   W6 <host>/u<unit> @<addr>=<wert>[ !fehler]          Einzel-Write
 *   W16 <host>/u<unit> @<addr>=[w1,w2][ !fehler]        Block-Write
 * opts.failWrite / failRead: { [addr]: 'meldung' | { msg, times, skip, apply } } — apply: Gerät übernimmt den
 *   Wert trotzdem (Ausnahme nach dem Schreiben); skip: die ersten n Zugriffe gelingen; times: danach scheitern
 *   nur n Zugriffe. Zur Laufzeit änderbar (rig.transport.failWrite[addr] = …).
 * opts.readOverride: { [addr]: [wörter] } — abweichende Rücklesung. opts.ignoreWrite: [addr] — Gerät verwirft.
 */
export function recordingModbus({ holding = {}, hosts = {}, failWrite = {}, failRead = {}, readOverride = {}, ignoreWrite = [], hostAlias = { [HOST]: 'gx' } } = {}) {
  const image = (h) => new Map(Object.entries(h).map(([k, v]) => [Number(k), v & 0xffff]));
  // holding = Abbild des Hauptgeräts; hosts = { [host]: abbild } für weitere Geräte im SELBEN Log.
  const regs = image(holding);
  const hostRegs = new Map(Object.entries(hosts).map(([h, img]) => [h, image(img)]));
  const regsOf = (req) => hostRegs.get(req.host) || regs;
  const ops = [];
  const hits = new Map();
  const who = (req) => `${hostAlias[req.host] ?? (req.host || '-')}/u${req.unitId}`;
  const fault = (table, kind, addr, req) => {
    // Schlüssel '<host>@<addr>' trifft nur dieses Gerät, '<addr>' jedes.
    const hostKey = `${req.host}@${addr}`;
    const f = table[hostKey] ?? table[addr];
    if (f == null) return null;
    const spec = typeof f === 'string' ? { msg: f } : f;
    const key = `${kind}${table[hostKey] != null ? hostKey : addr}`;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (spec.skip != null && n <= spec.skip) return null;
    if (spec.times != null && n > (spec.skip || 0) + spec.times) return null;
    return spec;
  };
  return {
    type: 'modbus',
    ops,
    regs,
    hostRegs,
    failWrite,
    failRead,
    readOverride,
    async mbRequest(req) {
      const addr = Number(req.address);
      const qty = Number(req.quantity) || 1;
      const line = `R${Number(req.fc) || 3} ${who(req)} @${addr} x${qty}`;
      const f = fault(failRead, 'r', addr, req);
      if (f) { ops.push(`${line} !${f.msg}`); throw new Error(f.msg); }
      ops.push(line);
      if (readOverride[addr]) return readOverride[addr].slice(0, qty);
      const img = regsOf(req);
      return Array.from({ length: qty }, (_, i) => img.get(addr + i) ?? 0);
    },
    async mbWriteSingle(req) {
      const addr = Number(req.address);
      const line = `W6 ${who(req)} @${addr}=${req.value}`;
      const f = fault(failWrite, 'w', addr, req);
      if (f) {
        if (f.apply) regsOf(req).set(addr, req.value & 0xffff);
        ops.push(`${line} !${f.msg}`);
        throw new Error(f.msg);
      }
      ops.push(line);
      if (!ignoreWrite.includes(addr)) regsOf(req).set(addr, req.value & 0xffff);
      return { addr, value: req.value };
    },
    async mbWriteMultiple(req) {
      const addr = Number(req.address);
      const line = `W16 ${who(req)} @${addr}=[${(req.values || []).join(',')}]`;
      const f = fault(failWrite, 'w', addr, req);
      if (f) {
        if (f.apply) (req.values || []).forEach((w, i) => regsOf(req).set(addr + i, w & 0xffff));
        ops.push(`${line} !${f.msg}`);
        throw new Error(f.msg);
      }
      ops.push(line);
      if (!ignoreWrite.includes(addr)) (req.values || []).forEach((w, i) => regsOf(req).set(addr + i, w & 0xffff));
      return { addr, quantity: (req.values || []).length };
    },
  };
}

/** Grundzustand des Steuerpfads; SoC frisch zur festen Uhr. */
export function baseState({ soc = 60, socFresh = true, victron = {}, ctrl = {}, meter = {} } = {}) {
  const now = Date.now();
  return {
    meter: { ok: true, updatedAt: now, grid_total_w: 0, ...meter },
    victron: {
      soc, batteryPowerW: 0, pvTotalW: 0, errors: {}, updatedAt: now,
      fieldUpdatedAt: socFresh ? { soc: now } : { soc: now - 10 * 60_000 },
      ...victron,
    },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: { forcedOff: false, negativePriceActive: false, discretionaryWritesPaused: false, _stopBlockLogged: {}, ...ctrl },
    log: [],
  };
}

// Merker-Verzeichnisse der Bewerter; nach dem Testlauf der Datei entfernt.
const rigDirs = [];
after(() => { for (const d of rigDirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * Bewerter wie in server.js gebaut: Merker-Dateien dv_seq_saved.json / dv_seq_writeday.json liegen immer auf der
 * Platte (eigenes Temp-Verzeichnis je Rig, per ctx überschreibbar), der zweite Sungrow-WR hat seinen eigenen
 * Modbus-Pool (hier dieselbe Attrappe → EIN gemeinsames, nach Gerät getaggtes Log). events = Log-Ereignisnamen.
 */
export function evaluatorRig({ cfg, transport, state = baseState(), ctx = {}, events = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-gate-rig-'));
  rigDirs.push(dir);
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: (event) => { events.push(event); },
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null,
    regenerateSmallMarketAutomationRules: async () => {},
    dvSeqSavedPath: path.join(dir, 'dv_seq_saved.json'),
    dvSeqWritedayPath: path.join(dir, 'dv_seq_writeday.json'),
    sungrowEmsStatePath: path.join(dir, 'sungrow_ems_state.json'),
    sungrowSlaveEmsStatePath: path.join(dir, 'sungrow_ems_slave_state.json'),
    sungrowForcedHeartbeatPath: path.join(dir, 'sungrow_forced_heartbeat.json'),
    peakShavingLiftPath: path.join(dir, 'peak_shaving_lift.json'),
    sungrowSlaveTransport: transport?.type === 'modbus' ? transport : null,
    ...ctx,
  });
  return { ev, state, cfg, transport, events, dir };
}

// Ergebnis des DV-Aktuators (applyDvVictronControl gibt nichts zurück): je Flagge ok/Fehler/Haltung.
export function dvOutcome(state) {
  const d = state.ctrl.dvControl;
  if (!d) return { dv: 'none' };
  const one = (r) => {
    if (!r) return undefined;
    if (r.ok) return r.skipped ? `ok:${r.skipped}` : 'ok';
    if (r.budgetHold) return 'budgetHold';
    if (r.backoff) return 'backoff';
    return `err:${r.error}${r.stepsWritten ? `@${r.stepsWritten}` : ''}`;
  };
  const out = {};
  for (const k of ['feedExcessDcPv', 'dontFeedExcessAcPv']) if (d[k]) out[k] = one(d[k]);
  out.lastFeedIn = state.ctrl._lastDvFeedIn ?? null;
  if (state.ctrl._dvPartialBlock) out.partial = true;
  return out;
}

/**
 * Schritt-Rekorder: je Schritt die neue Draht-Folge, das Ergebnis (`ok` + Grund) und die neuen Log-Ereignisse.
 * fn darf ein Ergebnisobjekt liefern ({ ok, error|reason, writeType … }) oder ein schon geformtes Objekt.
 */
export function recorder(rig, wireOf = () => rig.transport.ops) {
  const steps = [];
  return {
    steps,
    async step(label, fn) {
      const w0 = wireOf().length;
      const e0 = rig.events.length;
      const out = { step: label };
      try {
        const res = await fn();
        if (res && typeof res === 'object') {
          if ('ok' in res) out.ok = res.ok;
          const why = res.error ?? res.reason ?? res.skipped;
          if (why != null && why !== true) out.why = String(why);
          if (res.writeType != null) out.writeType = res.writeType;
          for (const [k, v] of Object.entries(res)) {
            if (!['ok', 'error', 'reason', 'skipped', 'writeType', 'raw', 'words', 'scaled', 'wordOrder', 'fc', 'address', 'keepalive', 'heldSinceMs', 'blocked', 'emsFailure', 'readError'].includes(k)) out[k] = v;
          }
          if (res.skipped === true) out.skipped = true;
          if (res.keepalive === true) out.keepalive = true;
          if (res.blocked === true) out.blocked = true;
        }
      } catch (e) {
        out.threw = e?.message || String(e);
      }
      out.wire = wireOf().slice(w0);
      out.events = rig.events.slice(e0);
      steps.push(out);
      return out;
    },
  };
}

const GOLDEN_DIR = path.join(HERE, '..', 'fixtures', 'gate-golden');

/**
 * Golden-Datei test/fixtures/gate-golden/<name>.json mit einem Eintrag je Szenario. check(key, got) vergleicht
 * tief; mit GOLDEN_FREEZE=1 werden alle Szenarien gesammelt und die Datei am Ende des Laufs neu geschrieben —
 * NUR mit belegtem Grund (z. B. Legacy-Tor nachweislich bit-gleich), Diff vor dem Einchecken lesen.
 */
export function goldenFile(name) {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const collected = {};
  let golden = null;
  if (FREEZE) {
    after(() => {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(collected, null, 2) + '\n');
      // eslint-disable-next-line no-console
      console.error(`GOLDEN_FREEZE: ${file} neu geschrieben (${Object.keys(collected).length} Szenarien)`);
    });
  }
  return {
    check(key, got) {
      const plain = JSON.parse(JSON.stringify(got));
      if (FREEZE) { collected[key] = plain; return; }
      golden ??= JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(Object.hasOwn(golden, key), `${name}: Szenario ${key} fehlt in der Golden-Datei`);
      assert.deepEqual(plain, golden[key], `${name}/${key}: Draht-Folge/Ergebnis weicht vom eingefrorenen Stand ab — Verhaltensänderung im Schreibpfad!`);
    },
  };
}
