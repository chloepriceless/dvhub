#!/usr/bin/env node
// ios/interop/harness.mjs — echte DVhub-Gegenstelle für App- und Swift-Tests.
//
// Startet das eigenständige Relay (dvhub/services/mobile-link/relay-server.js)
// und den Box-Agenten (createMobileLink) mit nachgebildeten Werten, dazu das
// eingebettete Heimnetz-Relay unter /api/mobile-link/ws. Gibt den QR-Text aus
// und gibt jede Kopplung automatisch frei (danach gleich ein neuer QR-Code).
//
//   PATH=/opt/homebrew/opt/node@22/bin:$PATH node ios/interop/harness.mjs
//
// Umgebung:
//   HARNESS_RELAY_PORT  (Standard 18787)   HARNESS_LAN_PORT (Standard 18788)
//   HARNESS_PERMS       read | read,control (Standard read)
//   HARNESS_QR_FILE     Datei, in die der aktuelle QR-Text geschrieben wird
//   HARNESS_NO_LAN=1    QR ohne Heimnetz-Adresse (nur Relay)
//   HARNESS_APPROVE_DELAY_MS  Freigabe erst nach so vielen ms (Vergleichscode ansehen)
//   HARNESS_FULL_DAY=1  Verlauf und Historie für den ganzen heutigen Tag liefern
// Signale: SIGUSR1 = Box offline (Agent stoppen), SIGUSR2 = Box wieder online.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dvhubDir = path.resolve(here, '../../dvhub');
const require = createRequire(path.join(dvhubDir, 'package.json'));
const { WebSocketServer } = require('ws');
const { startRelayServer } = await import(path.join(dvhubDir, 'services/mobile-link/relay-server.js'));
const { createMobileLink } = await import(path.join(dvhubDir, 'services/mobile-link/agent.js'));
const { parseEvDeparturePatch } = await import(path.join(dvhubDir, 'services/optimizer/ev-departure.js'));
const { mobileIntegrationsView } = await import(path.join(dvhubDir, 'services/mobile-link/integrations-view.js'));
const { mobileAutomationConfigView, parseMobileAutomationPatch } = await import(path.join(dvhubDir, 'services/mobile-link/automation-view.js'));

const relayPort = Number(process.env.HARNESS_RELAY_PORT) || 18787;
const lanPort = Number(process.env.HARNESS_LAN_PORT) || 18788;
const perms = String(process.env.HARNESS_PERMS || 'read').split(',').map((s) => s.trim()).filter(Boolean);
const qrFile = process.env.HARNESS_QR_FILE || null;
const noLan = process.env.HARNESS_NO_LAN === '1';
const approveDelayMs = Number(process.env.HARNESS_APPROVE_DELAY_MS) || 0;
let scannedAt = 0;

const relay = startRelayServer({ port: relayPort, host: '127.0.0.1', log: () => {} });
await relay.ready;
const relayUrl = `ws://127.0.0.1:${relayPort}/v1/ws`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-harness-'));
const cfg = { httpPort: lanPort, mobileLink: { enabled: true, relayUrl, name: 'DVhub Testanlage' } };
let emergencyStop = false;

// Nachgebildete Anlage: Werte ändern sich langsam, damit Live sichtbar ist.
function compactStatus() {
  const t = Date.now() / 1000;
  const pv = Math.max(0, Math.round(4200 + 1800 * Math.sin(t / 40)));
  const load = Math.round(900 + 300 * Math.sin(t / 7));
  const battery = Math.round((pv - load) * 0.6);
  const grid = pv - load - battery;
  return {
    ts: new Date().toISOString(),
    soc: Math.round((62 + 3 * Math.sin(t / 90)) * 10) / 10,
    batteryPowerW: battery,
    pvTotalW: pv,
    gridSetpointW: -50,
    gridImportW: grid < 0 ? -grid : 0,
    gridExportW: grid > 0 ? grid : 0,
    loadW: load,
    minSocPct: 10,
    alarmsActive: 0,
    alarmsSeverity: 0,
    alarmsStale: false,
    emergencyStop,
    telemetryFrozen: false,
    supportTunnelOpen: false,
    todayNetEur: 3.21,
    todayRevenueEur: 4.05,
    todayCostEur: 0.84,
    version: 'harness',
    controls: { dv: { profile: 'plexlog', curtailed: false, limitPct: null, until: null }, negativePrice: { protection: true, active: false } },
  };
}

function series(query) {
  const u = new URLSearchParams(query);
  const keys = (u.get('keys') || 'battery_soc_pct').split(',');
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const rows = [];
  // HARNESS_FULL_DAY=1: den ganzen Tag füllen (Bildschirmfotos kurz nach Mitternacht).
  const nowMs = process.env.HARNESS_FULL_DAY === '1' ? start.getTime() + 86400_000 - 1 : Date.now();
  for (let ms = start.getTime(); ms < nowMs; ms += 900_000) {
    const h = new Date(ms).getHours() + new Date(ms).getMinutes() / 60;
    const pv = Math.max(0, Math.round(7000 * Math.sin(Math.PI * (h - 6) / 14)));
    const load = Math.round(600 + 400 * Math.abs(Math.sin(h)));
    const vals = {
      pv_total_w: h > 6 && h < 20 ? pv : 0,
      load_power_w: load,
      self_consumption_w: load,
      battery_soc_pct: Math.round(40 + 40 * Math.sin(Math.PI * (h - 4) / 20)),
      battery_power_w: Math.round(((h > 6 && h < 20 ? pv : 0) - load) * 0.5),
      grid_import_w: h < 7 ? load : 0,
      grid_export_w: h > 9 && h < 17 ? Math.round(pv * 0.3) : 0,
    };
    for (const k of keys) if (k in vals) rows.push({ key: k, ts: new Date(ms).toISOString(), value: vals[k], unit: k.endsWith('pct') ? '%' : 'W', resolution: 900 });
  }
  return { ok: true, keys, start: start.toISOString(), end: new Date(start.getTime() + 86400_000).toISOString(), total: rows.length, data: rows };
}

function eosPlan() {
  const rows = [];
  const t0 = Math.floor(Date.now() / 900_000) * 900_000;
  for (let i = 0; i < 96; i++) {
    const ms = t0 + i * 900_000;
    const h = new Date(ms).getHours() + new Date(ms).getMinutes() / 60;
    const pvWh = Math.max(0, Math.round(1600 * Math.sin(Math.PI * (h - 6) / 14)));
    const loadWh = Math.round(150 + 100 * Math.abs(Math.sin(h)));
    rows.push({ ts_utc: new Date(ms).toISOString(), socPct: Math.round(30 + 50 * Math.sin(Math.PI * (h - 5) / 18) ** 2), pvWh, loadWh,
      gridFeedinWh: Math.round(pvWh * 0.4), gridConsumptionWh: pvWh < loadWh && (h < 6 || h > 22) ? loadWh - pvWh : 0, priceCtKwh: spotCt(ms),
      zeitplanLabel: h >= 11 && h < 14 ? 'Akku ins Netz entladen' : (h >= 2 && h < 4 ? 'Akku aus dem Netz laden' : null) });
  }
  return { ok: true, available: true, reason: null, output: { slotMinutes: 15, rows, truncated: false, totalCount: rows.length }, plan: { fetchedAt: new Date().toISOString() } };
}

// ── Nachgebildete Antworten der lesenden Endpunkte (Form wie der Server) ──

const demoNow = () => (process.env.HARNESS_FULL_DAY === '1' ? dayStart(1).getTime() - 1 : Date.now());
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
function dayStart(offsetDays = 0) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offsetDays); return d; }
function localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
// Börsenpreis in ct/kWh: Morgen- und Abendspitze, mittags tief (auch negativ).
function spotCt(ms) {
  const h = new Date(ms).getHours() + new Date(ms).getMinutes() / 60;
  return round(9 + 7 * Math.exp(-((h - 7.5) ** 2) / 5) + 11 * Math.exp(-((h - 18.5) ** 2) / 6) - 10.5 * Math.exp(-((h - 13) ** 2) / 7), 2);
}

function fullStatus() {
  const c = compactStatus();
  const now = Date.now();
  const epexData = [], slots = [];
  for (let ms = dayStart(0).getTime(); ms < dayStart(2).getTime(); ms += 900_000) {
    const ct = spotCt(ms);
    epexData.push({ ts: ms, day: localDate(new Date(ms)), eur_mwh: round(ct * 10, 1), ct_kwh: ct });
    slots.push({ ts: ms, exportPriceCtKwh: ct, importPriceCtKwh: round((ct + 1.5 + 9.1 + 4.2) * 1.19, 2) });
  }
  const cur = slots.find((x) => x.ts <= now && now < x.ts + 900_000) || slots[0];
  const toHome = Math.min(c.pvTotalW, c.loadW);
  const charge = Math.max(0, c.batteryPowerW), discharge = Math.max(0, -c.batteryPowerW);
  return {
    ok: true, harness: true, now, timeZone: 'Europe/Berlin',
    victron: {
      updatedAt: now, connected: true, soc: c.soc, batteryPowerW: c.batteryPowerW,
      pvPowerW: Math.round(c.pvTotalW * 0.65), pvAcW: Math.round(c.pvTotalW * 0.35), pvTotalW: c.pvTotalW,
      acPvL1W: Math.round(c.pvTotalW * 0.12), acPvL2W: Math.round(c.pvTotalW * 0.12), acPvL3W: Math.round(c.pvTotalW * 0.11),
      gridSetpointW: c.gridSetpointW, maxDischargeW: -1, minSocPct: c.minSocPct,
      gridImportW: c.gridImportW, gridExportW: c.gridExportW, selfConsumptionW: c.loadW,
      batteryChargeW: charge, batteryDischargeW: discharge,
      solarDirectUseW: toHome, solarToBatteryW: Math.min(charge, c.pvTotalW - toHome), solarToGridW: c.gridExportW,
      gridDirectUseW: c.gridImportW, gridToBatteryW: 0, batteryDirectUseW: discharge, batteryToGridW: 0,
    },
    meter: { ok: true, updatedAt: now, grid_l1_w: -Math.round(c.gridExportW * 0.4), grid_l2_w: -Math.round(c.gridExportW * 0.35), grid_l3_w: -Math.round(c.gridExportW * 0.25) + c.gridImportW,
      grid_total_w: c.gridImportW - c.gridExportW, semantics: { positiveMeans: 'grid_import' } },
    gridVoltage: { ok: true, l1: 231.4, l2: 229.8, l3: 232.1, frequencyHz: 50.01, updatedAt: now, source: 'meter' },
    costs: { day: localDate(new Date()), importWh: 1840, exportWh: 21300, importKwh: 1.84, exportKwh: 21.3, costEur: c.todayCostEur, revenueEur: c.todayRevenueEur, netEur: c.todayNetEur,
      priceNowCtKwh: cur.exportPriceCtKwh, userImportPriceNowCtKwh: cur.importPriceCtKwh },
    userEnergyPricing: { configured: true, mode: 'dynamic', usesParagraph14aModule3: false,
      dynamicComponents: { energyMarkupCtKwh: 1.5, gridChargesCtKwh: 9.1, leviesAndFeesCtKwh: 4.2, vatPct: 19 },
      costs: { pvCtKwh: 6.4, batteryBaseCtKwh: 2, batteryLossMarkupPct: 20, batteryEffectiveCtKwh: 10.1 }, current: cur, slots },
    epex: { ok: true, bzn: 'DE-LU', date: localDate(dayStart(0)), nextDate: localDate(dayStart(1)), updatedAt: now - 1800_000, activeSource: 'dvhub.online', data: epexData,
      summary: { todayMin: -12, todayMax: 205, tomorrowMin: -12, tomorrowMax: 205, hasFutureNegative: true } },
    schedule: scheduleState(),
    emergencyStop: { active: emergencyStop, pausedAt: null, reason: null },
    victronAlarms: { configured: true, active: [], updatedAt: new Date(now).toISOString(), ageMs: 2000, stale: false, severity: 0 },
    systemWarnings: [],
    runtime: { ready: true, busy: false, mode: 'worker' },
    telemetry: { enabled: true, ok: true, lastWriteAt: now - 4000 },
  };
}

// Zeitplan, Börsenautomatik und E-Auto halten ihren Stand: Die App schreibt
// hinein (POST) und liest ihn danach wieder. Form und Regeln wie routes-api.js.
const scheduleRules = [
  { id: 'opt-1-0', enabled: true, target: 'gridSetpointW', start: '11:00', end: '14:00', value: -3000, source: 'forecast_optimizer', slotTs: Date.now() },
  { id: 'sma-1', enabled: true, target: 'gridSetpointW', start: '18:00', end: '18:15', value: -4000, source: 'small_market_automation' },
  { id: 'grid_1', enabled: false, target: 'gridSetpointW', start: '00:00', end: '05:00', value: 2000, stopSocPct: 80, _wasActive: false },
];
const scheduleConfig = { defaultGridSetpointW: -50, defaultChargeCurrentA: 70, defaultFeedExcessDcPv: 1 };
// Mit Standort als Köder: Die App bekommt die Config nur durch die echte Sicht für die App.
const automationConfig = { enabled: false, searchWindowStart: '14:00', searchWindowEnd: '09:00', targetSlotCount: 4, maxDischargeW: -12000, minSocPct: 20,
  location: { label: 'koeder-ort', latitude: 53.55, longitude: 9.99 }, stages: [{ dischargeW: -9000, dischargeSlots: 2 }] };
const isAutomationRule = (r) => r.source === 'small_market_automation' || r.source === 'forecast_optimizer' || /^(sma-|opt-)/.test(String(r.id || ''));
function scheduleState() {
  return { config: scheduleConfig, rules: scheduleRules,
    active: { gridSetpointW: { value: -50, source: 'default', at: Date.now() - 60_000 }, minSocPct: { value: 10, source: 'default', at: Date.now() - 60_000 } },
    lastWrite: { gridSetpointW: { value: -50, source: 'default', writeType: 'holding', at: Date.now() - 60_000 } },
    smallMarketAutomation: { lastRunDate: localDate(new Date()), lastOutcome: 'ok', generatedRuleCount: scheduleRules.filter((r) => r.source === 'small_market_automation').length } };
}

const evOpt = { optimizeEv: true, onlyWhenPlugged: true, enabled: true, once: '', onceMinSocPct: null, maxSocPct: 80, minSocPct: 60,
  weekly: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, departure: day <= 5 ? '07:00' : '', homeFrom: day <= 5 ? '18:00' : '', homeFromPrevDay: day <= 5, minSocPct: day === 5 ? 90 : null, tripSocPct: day <= 5 ? 25 : null })) };
function evState() {
  const next = new Date(dayStart(1).getTime() + 7 * 3600_000);
  const once = evOpt.once && Date.parse(evOpt.once) > Date.now() ? evOpt.once : '';
  return { ok: true, optimizeEv: evOpt.optimizeEv, onlyWhenPlugged: evOpt.onlyWhenPlugged, chargerConfigured: true,
    departure: { enabled: evOpt.enabled, once, onceMinSocPct: once ? evOpt.onceMinSocPct : null, maxSocPct: evOpt.maxSocPct, defaultMinSocPct: evOpt.minSocPct,
      weeklyDepartures: evOpt.weekly, targetMode: 'percent', targetValue: evOpt.minSocPct,
      resolved: { enabled: evOpt.enabled || !!once, departureAt: once || (evOpt.enabled ? next.toISOString() : null), source: once ? 'once' : (evOpt.enabled ? 'weekly' : null),
        targetSocPct: once ? evOpt.onceMinSocPct : evOpt.minSocPct } },
    vehicle: { title: 'E-Auto', connected: true, charging: false, chargePowerW: 0, socPct: 64, rangeKm: 268, plugged: true },
    plan: evOpt.optimizeEv ? { hasEv: true, energyKwh: 12.4, socAtDeparture: Math.max(64, evOpt.minSocPct) } : null, planError: null,
    override: currentOverride(), overrideLimits: OVERRIDE_LIMITS, lastCommandError: null };
}

// „Sofort laden“ / „Laden stoppen“ (POST/DELETE /api/ev/override), geprüft wie normalizeOverride auf der Box.
const OVERRIDE_LIMITS = { minPowerW: 4140, maxPowerW: 11000 };
let evOverride = null;
function currentOverride() {
  if (evOverride?.until && Date.parse(evOverride.until) <= Date.now()) evOverride = null;
  return evOverride ? { ...evOverride, ...OVERRIDE_LIMITS } : null;
}
function setOverride(body) {
  const bad = (error) => ({ status: 400, body: { ok: false, error } });
  let untilMs = null;
  if (body.untilMs != null) untilMs = Number(body.untilMs);
  else if (body.durationMin != null) {
    const d = Number(body.durationMin);
    if (!Number.isFinite(d) || d <= 0) return bad('durationMin must be > 0');
    untilMs = Date.now() + d * 60_000;
  }
  if (untilMs != null && (!Number.isFinite(untilMs) || untilMs <= Date.now())) return bad('until must lie in the future');
  if (untilMs != null && untilMs > Date.now() + 48 * 3600_000) return bad('until must be within 48 h');
  const until = untilMs == null ? null : new Date(untilMs).toISOString();
  const startedAt = new Date().toISOString();
  if (body.kind === 'stop') evOverride = { kind: 'stop', powerW: 0, requestedW: 0, startedAt, until, seenConnected: false };
  else {
    const p = Number(body.powerW);
    if (!Number.isFinite(p) || p <= 0) return bad('powerW must be > 0');
    evOverride = { kind: 'charge', powerW: Math.round(Math.min(OVERRIDE_LIMITS.maxPowerW, Math.max(OVERRIDE_LIMITS.minPowerW, p))), requestedW: Math.round(p), startedAt, until, seenConnected: false };
  }
  return { status: 200, body: { ok: true, override: evOverride } };
}
// POST /api/ev: nur die Felder im Körper, mit denselben Grenzen wie die Box (ev-departure.js).
function evPatch(body) {
  const bad = (error) => ({ status: 400, body: { ok: false, error } });
  let changed = 0;
  if ('optimizeEv' in body) { evOpt.optimizeEv = body.optimizeEv === true; changed++; }
  if ('onlyWhenPlugged' in body) { evOpt.onlyWhenPlugged = body.onlyWhenPlugged === true; changed++; }
  const d = body.departure;
  if (d != null) {
    if (typeof d !== 'object') return bad('departure must be an object');
    if ('enabled' in d) { evOpt.enabled = d.enabled === true; changed++; }
    if ('targetValue' in d) { const v = Number(d.targetValue); if (!Number.isFinite(v) || v < 0 || v > 2000) return bad('departure.targetValue must be 0..2000'); evOpt.minSocPct = v; changed++; }
    if ('maxSocPct' in d) { const v = d.maxSocPct; if (v !== null && (!(Number(v) >= 10) || Number(v) > 100)) return bad('departure.maxSocPct must be 10..100 or empty'); evOpt.maxSocPct = v === null ? null : Math.round(Number(v)); changed++; }
    if ('once' in d) {
      if (d.once !== '' && !Number.isFinite(Date.parse(d.once))) return bad('departure.once must be an ISO date time or empty');
      if (d.once !== '' && Date.parse(d.once) - 30 * 60_000 <= Date.now()) return bad('departure.once must be more than 30 min in the future');
      evOpt.once = d.once; changed++;
    }
    if ('onceMinSocPct' in d) { const v = d.onceMinSocPct; if (v !== null && !(Number(v) >= 0 && Number(v) <= 100)) return bad('departure.onceMinSocPct must be 0..100 or empty'); evOpt.onceMinSocPct = v === null ? null : Number(v); changed++; }
    if ('weeklyDepartures' in d) {
      // Geprüft und geordnet mit dem echten Code der Box (ev-departure.js).
      const parsed = parseEvDeparturePatch({ weeklyDepartures: d.weeklyDepartures }, 'departure', { opt: {}, nowMs: Date.now() });
      if (!parsed.ok) return bad(parsed.error);
      evOpt.weekly = parsed.patch.evWeeklyDepartures; changed++;
    }
  }
  if (!changed) return bad('nothing to change');
  return { status: 200, body: { ok: true } };
}

// Die große Übersicht der Weboberfläche — mit Adressen und Kennungen als Köder.
// Die App bekommt sie nur durch die echte Sicht für die App (mobileIntegrationsView).
function integrationsStatus() {
  return {
    timestamp: Date.now(),
    mqtt: { enabled: true, connected: true, broker: 'mqtt://10.11.12.13:1883', embedded: false, topicCount: 148, config: { username: 'koeder-user', passwordSet: true, brokerUrl: 'mqtt://10.11.12.13:1883' } },
    tesla: { enabled: true, state: { battery_level: 64, latitude: 53.55, longitude: 9.99 }, lastUpdate: Date.now() - 90_000, config: { name: 'Model Y' } },
    homeAssistant: { haDiscovery: true, topicsPublished: 148 },
    victron: { host: '10.11.12.14', modelId: 'MultiPlus-II 48/5000', firmware: 'v3.60' },
    mid: { serial: 'KOEDER-4711', host: '10.11.12.15', port: 502, configured: true, firmware: '1.4' },
    dveos: { enabled: true, primarySource: 'eos', active: true, url: 'http://10.11.12.16:8503' },
    luox: { identifier: null, firmware: null }, loxone: { configured: false },
    devices: { total: 2, online: 2, list: [{ id: 'd1', host: '10.11.12.17' }] },
    notifications: { enabled: true, providers: [{ name: 'ntfy', enabled: true }, { name: 'telegram', enabled: false }] },
    vrm: { enabled: true, vrmPortalId: 'koederportal', vrmTokenSet: true },
    'forecast-providers': { solcast: { enabled: false, apiKeySet: false, siteIdSet: false }, pvnode: { enabled: true, apiKeySet: true, siteIdSet: true, nowcastEnabled: true } },
    evcc: { url: 'http://10.11.12.18:7070', reachable: true, loadpointCount: 1, wallboxType: 'evcc', lastError: null, charger: null },
    p14a: { available: true, active: false, source: null, limitW: null, pminW: 4200, n: 1, devices: 1, relayEnabled: false },
    eebus: { enabled: false, status: 'disabled', statusLabel: 'aus', gridPeer: false, gridConnected: false, gridStateLabel: null, devices: 0 },
    schedulable: { total: 2, deferrable: 1, modulating: 1, eosActive: true },
    pvstrings: { enabled: true, sourceCount: 3, groupCount: 1, lastSyncAt: Date.now() - 600_000, lastError: null, backfillRunning: false },
  };
}

// Eine Viertelstunde der nachgebildeten Anlage (kWh und €).
function slotEnergy(ms) {
  const h = new Date(ms).getHours() + new Date(ms).getMinutes() / 60;
  const pv = h > 6 && h < 20 ? Math.max(0, 7 * Math.sin(Math.PI * (h - 6) / 14)) / 4 : 0;
  const load = (0.6 + 0.4 * Math.abs(Math.sin(h))) / 4;
  const direct = Math.min(pv, load);
  const toBat = h < 13 ? (pv - direct) * 0.6 : 0;
  const toGrid = pv - direct - toBat;
  const fromBat = pv < load && h > 16 ? (load - direct) * 0.8 : 0;
  const imp = load - direct - fromBat;
  const ct = spotCt(ms), importCt = (ct + 14.8) * 1.19;
  return { pvKwh: pv, loadKwh: load, importKwh: imp, exportKwh: toGrid, solarDirectUseKwh: direct, solarToBatteryKwh: toBat, solarToGridKwh: toGrid,
    gridDirectUseKwh: imp, gridToBatteryKwh: 0, batteryDirectUseKwh: fromBat, batteryToGridKwh: 0, batteryChargeKwh: toBat, batteryDischargeKwh: fromBat,
    exportRevenueEur: toGrid * ct / 100, gridCostEur: imp * importCt / 100, avoidedImportGrossEur: (direct + fromBat) * importCt / 100,
    netEur: toGrid * ct / 100 - imp * importCt / 100, marketPriceCtKwh: ct, userImportPriceCtKwh: round(importCt, 2) };
}

function sumSlots(startMs, endMs) {
  const acc = {};
  for (let ms = startMs; ms < Math.min(endMs, demoNow()); ms += 900_000) {
    const e = slotEnergy(ms);
    for (const k of Object.keys(e)) if (!k.endsWith('CtKwh')) acc[k] = (acc[k] || 0) + e[k];
  }
  for (const k of Object.keys(acc)) acc[k] = round(acc[k], 3);
  return acc;
}

function historySummary(query) {
  const u = new URLSearchParams(query);
  const view = u.get('view') || 'day';
  const date = u.get('date') || localDate(new Date());
  const [y, m, d] = date.split('-').map(Number);
  const anchor = new Date(y, m - 1, d);
  let start, end, rows = [];
  if (view === 'day') {
    start = anchor; end = new Date(y, m - 1, d + 1);
  } else if (view === 'week') {
    const dow = (anchor.getDay() + 6) % 7;
    start = new Date(y, m - 1, d - dow); end = new Date(y, m - 1, d - dow + 7);
  } else if (view === 'month') {
    start = new Date(y, m - 1, 1); end = new Date(y, m, 1);
  } else {
    start = new Date(y, 0, 1); end = new Date(y + 1, 0, 1);
  }
  if (view === 'year') {
    for (let mo = 0; mo < 12; mo++) {
      const a = new Date(y, mo, 1), b = new Date(y, mo + 1, 1);
      if (a.getTime() > Date.now()) break;
      // Jahresgang: im Sommer mehr PV.
      const season = 0.35 + 0.65 * Math.sin(Math.PI * (mo + 0.5) / 12) ** 2;
      const base = sumSlots(dayStart(-1).getTime(), dayStart(0).getTime());
      const days = Math.round((Math.min(b.getTime(), Date.now()) - a.getTime()) / 86400_000);
      const row = { key: `${y}-${String(mo + 1).padStart(2, '0')}`, label: `${String(mo + 1).padStart(2, '0')}/${y}` };
      for (const k of Object.keys(base)) row[k] = round(base[k] * days * (k.startsWith('pv') || k.startsWith('solar') || k.startsWith('export') ? season * 1.6 : 1), 2);
      row.netEur = round(row.exportRevenueEur - row.gridCostEur, 2);
      rows.push(row);
    }
  } else if (view !== 'day') {
    for (let t = new Date(start); t < end && t.getTime() <= Date.now(); t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)) {
      const wobble = 0.55 + 0.45 * Math.abs(Math.sin(t.getDate() * 1.7));
      const base = sumSlots(t.getTime(), t.getTime() + 86400_000);
      const row = { key: localDate(t), label: `${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}.` };
      for (const k of Object.keys(base)) row[k] = round(base[k] * (k.startsWith('pv') || k.startsWith('solar') || k.startsWith('export') ? wobble : 1), 3);
      row.netEur = round(row.exportRevenueEur - row.gridCostEur, 2);
      rows.push(row);
    }
  }
  let kpis;
  const charts = {};
  if (view === 'day') {
    kpis = sumSlots(start.getTime(), end.getTime());
    charts.dayEnergyLines = []; charts.dayFinancialLines = []; charts.dayPriceLines = [];
    for (let ms = start.getTime(); ms < Math.min(end.getTime(), demoNow()); ms += 900_000) {
      const e = slotEnergy(ms), ts = new Date(ms).toISOString();
      charts.dayEnergyLines.push({ ts, pvKwh: round(e.pvKwh), loadKwh: round(e.loadKwh), importKwh: round(e.importKwh), exportKwh: round(e.exportKwh), estimated: false, incomplete: false });
      charts.dayFinancialLines.push({ ts, gridCostEur: round(e.gridCostEur, 4), exportRevenueEur: round(e.exportRevenueEur, 4), netEur: round(e.netEur, 4) });
      charts.dayPriceLines.push({ ts, marketPriceCtKwh: e.marketPriceCtKwh, userImportPriceCtKwh: e.userImportPriceCtKwh });
    }
  } else {
    kpis = {};
    for (const r of rows) for (const [k, v] of Object.entries(r)) if (typeof v === 'number') kpis[k] = round((kpis[k] || 0) + v, 3);
  }
  kpis.gridShareKwh = kpis.gridDirectUseKwh;
  kpis.cycles = round((kpis.batteryChargeKwh || 0) / 15, 2);
  kpis.pvFullLoadHours = round((kpis.pvKwh || 0) / 20, 1);
  kpis.avgSpotPriceCtKwh = 11.6;
  kpis.dvNetAdvantageEur = view === 'day' ? null : round((kpis.exportRevenueEur || 0) * 0.12, 2);
  // Ohne lean=1 kämen noch slots/series/rows je Viertelstunde dazu — der Harness liefert immer die schlanke Form.
  return { view, date, range: { startDate: localDate(start), endDateExclusive: localDate(end) }, kpis, series: { financial: [], energy: [], prices: [] }, charts, rows: view === 'day' ? [] : rows, slots: [], meta: {} };
}

const READ = {
  '/api/status': () => fullStatus(),
  '/api/telemetry/series': (q) => series(q),
  '/api/eos/plan': () => eosPlan(),
  '/api/costs': () => ({ ok: true, netEur: 3.21 }),
  '/api/schedule': () => scheduleState(),
  '/api/history/summary': (q) => historySummary(q),
  '/api/integrations/health': () => ({
    victron: { latencyMs: 38, uptimeSec: 86400, errors24h: 0, lastSampleAt: new Date(Date.now() - 3000).toISOString(), firmware: 'v3.62', status: 'ok', statusReason: 'ok' },
    epex: { latencyMs: 412, uptimeSec: 86400, errors24h: 1, lastSampleAt: new Date(Date.now() - 1800_000).toISOString(), firmware: null, status: 'ok', statusReason: 'ok' },
    featured: { victronHeartbeatSec: 3, victronEssMode: 3 },
  }),
  '/api/integrations/dataflow': () => {
    const c = compactStatus();
    return { ok: true, generatedAt: new Date().toISOString(), profile: 'victron',
      in: { source: { kind: 'modbus', label: 'Victron GX (Modbus TCP)' }, inputs: [] },
      seen: [
        { key: 'grid', label: 'Netz', value: c.gridImportW - c.gridExportW, unit: 'W', note: 'Einspeisung (Vorzeichen: + = Bezug)' },
        { key: 'pvTotalW', label: 'PV gesamt', value: c.pvTotalW, unit: 'W' },
        { key: 'batteryPowerW', label: 'Akku (Laden +)', value: c.batteryPowerW, unit: 'W' },
        { key: 'soc', label: 'Ladestand', value: c.soc, unit: '%' },
        { key: 'selfConsumptionW', label: 'Hausverbrauch', value: c.loadW, unit: 'W', note: 'berechnet aus Energiebilanz' },
      ],
      checks: [],
      out: { control: { source: 'schedule', rule: null, updatedAt: Date.now() - 60_000, paused: emergencyStop, rows: [
        { key: 'gridSetpointW', label: 'Netz-Sollwert', unit: 'W', value: -50, source: 'default' },
        { key: 'minSocPct', label: 'Mindest-Ladestand', unit: '%', value: 10, source: 'default' } ] },
        dvSignal: { value: 1, forcedOff: false }, gridLimit: null,
        lastWrites: [{ key: 'gridSetpointW', value: -50, writeType: 'holding', source: 'default', at: Date.now() - 60_000 }], channels: [] } };
  },
  '/api/eos/status': () => ({ ok: true, status: 'up', version: '0.3.0.dev2611101200', dvhubEos: { build: '0.3.0.dev2611101200-dvhub.2', nativeCore: '0.2.0', label: 'DVhub-EOS 0.3.0.dev2611101200-dvhub.2 · Rust-Kern 0.2.0' }, enabled: true, reachable: true, lastOkAt: new Date(Date.now() - 20_000).toISOString(),
    solutionAt: new Date(Date.now() - 1500_000).toISOString(), restarts: 0, push: { active: true, count: 12 } }),
  '/api/vpn/status': () => ({ enabled: true, status: 'connected', protocol: 'openvpn', uptimeSeconds: 93600, reconnectAttempts: 0, certDaysRemaining: 212, watchdogOk: true,
    lastModbusActivity: { ts: Date.now() - 45_000, fc: 3, addr: 0, qty: 2 } }),
  '/api/devices': () => ([
    { id: 'd1', name: 'Heizstab', powerW: 0, energyTodayWh: 2400, online: true, managed: true },
    { id: 'd2', name: 'Poolpumpe', powerW: 410, energyTodayWh: 1900, online: true, managed: true },
  ]),
  '/api/victron/devices': () => ({ ok: true, supported: true, scannedAt: Date.now() - 3600_000, scanning: false, scanError: null, devices: [
    { kind: 'evcharger', unitId: 40, label: 'Wallbox', statusText: 'bereit', connected: false, charging: false, powerW: 0, sessionEnergyKwh: 0, error: null } ] }),
  '/api/ev': () => evState(),
  '/api/schedule/automation/config': () => ({ ok: true, config: mobileAutomationConfigView(automationConfig), optimizerEnabled: true, globalMinSocPct: 10 }),
  '/api/mobile-link/integrations': () => mobileIntegrationsView(integrationsStatus()),
  '/api/feed-in-cap/status': () => ({ ok: true, mode: 'static', configured: true, limitW: 16200, pct: 60, kwp: 27, path: 'native', effectiveW: 16200,
    monitor: { exceeding: false, current: null, episodes: 0, lastEpisode: null } }),
  '/api/storage/status': () => ({ ok: true, at: Date.now(), freePct: 61, freeMb: 18200, totalMb: 29800, level: 'ok', dbMb: 2350, actions: [] }),
};

async function loopback(method, p, bodyText) {
  const [pathname, query = ''] = p.split('?');
  if (method === 'GET' && READ[pathname]) return { status: 200, body: READ[pathname](query) };
  if (method === 'POST' && pathname === '/api/control/stop') { emergencyStop = true; return { status: 200, body: { ok: true, emergencyStop: true } }; }
  if (method === 'POST' && pathname === '/api/control/resume') { emergencyStop = false; return { status: 200, body: { ok: true, emergencyStop: false } }; }
  if (method === 'DELETE' && pathname === '/api/ev/override') {
    console.log(`[box] DELETE ${pathname}`);
    evOverride = null;
    return { status: 200, body: { ok: true, override: null } };
  }
  if (method === 'POST') {
    let body;
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { return { status: 400, body: { ok: false, error: 'invalid json' } }; }
    console.log(`[box] POST ${pathname} ${JSON.stringify(body)}`);
    if (pathname === '/api/ev') return evPatch(body);
    if (pathname === '/api/ev/override') return setOverride(body);
    // Wie die Box: Der Körper ersetzt alle Regeln von Hand; Plan-Regeln bleiben, wie sie sind.
    if (pathname === '/api/schedule/rules') {
      if (!Array.isArray(body.rules) || body.rules.some((r) => !r || typeof r.target !== 'string' || (r.value !== undefined && !Number.isFinite(Number(r.value))))) return { status: 400, body: { ok: false, error: 'invalid rule structure' } };
      const keep = scheduleRules.filter(isAutomationRule);
      scheduleRules.splice(0, scheduleRules.length, ...body.rules.filter((r) => !isAutomationRule(r)), ...keep);
      return { status: 200, body: { ok: true, count: scheduleRules.length } };
    }
    if (pathname === '/api/schedule/rules/toggle') {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (!ids.length || typeof body.enabled !== 'boolean') return { status: 400, body: { ok: false, error: 'ids array required' } };
      const hit = scheduleRules.filter((r) => ids.includes(r.id));
      if (!hit.length) return { status: 404, body: { ok: false, error: 'no matching rules' } };
      for (const r of hit) r.enabled = body.enabled;
      return { status: 200, body: { ok: true, toggled: hit.length } };
    }
    if (pathname === '/api/schedule/config') {
      for (const k of ['defaultGridSetpointW', 'defaultChargeCurrentA', 'defaultFeedExcessDcPv']) {
        if (body[k] === undefined) continue;
        if (!Number.isFinite(Number(body[k]))) return { status: 400, body: { ok: false, error: `${k} invalid` } };
        scheduleConfig[k] = Number(body[k]);
      }
      return { status: 200, body: { ok: true, config: scheduleConfig } };
    }
    if (pathname === '/api/schedule/automation/config') {
      const parsed = parseMobileAutomationPatch(body);
      if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
      Object.assign(automationConfig, parsed.patch);
      return { status: 200, body: { ok: true, config: mobileAutomationConfigView(automationConfig) } };
    }
    if (pathname === '/api/schedule/automation/replan') {
      const n = automationConfig.enabled ? 2 : 0;
      const keep = scheduleRules.filter((r) => r.source !== 'small_market_automation');
      const made = Array.from({ length: n }, (_, i) => ({ id: `sma-${i + 1}`, enabled: true, target: 'gridSetpointW', start: `18:${String(i * 15).padStart(2, '0')}`, end: `18:${String(i * 15 + 15).padStart(2, '0')}`, value: automationConfig.maxDischargeW, source: 'small_market_automation' }));
      scheduleRules.splice(0, scheduleRules.length, ...keep, ...made);
      return { status: 200, body: { ok: true, generatedRuleCount: n, availableEnergyKwh: 8.4, lastOutcome: 'ok', plan: null } };
    }
  }
  return { status: 404, body: { ok: false, error: 'harness_not_found', method, path: p, body: bodyText ? JSON.parse(bodyText) : null } };
}

let agent = null;
function makeAgent() {
  const a = createMobileLink({
    getCfg: () => cfg, getDataDir: () => dataDir,
    pushLog: (e, d) => console.log(`[box] ${e} ${JSON.stringify(d || {})}`),
  }, {
    buildStatus: compactStatus,
    loopback,
    // Heimnetz-Adresse der Testbox: der Mac selbst (Simulator teilt das Netz).
    networkHosts: () => (noLan ? [] : ['127.0.0.1']),
  });
  a.start();
  return a;
}

// Heimnetz-Weg: eingebettetes Relay hinter einem eigenen HTTP-Server.
const lanServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
lanServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/api/mobile-link/ws' || !agent) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => agent.attachLan(ws, { remote: req.socket.remoteAddress }));
});
await new Promise((r) => lanServer.listen(lanPort, '127.0.0.1', r));

let lastPairingAt = 0;
let approveToken = null;
function newPairing() {
  lastPairingAt = Date.now();
  // Testläufe koppeln oft: an der Gerätegrenze das älteste Testgerät entfernen.
  const st = agent.status();
  if (st.devices.length >= st.maxDevices) agent.removeDevice(st.devices[0].id);
  const p = agent.startPairing({ lanHost: null });
  approveToken = p.approveToken;
  let qr = p.qr;
  if (noLan) {
    // Heimnetz-Adressen aus dem QR-Inhalt entfernen (nur Relay testen).
    const q = new URLSearchParams(qr.slice('dvhub://pair?'.length));
    q.delete('l');
    qr = 'dvhub://pair?' + q.toString();
  }
  console.log(`QR=${qr}`);
  if (qrFile) fs.writeFileSync(qrFile, qr + '\n');
}

agent = makeAgent();
// Kurz warten, bis das Relay die Box kennt, dann ersten QR ausgeben.
await new Promise((r) => setTimeout(r, 300));
newPairing();

// Freigabe automatisch, danach sofort neuer QR-Code.
setInterval(() => {
  if (!agent) return;
  const st = agent.status();
  if (st.pairing?.status === 'scanned') {
    if (!scannedAt) scannedAt = Date.now();
    if (Date.now() - scannedAt < approveDelayMs) return;
    scannedAt = 0;
    // Vergleichscode der Box für die Swift-Tests ablegen (gleich wie in der App?).
    if (qrFile) fs.writeFileSync(`${qrFile}.code`, String(st.pairing.candidate?.code ?? st.pairing.code ?? ''));
    try {
      agent.approvePairing({ perms, approveToken });
    } catch (e) {
      console.log(`[harness] Freigabe fehlgeschlagen: ${e.message}`);
    }
  } else if (!st.pairing && Date.now() - lastPairingAt > 700) {
    newPairing();
  }
}, 200).unref();
// Briefkasten oft füllen, damit der Offline-Fall schnell testbar ist.
setInterval(() => agent?._pushMailboxLatest(), 3000).unref();

console.log(`RELAY=${relayUrl}`);
console.log(`LAN=ws://127.0.0.1:${lanPort}/api/mobile-link/ws`);
console.log(`PERMS=${perms.join(',')}`);
console.log('READY');

// Box offline/online schalten: Store bleibt (gleicher Datenordner).
process.on('SIGUSR1', () => {
  console.log('[harness] Box offline');
  agent?.stop();
  agent = null;
  // Der alte QR-Code gilt nicht mehr (Kopplung lebt nur im laufenden Agenten).
  if (qrFile) fs.writeFileSync(qrFile, '');
});
process.on('SIGUSR2', () => { if (!agent) { console.log('[harness] Box online'); agent = makeAgent(); } });
const stop = async () => { agent?.stop(); await relay.close(); lanServer.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
