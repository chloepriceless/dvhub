// services/installer-portal-client.js — ausgehender Kopplungspfad zur
// Installateurs-Portal-Instanz (T-INSTALLER-PORTAL, NAT-Modell).
//
// Warum ausgehend? Kunden sitzen hinter Router/Firewall — das Online-Portal
// kann die Anlage nicht anwählen. Also dreht die Anlage den Spieß um:
//
//   1. Portal: Installateur trägt die Appliance-ID ein → Portal erzeugt
//      Kopplungs-Code (der "Token, den man online bekommt").
//   2. Anlage (Kunden-UI): Portal-URL + Code eintragen → POST /api/installer/
//      client/pair → DIESER Service wählt sich AUSGEHEND zum Portal
//      (POST /api/pair/claim) und erhält ein langlebiges Appliance-Token.
//   3. Portal: Installateur gibt die Anfrage manuell frei.
//   4. Betrieb: Die Anlage pollt alle 30 s das Portal (x-appliance-token) und
//      liefert ihren Kompakt-Status mit; das Portal antwortet mit Kommandos
//      (Tunnel öffnen/schließen, Update-Check), die die Anlage gegen ihre
//      eigenen Loopback-Endpunkte ausführt und deren Ergebnis zurückliefert.
//
// Firewall-Freundlich: nur ausgehendes HTTPS (bzw. http:// zu Testzwecken ins
// lokale Netz). Kein Portforwarding, kein DNS, kein öffentlicher Endpunkt.
//
// Persistenz: ${DATA_DIR}/installer-portal-client.json (Sidecar, analog dem
// Support-Tunnel-Sidecar — config.json wird bei jedem UI-Save überschrieben,
// das Portal-Token muss einen Neustart überleben).

import fs from 'node:fs';
import { AUDIT_ERROR_SQL } from './log-retention.js';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { readApplianceId, validateRelayPorts } from './support-tunnel.js';
import { runtimeInfo } from '../runtime-info.js';
import { buildVictronAlarmsPayload } from '../victron-alarms.js';
import { isPrivateOrLoopbackHost } from './host-address.js';
import { isReadOnlyMode } from '../read-only-guard.js';

export const SIDECAR_NAME = 'installer-portal-client.json';
// Vorgemerkte Abmeldung beim Portal (2026-10-15): war das Portal beim Trennen
// nicht erreichbar, blieb die Anlage dort als Karteileiche „verbunden“. Die Box
// wiederholt die Abmeldung im Poll-Takt, bis das Portal sie bestätigt.
export const RELEASE_PENDING_NAME = 'installer-portal-release.json';
const RELEASE_GIVE_UP_MS = 30 * 86400_000;   // danach zeigt das Portal sie ohnehin als verwaist
export const POLL_INTERVAL_MS_DEFAULT = 30_000;
export const PAIRING_CODE_RE = /^\d{6}$/;
export const COMMAND_TYPES = ['open_tunnel', 'close_tunnel', 'updates_check', 'license_activate'];
// Ohne Pro-Lizenz erlaubt: Lizenz einspielen und Tunnel schließen.
const LICENSE_FREE_COMMANDS = new Set(['license_activate', 'close_tunnel']);

// URL-Validierung für die Portal-Adresse (SSRF-Bremse beim Pairing):
//   https:// ist überall erlaubt (Portal ist online),
//   http://  nur zur Box selbst oder ins Heimnetz (services/host-address.js)
//            — für lokale Tests & LAN-Portal-Bau.
export function isAllowedPortalUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol === 'https:') return true;
    if (u.protocol !== 'http:') return false;
    return isPrivateOrLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

// Kompakt-Status für den Poll — genau die Felder, die das Portal anzeigt.
// Quelle ist wie im Leitstand der Poller-Snapshot (IPC), nie Web-Prozess-
// lokales state — sonst bleibt alles leer im Split-Prozess-Betrieb.
function roundEur(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Lizenz der Anlage fürs Portal (Pro aktiv? lizenzierte kWp? eingetragene
// Anlagengröße?). Ohne Pro darf das Portal nur eine Lizenz einspielen — Status,
// Support-Tunnel und Updates erst mit aktiver Pro-Lizenz. Kein Schlüssel,
// keine Maschinendatei (getState schwärzt beides).
export function buildLicenseInfo(ctx) {
  const ls = ctx.licenseService;
  if (!ls || typeof ls.getState !== 'function') return null;
  let s;
  try { s = ls.getState() || {}; } catch { return null; }
  const kwp = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v) * 10) / 10 : null);
  return {
    proActive: typeof ls.isProActive === 'function' ? ls.isProActive() === true : false,
    status: String(s.effective_status || s.status || 'none'),
    kind: s.license_kind || null,
    maxKwp: kwp(s.max_kwp),
    systemKwp: kwp(s.system_kwp),
    capacityOk: s.capacity_ok !== false,
  };
}

// Worauf läuft die Anlage (Container oder Betriebssystem) und welche Version?
// Fürs Portal: ein Container wird durch ein neues Image ersetzt, nicht per Update.
export function buildRuntimeInfo(ctx) {
  const rt = runtimeInfo();
  let version = null;
  try { version = ctx.getAppVersion?.()?.versionLabel || null; } catch { /* ohne Version */ }
  return { kind: rt.kind, label: rt.label, os: rt.os, arch: rt.arch, version };
}

// Fern-Support fürs Portal: öffentlicher Relay-Schlüssel (damit das Portal die
// Box beim Relay eintragen kann), Zustand des Tunnels und ob der Kunde dem
// Portal das Öffnen erlaubt hat. Nie der private Schlüssel.
export function buildSupportInfo(ctx) {
  const tun = ctx.supportTunnel;
  if (!tun || typeof tun.status !== 'function') return null;
  let st;
  try { st = tun.status(); } catch { return null; }
  const key = typeof tun.publicKey === 'function' ? tun.publicKey() : null;
  return {
    allowTunnel: (ctx.getCfg?.() || {}).installerPortal?.allowTunnel === true,
    pubkey: key?.pubkey || null,
    fingerprint: key?.fingerprint || null,
    provisioned: st.provisioned === true,
    capable: st.capable !== false,
    loginUser: st.loginUser || null,
    shellAvailable: st.shellAvailable !== false,
    // Warum keine Fern-Shell (sshd_not_listening = openssh-server fehlt/aus, local_user_disabled, …).
    shellReason: st.shellReason || null,
    shellPort: st.relay?.shellPort || null,
    webPort: st.relay?.webPort || null,
    open: st.open === true,
    expiresAt: st.expiresAt || null,
    mode: st.mode || null,
    lastError: st.open ? null : (st.lastError ? String(st.lastError).slice(0, 300) : null),
  };
}

// ── Tagesbericht ─────────────────────────────────────────────────────────────
// Nach jedem abgeschlossenen Tag meldet die Anlage dem Portal den Tagesertrag
// und den Direktvermarktungs-Erlös des Monats bis dahin (wie die DV-Karte der
// Historie). Das Portal speichert beides — die Werte bleiben dort sichtbar,
// auch wenn die Anlage offline ist. Fehlende Tage (Anlage war offline) werden
// nachgeholt, höchstens DAY_REPORT_BACKLOG Tage zurück, einer je Poll.
export const DAY_REPORT_BACKLOG = 31;

export function localDateIso(ms, timeZone = 'Europe/Berlin') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function addDaysIso(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Nächster zu meldender Tag: der Tag nach dem zuletzt gemeldeten, frühestens
// DAY_REPORT_BACKLOG Tage zurück; beim ersten Mal nur „gestern“. null = aktuell.
export function nextReportDay(lastReported, yesterday) {
  if (!lastReported) return yesterday;
  if (lastReported >= yesterday) return null;
  const floor = addDaysIso(yesterday, -(DAY_REPORT_BACKLOG - 1));
  const next = addDaysIso(lastReported, 1);
  return next < floor ? floor : next;
}

// null/undefined/'' bleiben null — „unbekannt“ ist nicht „0 €“ (Number(null) === 0).
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const num2 = (v) => (isNum(v) ? Math.round(Number(v) * 100) / 100 : null);
const num0 = (v) => (isNum(v) ? Math.round(Number(v)) : null);
const isObj = (o) => o != null && typeof o === 'object' && !Array.isArray(o);

// Tages- und Monats-Zusammenfassung → kompakter Bericht (nur Zahlen).
// withMonth: nur beim NEUESTEN Tag. Die Monats-Zusammenfassung umfasst immer den
// ganzen Monat bis jetzt — bei nachgeholten älteren Tagen stünde sonst ein
// neuerer Stand unter einem alten Datum. asOf = echter Rechenzeitpunkt.
export async function buildDayReport(ctx, day, { withMonth = true, nowMs = Date.now() } = {}) {
  const getSummary = ctx.historyApi?.getSummary;
  if (typeof getSummary !== 'function') return null;
  const d = await getSummary({ view: 'day', date: day });
  const m = withMonth ? await getSummary({ view: 'month', date: `${day.slice(0, 7)}-01` }) : null;
  const dk = d?.body?.kpis || d?.kpis;
  const mk = m?.body?.kpis || m?.kpis;
  if (!dk) return null;
  return {
    day,
    netEur: num2(dk.netEur),
    exportRevenueEur: num2(dk.exportRevenueEur),
    importCostEur: num2(dk.importCostEur),
    exportKwh: num2(dk.exportKwh),
    pvKwh: num2(dk.pvKwh),
    month: mk ? {
      month: day.slice(0, 7),
      asOf: new Date(nowMs).toISOString(),
      dvRevenueEur: num2(mk.dvRevenueEur ?? mk.exportRevenueEur),
      exportRevenueEur: num2(mk.exportRevenueEur),
      marketPremiumEur: num2(mk.marketPremiumEur),
      exportKwh: num0(mk.exportKwh),
      dvRevenueCtKwh: num2(mk.dvRevenueCtKwh),
    } : null,
  };
}

function proActive(ctx) {
  try { return ctx.licenseService?.isProActive?.() === true; } catch { return false; }
}

// Menschenlesbare Namen der Herstellerprofile fürs Portal. Unbekannte (neu im
// hersteller/-Ordner abgelegte) Profile fallen auf die ID zurück — die ID ist
// kein Geheimnis. Ohne Auswahl gilt der config-model-Default (victron).
const MANUFACTURER_LABELS = {
  victron: 'Victron',
  'bridge-mqtt': 'Universal (MQTT-Bridge)',
  'dvhub-mqtt': 'Universal (DVhub-MQTT: HA/Loxone)',
  fronius: 'Fronius GEN24',
  'deye-lv': 'Deye SUN-…SG04LP3 (LV, 3-phasig)',
  sungrow: 'Sungrow SH Hybrid',
};

// Ausgewählter Provider/Hersteller (menschenlesbar) — nur Auswahl, kein Host.
function buildProviderInfo(cfg) {
  const id = (typeof cfg.manufacturer === 'string' && cfg.manufacturer) ? cfg.manufacturer : 'victron';
  return { id, label: MANUFACTURER_LABELS[id] || id };
}

// Welcher Netzzähler die Netzmessung liefert — nur Quelle/Name, nie Host/Register.
//   source  = AKTIV genutzte Netzmessung: 'profile' (Zähler am WR/GX aus dem
//             Herstellerprofil, z. B. Victron-GX-Smart-Meter, Sungrow-Master) oder
//             'bridge' (kommt über die MQTT-Bridge; Profile mit transport 'mqtt',
//             d. h. bridge-mqtt/dvhub-mqtt, haben keinen eigenen Zähler).
//             Abgeleitet am Transport, NICHT an cfg.meter — die Default-Config
//             seedet immer einen meter-Block, auch für MQTT-Profile.
//   mode    = vom Betreiber GEWÄHLTER Zähler-Selektor (cfg.meterSource.mode):
//             'profile'|'modbus'|'mqtt'|'http'. Die externen Modi sind erst
//             konfiguriert, der Datenpfad ist noch nicht aktiv (config-model.js:
//             4987-4991) — darum getrennt von der aktiven `source` gemeldet.
//   live    = frische gemessene Netzgröße (payload.meter.ok); ohne Snapshot null.
function buildGridMeterInfo(cfg, payload) {
  const ms = isObj(cfg.meterSource) ? cfg.meterSource : {};
  const mode = (typeof ms.mode === 'string' && ms.mode) ? ms.mode : 'profile';
  const bridgeTransport = cfg.victron?.transport === 'mqtt';
  const source = bridgeTransport ? 'bridge' : 'profile';
  const label = (typeof ms.label === 'string' && ms.label.trim()) ? ms.label.trim().slice(0, 80) : null;
  const live = isObj(payload.meter) ? payload.meter.ok !== false : null;
  return { source, mode, externalConfigured: mode !== 'profile', label, live };
}

// WIE DVhub die Anlage fährt — herstellerneutral aus Config (controlWrite/
// dvControl) und Runtime abgeleitet:
//   'sungrow-ems'        — External EMS (Modus 3) / Forced (Modus 2)
//   'battery-regulation' — Akku-/Work-Mode-Abregelung (Fronius Zero-Feed-in, Deye)
//   'ess-setpoint'       — Victron/generischer ESS-Netzsollwert
//   'read-only'          — keine schreibende Steuerung konfiguriert
// writes = DVhub schreibt aktiv (nicht read-only und nicht im Not-Halt).
function buildControlModeInfo(cfg, ctrl, payload, v) {
  const paused = ctrl.discretionaryWritesPaused === true;
  const cw = isObj(cfg.controlWrite) ? cfg.controlWrite : {};
  const dvc = isObj(cfg.dvControl) ? cfg.dvControl : {};
  const setpointWritable = cw.gridSetpointW?.enabled === true;
  const sungrowEmu = cw.gridSetpointW?.emulate === 'sungrow-ems';
  const zeroFeedIn = dvc.zeroFeedIn?.enabled === true;
  // Steuermodus an der Config festmachen (Quelle der Wahrheit), nicht am
  // Runtime-ems — sonst bliebe nach einem Profilwechsel ein stehengebliebener
  // sungrowEms-State als 'sungrow-ems' hängen. ems nur für die Detail-Werte.
  const ems = isObj(payload.ctrl?.sungrowEms) ? payload.ctrl.sungrowEms
    : (isObj(ctrl.sungrowEms) ? ctrl.sungrowEms : null);
  const emsErr = typeof ems?.error === 'string' ? ems.error : '';

  let kind; let detail = {};
  if (sungrowEmu || cfg.manufacturer === 'sungrow') {
    kind = 'sungrow-ems';
    // Befund 4: 'auto' (Default) nach der resolveSungrowControl-Logik auflösen —
    // zwei WR → forced, ein WR → external; sonst meldete das Portal bei zwei WR
    // fälschlich 'external', solange noch kein EMS-Status vorliegt.
    const cm = cfg.sungrow?.controlMode;
    const twoWr = typeof cfg.sungrow?.secondInverter?.host === 'string' && cfg.sungrow.secondInverter.host.trim().length > 0;
    const cfgMode = cm === 'forced' ? 'forced' : (cm === 'external' ? 'external' : (twoWr ? 'forced' : 'external'));
    const mode = (ems && (ems.controlMode === 'forced' || ems.controlMode === 'external')) ? ems.controlMode : cfgMode;
    detail = {
      mode,                                 // 'external' (EMS-Modus 3) | 'forced' (Modus 2)
      emsModeValue: mode === 'forced' ? 2 : 3,
      owns: ems ? ems.owns === true : null,              // hält DVhub den EMS-Modus?
      foreign: ems ? emsErr.includes('foreign_ems_mode') : null,  // fremdes EMS aktiv (Fehlermeldung, nicht .code)
      heartbeatSupported: ems ? (ems.heartbeatSupported ?? null) : null,
      heartbeatTimeoutS: num0(ems?.heartbeatTimeoutS ?? cfg.sungrow?.heartbeatTimeoutS),
    };
  } else if (zeroFeedIn || cfg.manufacturer === 'fronius' || cfg.manufacturer === 'deye-lv') {
    kind = 'battery-regulation';
    // dvControl.*-Schalter sind Objekte ({enabled, …}) — auf .enabled prüfen. Beide
    // Abregelpfade melden: feedExcessDcPv (DC-seitig, Fronius Model-124-Zwangsladung)
    // und dontFeedExcessAcPv (AC-seitig, Deye Work-Mode-Nulleinspeisung).
    detail = {
      zeroFeedIn: zeroFeedIn === true,
      feedExcessDcPv: dvc.feedExcessDcPv?.enabled === true,
      dontFeedExcessAcPv: dvc.dontFeedExcessAcPv?.enabled === true,
    };
  } else if (setpointWritable) {
    kind = 'ess-setpoint';
    detail = { gridSetpointW: num0(v.gridSetpointW) };
  } else {
    kind = 'read-only';
  }
  // Schreibt DVhub WIRKLICH? Je Modus verschieden gesperrt:
  //  - sungrow-ems: ein EMS-Fehler (foreign/heartbeat/nicht erkannt) hält den
  //    letzten Schreibvorgang an (sungrow.js:1025/1081/1227) → keine Writes.
  //  - battery-regulation (Fronius/Deye): läuft nur über die dvControl-Sequenz;
  //    ist dvControl.enabled aus (EEG-Festtarif-Hinweis), wird nichts geschrieben.
  //  - ess-setpoint: der Netzsollwert-Schreibpfad (EOS/Regeln/§14a) hängt nicht an
  //    dvControl.enabled (das ist die DV-Schnittstelle) → nur Not-Halt sperrt.
  const dvControlEnabled = dvc.enabled !== false;
  // Lese-Modus (DVHUB_READ_ONLY=1): der Transport weist JEDEN Schreibzugriff ab
  // (read-only-guard.js), unabhängig von Config/Modus — dann schreibt DVhub nie.
  const readOnly = isReadOnlyMode();
  let writes;
  if (kind === 'read-only' || readOnly) writes = false;
  else if (paused) writes = false;
  else if (kind === 'sungrow-ems') writes = !emsErr;
  else if (kind === 'battery-regulation') writes = dvControlEnabled;
  else writes = true;   // ess-setpoint
  return { kind, writes, paused, readOnly, dvControl: dvControlEnabled, detail };
}

// Mehrgeräte-/Split-Topologie fürs Portal — universell für Sungrow Master/Slave
// UND die zweite GX (multi-gx). Je Gerät nur nicht-geheime Metadaten (Rolle,
// kWp, Akku-kWh, Leistungsgrenze, SoC, Ist-Leistung, Steuer-/Rückfall-Status) —
// NIE Host/IP. Ohne zweites Gerät: { multiDevice:false, kind:'single', … }.
function buildTopologyInfo(cfg, ctx, payload, v) {
  const ems = isObj(payload.ctrl?.sungrowEms) ? payload.ctrl.sungrowEms
    : (isObj(ctx.state?.ctrl?.sungrowEms) ? ctx.state.ctrl.sungrowEms : null);
  // Not-Halt und EMS-Fehler fahren BEIDE WR in den Eigenverbrauch zurück; das
  // zuletzt geschriebene st.decision.split bleibt aber stehen (sungrow.js räumt
  // es im Not-Halt/Fehler nicht auf). Darum Steuer-/Split-Status daran binden,
  // dass gerade wirklich gesteuert wird — sonst meldet das Portal einen aktiven
  // Split, obwohl die Anlage still ist.
  // Not-Halt immer aus dem Web-Prozess-State lesen (wie controlMode/buildCompact-
  // Status) — er wird dort gesetzt und reist NICHT im Worker-Poller-Snapshot mit.
  const paused = ctx.state?.ctrl?.discretionaryWritesPaused === true;
  const emsErr = typeof ems?.error === 'string' ? ems.error : '';
  const steering = !paused && !emsErr;

  // 1) Sungrow Master/Slave-Parallelbetrieb (zweiter WR). Entscheidung an der
  //    Config (eingetragene Adresse) UND am aktiven Hersteller: der sungrow.*-Block
  //    ist nicht herstellergebunden und bleibt beim Wechsel weg von Sungrow in der
  //    config.json stehen (die UI-Felder sind dann ausgeblendet, nicht löschbar).
  //    Ohne die Hersteller-Bindung würde ein liegengebliebener zweiter WR eine
  //    echte zweite GX verdecken. Das Runtime-sungrowSecond ist zudem klebrig.
  const sg2 = isObj(cfg.sungrow?.secondInverter) ? cfg.sungrow.secondInverter : null;
  const sg2Configured = cfg.manufacturer === 'sungrow'
    && !!(sg2 && typeof sg2.host === 'string' && sg2.host.trim());
  const s2 = sg2Configured && isObj(v.sungrowSecond) ? v.sungrowSecond : null;
  if (sg2Configured) {
    const split = isObj(ems?.decision?.split) ? ems.decision.split : null;
    // dreiwertig aus der View übernehmen: null = Start/unbekannt (nicht „offline").
    const online = s2 ? (s2.online === true ? true : (s2.online === false ? false : null)) : null;
    // Slave gilt nur als gesteuert, wenn ein Split aktiv läuft UND die Strategie
    // nicht 'master-only' ist (dann hält der Slave nur Eigenverbrauch, slaveW 0).
    const slaveCommanded = !!split && split.strategy !== 'master-only' && steering;
    // Wirksamer Master-Anteil wie zur Laufzeit (clampRatioPct): ohne Angabe 50,
    // sonst auf 0–100 begrenzt (sungrow.js:354).
    const ratioMasterPct = isNum(sg2?.ratioMasterPct)
      ? Math.min(100, Math.max(0, Math.round(Number(sg2.ratioMasterPct)))) : 50;
    return {
      multiDevice: true,
      kind: 'sungrow-dual',
      deviceCount: 2,
      split: {
        active: !!split && online === true && steering,
        blocked: sg2Configured && online === false,     // Slave offline → master-only-Rückfall
        strategyCharge: s2?.strategyCharge ?? sg2?.strategyCharge ?? null,
        strategyDischarge: s2?.strategyDischarge ?? sg2?.strategyDischarge ?? null,
        strategyActive: split?.strategy ?? null,
        masterW: num0(split?.masterW),
        slaveW: num0(split?.slaveW),
        ratioMasterPct,
      },
      devices: [
        {
          role: 'master',
          controlled: steering,
          socPct: num0(v.sungrowMasterSocPct ?? v.soc),
          batteryPowerW: num0(v.sungrowMasterBatteryW ?? v.batteryPowerW),
          pvPowerW: num0(v.sungrowMasterPvW ?? v.pvPowerW ?? v.pvTotalW),
        },
        {
          role: 'slave',
          online,
          controlled: slaveCommanded,
          socPct: num0(s2?.socPct),
          batteryPowerW: num0(s2?.batteryPowerW),
          pvPowerW: num0(s2?.pvPowerW),
          ratedW: num0(s2?.bdcRatedW),
          capacityWh: num0(sg2?.batteryCapacityWh),
          maxChargeW: num0(sg2?.maxChargeW),
          maxDischargeW: num0(sg2?.maxDischargeW),
          pvKwp: isNum(sg2?.pvKwp) ? Number(sg2.pvKwp) : null,
          runningState: s2?.runningStateText ?? null,
        },
      ],
    };
  }

  // 2) Zweite GX (multi-gx). ENTSCHEIDUNG am Runtime-Zustand des Dienstes
  //    (mg.enabled === true), NICHT allein an der Config, UND an einer eingetragenen
  //    Adresse: der Dienst meldet bei offener Beta-Sperre ohne Adresse
  //    {enabled:true, reason:'not_configured'} — das wäre sonst eine Phantom-GX.
  //    Config mgCfg.enabled allein würde zudem eine Einzelanlage auf dem Stable-
  //    Kanal (Beta-Sperre zu → enabled:false) fälschlich als zweite GX melden.
  //    Hinweis: state.multiGx wird noch nicht im Worker-Poller-Snapshot gespiegelt
  //    — im Split-Prozess-Betrieb (DVHUB_ENABLE_RUNTIME_WORKER) ist mg null und die
  //    zweite GX erscheint als Einzelgerät (bekannte Lücke; dieser Modus ist
  //    laut server.js:2089 ungenutzt).
  const mgCfg = isObj(cfg.multiGx) ? cfg.multiGx : null;
  const mgHost = String(mgCfg?.host || '').trim();
  const mg = isObj(payload.multiGx) ? payload.multiGx : (isObj(ctx.state?.multiGx) ? ctx.state.multiGx : null);
  if (mg && mg.enabled === true && mgHost) {
    const online = mg.online === true ? true : (mg.online === false ? false : null);
    // aktiv nur, wenn online, nicht im Not-Halt und ein Sollwert anliegt (im
    // Not-Halt publiziert der Dienst setpointW null).
    const mgActive = online === true && !paused && mg.setpointW != null;
    const secondControlled = mgActive === true;
    return {
      multiDevice: true,
      kind: 'second-gx',
      deviceCount: 2,
      split: {
        active: mgActive,
        // „blockiert" nur am echten Dienst-Grund — der Dienst meldet online in den
        // ersten Takten nach Start schon als false, bevor er wirklich offline ist.
        blocked: mg.reason === 'follower_offline',
        strategy: 'floor-handoff',
        sharePct: num0(mg.sharePct),
        mainDischargeBlocked: mg.mainDischargeBlocked === true,
      },
      devices: [
        {
          role: 'main-gx',
          controlled: !paused,
          socPct: num0(v.soc),
          batteryPowerW: num0(v.batteryPowerW),
          pvPowerW: num0(v.pvTotalW ?? v.pvPowerW),
        },
        {
          role: 'second-gx',
          online,
          controlled: secondControlled,
          socPct: num0(mg.socPct),
          batteryPowerW: num0(mg.batteryPowerW),
          setpointW: num0(mg.setpointW),
          capacityWh: num0(mgCfg?.batteryCapacityWh),
          maxChargeW: num0(mgCfg?.maxChargeW),
          maxDischargeW: num0(mgCfg?.maxDischargeW),
          minSocPct: num0(mgCfg?.minSocPct),
          fallback: mg.reason ?? null,
        },
      ],
    };
  }

  // 3) Einzelgerät (Regelfall).
  return { multiDevice: false, kind: 'single', deviceCount: 1, split: null, devices: [] };
}

/**
 * Welche Steuerungen und Abregelungen für die Anlage gelten — damit der
 * Installateur im Portal sieht, wer die Anlage gerade begrenzen darf:
 * Direktvermarktung (Plexlog/LUOX), §51-Negativpreis-Abregelung,
 * Einspeisebegrenzung (§9 / DV-Teilvorgabe), §14a (EEBUS-Steuerbox oder
 * Relais, Mindestleistung, steuerbare Verbrauchseinrichtungen).
 * Zusätzlich (Christin 2026-11-14) WIE die Anlage angesteuert wird: ausgewählter
 * Provider, genutzter Netzzähler, Steuermodus und — bei mehreren Wechselrichtern
 * — Topologie + Aufteilung. Universell für alle Hersteller, nie Geheimnisse.
 */
export function buildControlsSummary(ctx, payload = {}) {
  const cfg = (ctx.getCfg && ctx.getCfg()) || {};
  const ctrl = ctx.state?.ctrl || {};
  const v = isObj(payload.victron) ? payload.victron : {};
  const p = payload.p14a || null;
  const eb = payload.eebus?.enabled ? payload.eebus : null;
  return {
    // Wie die Anlage angesteuert wird (Provider/Zähler/Modus/Topologie).
    provider: buildProviderInfo(cfg),
    gridMeter: buildGridMeterInfo(cfg, payload),
    controlMode: buildControlModeInfo(cfg, ctrl, payload, v),
    topology: buildTopologyInfo(cfg, ctx, payload, v),
    dv: {
      profile: cfg.dvInterface?.profile === 'luox' ? 'luox' : 'plexlog',
      curtailed: ctrl.forcedOff === true,
      limitPct: Number.isFinite(ctrl.dvLimitPct) ? ctrl.dvLimitPct : null,
      until: ctrl.forcedOff ? (ctrl.offUntil || null) : (Number.isFinite(ctrl.dvLimitPct) ? (ctrl.dvLimitUntil || null) : null),
    },
    negativePrice: {
      protection: cfg.dvControl?.negativePriceProtection?.enabled !== false,
      active: ctrl.negativePriceActive === true,
    },
    feedInLimit: {
      limitW: ctx.feedInLimit?.effective?.() ?? null,
      sources: ctx.feedInLimit?.sources?.() ?? {},
      blocked: ctrl.eebusProductionBlock === true,
    },
    p14a: p ? {
      active: p.active === true,
      source: p.source || null,
      limitW: p.limitW ?? null,
      belowPmin: p.belowPmin === true,
      pminW: p.pminW ?? 0,
      n: p.n ?? 0,
      gzf: p.gzf ?? 1,
      relay: p.relay?.enabled ? { level: p.relay.level ?? null, dimmed: p.relay.level != null && p.relay.level === p.relay.activeWhen } : null,
      devices: (p.devices || []).map((d) => ({ kind: d.kind, name: d.name || null, powerW: d.powerW, control: d.control, controllable: d.controllable === true })),
    } : null,
    eebus: eb ? {
      status: eb.status || null,
      gridPeer: !!eb.grid,
      connected: eb.grid ? eb.grid.connected === true : null,
      lpc: eb.lpc ? { state: eb.lpc.state, limitW: eb.lpc.limitW ?? null } : null,
      lpp: eb.lpp ? { state: eb.lpp.state, limitW: eb.lpp.limitW ?? null } : null,
    } : null,
  };
}

/**
 * Befehls-Ergebnis fürs Portal ohne `uiToken` (Formular-Schutz der Box-Oberfläche — gehört nicht ins Portal;
 * Portal 19.11.: der Fern-Support-Status trug ihn mit). Verschachtelt, Arrays eingeschlossen; sonst unverändert.
 */
export function redactPortalResult(value) {
  if (Array.isArray(value)) return value.map(redactPortalResult);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) if (k !== 'uiToken') out[k] = redactPortalResult(v);
  return out;
}

export function buildCompactStatus(ctx, now = Date.now()) {
  const payload = (ctx.getCachedRuntimeStatusPayload && ctx.getCachedRuntimeStatusPayload())
    || (ctx.buildFallbackStatusPayload && ctx.buildFallbackStatusPayload(now))
    || {};
  const v = payload.victron || {};
  const alarms = buildVictronAlarmsPayload(v.alarms, now, ctx.getCfg()?.victron?.alarms?.pollIntervalMs);
  // Netz-Sollwert und Min-SoC: zuerst die Rückmeldung des Geräts. Sungrow und das DVhub-MQTT-Schema melden
  // keinen Sollwert zurück (Portal 19.11.: „–“) — dann der Wert, den DVhub zuletzt gesendet hat, mit Quelle.
  const sent = (k) => {
    const n = Number(payload.schedule?.lastWrite?.[k]?.value);
    return payload.schedule?.lastWrite?.[k]?.value != null && Number.isFinite(n) ? n : null;
  };
  const withSource = (deviceValue, key) => {
    if (deviceValue != null) return { value: deviceValue, source: 'device' };
    const s = sent(key);
    return s != null ? { value: s, source: 'dvhub' } : { value: null, source: null };
  };
  const setpoint = withSource(v.gridSetpointW ?? null, 'gridSetpointW');
  const minSoc = withSource(v.minSocPct ?? null, 'minSocPct');
  return {
    ts: new Date(now).toISOString(),
    soc: v.soc ?? null,
    batteryPowerW: v.batteryPowerW ?? null,
    pvTotalW: v.pvTotalW ?? v.pvPowerW ?? null,
    // Zwei Sungrow-WR (Parallelbetrieb): soc/batteryPowerW/pvTotalW oben sind die Systemsumme. Beide Einzel-SoC
    // und der zweite WR sichtbar machen, damit der Installateur jeden Akku einzeln prüfen kann (ohne LAN-IP).
    sungrowMasterSocPct: v.sungrowMasterSocPct ?? null,
    sungrowSecond: v.sungrowSecond ?? null,
    gridSetpointW: setpoint.value,
    gridSetpointSource: setpoint.source, // 'device' | 'dvhub' (zuletzt gesendet) | null
    // Netzübergabepunkt (gemessen) — getrennt, damit das Portal kein
    // Vorzeichen-Setting kennen muss; ohne gültigen Zähler null.
    gridImportW: payload.meter?.ok === false ? null : (v.gridImportW ?? null),
    gridExportW: payload.meter?.ok === false ? null : (v.gridExportW ?? null),
    // Hausverbrauch (gemessen oder aus der Energiebilanz abgeleitet)
    loadW: v.selfConsumptionW ?? null,
    minSocPct: minSoc.value,
    minSocSource: minSoc.source,
    alarmsActive: alarms.active.length,
    alarmsSeverity: alarms.severity || 0,
    alarmsStale: !!alarms.stale,
    // Not-Halt ist Web-Prozess-state (state.ctrl), nicht Teil des Poller-
    // Snapshots; der Freeze-Wächter schreibt victron.freeze = { active, … }.
    emergencyStop: !!ctx.state?.ctrl?.discretionaryWritesPaused,
    telemetryFrozen: !!v.freeze?.active,
    supportTunnelOpen: !!(ctx.supportTunnel && ctx.supportTunnel.liteStatus && ctx.supportTunnel.liteStatus().open),
    // Tagesertrag (heute, wie im Leitstand): Netto = Einspeiseerlös − Bezugskosten.
    todayNetEur: roundEur(payload.costs?.netEur),
    todayRevenueEur: roundEur(payload.costs?.revenueEur),
    todayCostEur: roundEur(payload.costs?.costEur),
    version: (ctx.getAppVersion && ctx.getAppVersion().versionLabel) || null,
    controls: buildControlsSummary(ctx, payload),
  };
}

// HTTP POST/GET ohne externe Dependencies (node:http/-https), damit der
// Client in jeder Umgebung ohne Fetch-Polyfill laufen kann.
function request(urlStr, { method = 'POST', headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('invalid_url')); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : null;
    const req = lib.request(u, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(payload != null ? { 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

export function createInstallerPortalClient(ctx = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const now = deps.now || (() => Date.now());
  const fetchImpl = deps.fetchImpl || request;
  const pushLog = (typeof ctx.pushLog === 'function') ? ctx.pushLog : () => {};
  const pollIntervalMs = Number(deps.pollIntervalMs) || POLL_INTERVAL_MS_DEFAULT;
  // Kommando-Ausführung in Tests überschreibbar; Default: Loopback gegen die
  // eigenen /api/*-Endpunkte (gleiche Guards wie im UI-Klickweg).
  const execCommandImpl = deps.execCommand || ((cmd) => execLoopback(cmd));

  function dataDir() {
    if (typeof ctx.getDataDir === 'function') return ctx.getDataDir() || '.';
    return process.env.DV_DATA_DIR || '.';
  }
  function sidecarPath() { return path.join(dataDir(), SIDECAR_NAME); }
  function loadSidecar() {
    try {
      const o = JSON.parse(fsImpl.readFileSync(sidecarPath(), 'utf8'));
      return (o && typeof o === 'object' && o.portalUrl) ? o : null;
    } catch { return null; }
  }
  // Enthält den Geräteschlüssel fürs Portal — nur für DVhub selbst lesbar.
  function saveSidecar(o) {
    const p = sidecarPath();
    const tmp = `${p}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(o, null, 2), { mode: 0o600 });
    try { fsImpl.chmodSync?.(tmp, 0o600); } catch { /* best effort */ }
    fsImpl.renameSync(tmp, p);
  }
  function clearSidecar() {
    try { fsImpl.unlinkSync(sidecarPath()); } catch { /* war nicht da */ }
  }
  function releasePath() { return path.join(dataDir(), RELEASE_PENDING_NAME); }
  function loadPendingRelease() {
    try {
      const o = JSON.parse(fsImpl.readFileSync(releasePath(), 'utf8'));
      return (o && o.portalUrl && o.applianceToken && o.applianceId) ? o : null;
    } catch { return null; }
  }
  function clearPendingRelease() {
    try { fsImpl.unlinkSync(releasePath()); } catch { /* war nicht da */ }
  }

  // Abmeldung senden. 200 = erledigt; 401/404 = Eintrag im Portal schon weg
  // (Installateur hat entfernt oder neu gekoppelt) — beides beendet die
  // Vormerkung. Netzfehler/5xx: beim nächsten Takt erneut.
  let releaseRunning = false;
  async function retryPendingRelease() {
    const pr = loadPendingRelease();
    if (!pr || releaseRunning) return { pending: !!pr };
    if (now() - (Date.parse(pr.since) || 0) > RELEASE_GIVE_UP_MS) {
      clearPendingRelease();
      pushLog('installer_portal_release_given_up', {});
      return { pending: false, givenUp: true };
    }
    releaseRunning = true;
    try {
      const r = await fetchImpl(`${pr.portalUrl}/api/pair/release`, {
        method: 'POST', headers: { 'x-appliance-token': pr.applianceToken }, body: { applianceId: pr.applianceId },
      });
      if (r && (r.status === 200 || r.status === 401 || r.status === 404)) {
        clearPendingRelease();
        pushLog('installer_portal_release_done', { status: r.status });
        return { pending: false, released: r.status === 200 };
      }
      return { pending: true, status: r?.status ?? null };
    } catch {
      return { pending: true };
    } finally {
      releaseRunning = false;
    }
  }

  // Loopback gegen die eigene HTTP-Schnittstelle — bewusster Umweg über die
  // echten Routen, damit service-actions-/Tunnel-Guards nicht dupliziert
  // werden.
  function execLoopback(cmd) {
    const cfg = ctx.getCfg() || {};
    const port = Number(cfg.httpPort) || 80;
    const base = `http://127.0.0.1:${port}`;
    // Verbindung immer an 127.0.0.1 — aber mit einem Host-Header, den die
    // Host-Allowlist akzeptiert (die hat KEINEN Loopback-Bypass: ist
    // allowedHosts gesetzt, würde "127.0.0.1:<port>" sonst abgewiesen).
    const allowed = Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts.filter(Boolean) : [];
    const hostHdr = allowed.length ? { host: String(allowed[0]) } : {};
    const auth = 'Bearer ' + (cfg.apiToken || '');
    const args = cmd.args || {};
    if (cmd.type === 'open_tunnel') {
      const body = { ttlMin: Number(args.ttlMin) || 60 };
      // Ohne apiToken zählt der Bearer nicht → Tunnel-UI-Nonce in-process holen.
      if (!cfg.apiToken) body.uiToken = ctx.supportTunnel?.status?.()?.uiToken;
      return fetchImpl(`${base}/api/support/tunnel/open`, {
        method: 'POST', headers: { ...hostHdr, authorization: auth }, body,
      });
    }
    if (cmd.type === 'close_tunnel') {
      return fetchImpl(`${base}/api/support/tunnel/close`, {
        method: 'POST', headers: { ...hostHdr, authorization: auth }, body: {},
      });
    }
    if (cmd.type === 'license_activate') {
      // Lizenz für den Kunden einspielen — gleicher Weg wie in den Einstellungen.
      return fetchImpl(`${base}/api/license/activate`, {
        method: 'POST', headers: { ...hostHdr, authorization: auth }, body: { key: String(args.key || '') },
      });
    }
    if (cmd.type === 'updates_check') {
      return fetchImpl(`${base}/api/admin/update/check`, {
        method: 'GET', headers: { ...hostHdr, authorization: auth },
      });
    }
    return Promise.resolve({ status: 400, json: { ok: false, error: 'unknown_command' } });
  }

  // Live-Schalter des Kunden (installerPortal.enabled) — gilt für den
  // ausgehenden Pfad genauso wie für die WAN-Endpunkte.
  function isEnabled() {
    return (ctx.getCfg() || {}).installerPortal?.enabled === true;
  }
  function tunnelAllowed() {
    return (ctx.getCfg() || {}).installerPortal?.allowTunnel === true;
  }

  // Kopplungs-Generation: claim/disconnect zählen hoch. Ein Poll, der beim
  // Trennen noch unterwegs ist, erkennt so, dass seine Kopplung nicht mehr
  // gilt — er führt dann keine Kommandos mehr aus und schreibt das Sidecar
  // NICHT wieder her (sonst würde "Trennen" rückgängig gemacht).
  let generation = 0;
  function stillCurrent(gen, sc) {
    if (gen !== generation || !isEnabled()) return false;
    const live = loadSidecar();
    return !!(live && live.applianceToken === sc.applianceToken);
  }

  // Höchstens ein Poll gleichzeitig — ein langsames Kommando (Tunnel-Aufbau)
  // darf sich nicht mit dem nächsten Intervall überholen (Doppelausführung).
  let inflight = null;
  function pollOnce() {
    if (inflight) return inflight;
    inflight = doPoll().finally(() => { inflight = null; });
    return inflight;
  }

  // Fehler ans Portal (Christin 2026-10-01): alles aus dem Audit-Log, was als
  // Fehler gilt (…_error, …_failed, MQTT), ab dem Quittungs-Cursor, aufsteigend,
  // höchstens 300 je Poll. Wiederholt, bis das Portal quittiert (errorsAck);
  // erst dann kürzt log-retention.js lokal auf 24 h / 7 Tage.
  const ERRORS_PER_POLL = 300;
  async function takeErrors(sc) {
    const db = ctx.db;
    if (!db || typeof db.query !== 'function') return { errors: [], reset: false };
    const from = Number(sc.errorAckId) || 0;
    try {
      const res = await db.query(
        `SELECT id, ts_utc, event_type, severity, payload FROM audit_log
          WHERE ${AUDIT_ERROR_SQL} AND id > $1 ORDER BY id LIMIT ${ERRORS_PER_POLL}`, [from]);
      const errors = (res.rows || []).map((row) => ({
        id: Number(row.id),
        ts: new Date(row.ts_utc).toISOString(),
        type: String(row.event_type || '').slice(0, 200),
        sev: String(row.severity || 'error'),
        msg: (row.payload == null ? '' : JSON.stringify(row.payload)).slice(0, 1000),
      }));
      // Datenbank neu (Geräte-Tausch ohne DB-Übernahme): lokale ids liegen unter
      // dem Portal-Cursor — einmal zurücksetzen, sonst verwirft das Portal alles.
      let reset = false;
      if (!errors.length && from > 0) {
        const mx = await db.query('SELECT coalesce(max(id), 0) AS m FROM audit_log');
        reset = Number(mx.rows?.[0]?.m) < from;
      }
      return { errors, reset };
    } catch {
      return { errors: [], reset: false };
    }
  }

  async function doPoll() {
    if (!isEnabled()) return { skipped: true, reason: 'disabled' };
    const sc = loadSidecar();
    if (!sc || !sc.applianceToken) return { skipped: true };
    if (sc.revoked) return { skipped: true, reason: 'revoked' };
    const applianceId = readApplianceId(dataDir(), fsImpl);
    if (!applianceId) return { skipped: true, reason: 'no_appliance_id' };
    const gen = generation;
    // Tagesbericht: fertig gerechneten beilegen, sonst im Hintergrund anstoßen.
    const pro = proActive(ctx);
    const dayReport = pro ? takeDayReport(sc) : null;
    const errBatch = sc.approved ? await takeErrors(sc) : { errors: [], reset: false };
    try {
      const r = await fetchImpl(`${sc.portalUrl}/api/poll`, {
        method: 'POST',
        headers: { 'x-appliance-token': sc.applianceToken },
        // Ohne Pro-Lizenz nur die Lizenz-Info, keine Live-Werte.
        body: {
          applianceId,
          license: buildLicenseInfo(ctx),
          runtime: buildRuntimeInfo(ctx),
          support: buildSupportInfo(ctx),
          status: pro ? buildCompactStatus(ctx, now()) : null,
          ...(dayReport ? { dayReport } : {}),
          ...(errBatch.errors.length ? { errors: errBatch.errors } : {}),
          ...(errBatch.reset ? { errorsReset: true } : {}),
        },
      });
      if (!stillCurrent(gen, sc)) return { ok: false, aborted: true };
      if (r.status === 401 || r.status === 410) {
        // Token widerrufen/abgelehnt — Kopplung gilt als tot, weitere Polls
        // unterbleiben bis zum Trennen/Neukoppeln durch den Kunden.
        sc.lastPollAt = new Date(now()).toISOString();
        sc.lastError = r.status === 410 ? 'pairing_declined' : 'token_invalid';
        sc.revoked = true;
        saveSidecar(sc);
        pushLog('installer_portal_poll_revoked', { portalUrl: sc.portalUrl });
        return { ok: false, revoked: true };
      }
      if (!r.json || !r.json.ok) throw new Error(r.json?.error || `poll_http_${r.status}`);
      const approved = r.json.approved !== false;
      // Ohne Freigabe im Portal werden keine Kommandos angenommen.
      const commands = (approved && Array.isArray(r.json.commands)) ? r.json.commands : [];
      const results = [];
      for (const cmd of commands) {
        if (!cmd || !COMMAND_TYPES.includes(cmd.type)) { results.push({ id: cmd?.id, ok: false, error: 'unknown_command' }); continue; }
        if (!stillCurrent(gen, sc)) return { ok: false, aborted: true };
        // Ohne aktive Pro-Lizenz ist das Portal auf „Lizenz einspielen“
        // beschränkt (je Kommando neu geprüft — ein vorheriges license_activate
        // im selben Durchlauf kann die Lizenz gerade aktiviert haben).
        // Tunnel schließen geht immer: der Kill-Switch hängt nie an der Lizenz
        // (2026-10-15), wie die lokale Route /api/support/tunnel/close.
        if (!LICENSE_FREE_COMMANDS.has(cmd.type) && !proActive(ctx)) {
          results.push({ id: cmd.id, ok: false, status: 403, result: { ok: false, error: 'license_required' } });
          pushLog('installer_portal_command_denied', { type: cmd.type, reason: 'license_required' });
          continue;
        }
        if (cmd.type === 'open_tunnel' && !tunnelAllowed()) {
          results.push({ id: cmd.id, ok: false, status: 403, result: { ok: false, error: 'tunnel_not_permitted' } });
          pushLog('installer_portal_command_denied', { type: cmd.type });
          continue;
        }
        // Portal hat die Box beim Relay eingetragen und schickt die Ports mit:
        // erst übernehmen (nur gültige Relay-Ports), dann öffnen. Ohne Ports
        // bleibt es beim bisherigen Weg.
        if (cmd.type === 'open_tunnel' && (cmd.args?.shellPort !== undefined || cmd.args?.webPort !== undefined)) {
          const ports = validateRelayPorts(cmd.args);
          const saved = ports ? ctx.supportTunnel?.assignRelayPorts?.(ports, { via: 'installer_portal' }) : null;
          if (!ports || !saved || !saved.ok) {
            const error = !ports ? 'invalid_ports' : (saved?.error || 'ports_not_saved');
            results.push({ id: cmd.id, ok: false, status: 400, result: { ok: false, error } });
            pushLog('installer_portal_command_denied', { type: cmd.type, reason: error });
            continue;
          }
        }
        let out;
        try { out = await execCommandImpl(cmd); }
        catch (e) { out = { status: 0, json: { ok: false, error: String(e.message || e).slice(0, 160) } }; }
        const result = {
          id: cmd.id,
          ok: !!(out.json && out.json.ok),
          status: out.status,
          result: redactPortalResult(out.json ?? null),
        };
        results.push(result);
        pushLog('installer_portal_command_executed', { type: cmd.type, ok: result.ok });
      }
      if (results.length && stillCurrent(gen, sc)) {
        try {
          await fetchImpl(`${sc.portalUrl}/api/command-result`, {
            method: 'POST',
            headers: { 'x-appliance-token': sc.applianceToken },
            body: { applianceId, results },
          });
        } catch { /* Ergebnis-Report ist best-effort */ }
      }
      if (!stillCurrent(gen, sc)) return { ok: false, aborted: true };
      sc.lastPollAt = new Date(now()).toISOString();
      sc.lastError = null;
      sc.approved = approved;
      // Nur nach Freigabe speichert das Portal den Bericht — dann gilt er als gemeldet.
      if (dayReport && approved) { sc.lastDayReported = dayReport.day; pendingReport = null; }
      // Quittung: nie über das hinaus, was wir in DIESEM Poll geschickt haben.
      if (approved && Number.isFinite(Number(r.json.errorsAck))) {
        const sentMax = errBatch.errors.length ? errBatch.errors[errBatch.errors.length - 1].id : null;
        if (errBatch.reset) sc.errorAckId = 0;
        else if (sentMax != null) sc.errorAckId = Math.max(Number(sc.errorAckId) || 0, Math.min(Number(r.json.errorsAck), sentMax));
      }
      saveSidecar(sc);
      return { ok: true, approved: sc.approved, executed: results.length };
    } catch (e) {
      if (!stillCurrent(gen, sc)) return { ok: false, aborted: true };
      sc.lastError = String(e.message || e).slice(0, 200);
      sc.lastPollAt = new Date(now()).toISOString();
      saveSidecar(sc);
      return { ok: false, error: sc.lastError };
    }
  }

  // Tagesbericht vorbereiten: wird im Hintergrund gerechnet (Tages- und
  // Monats-Zusammenfassung) und dem NÄCHSTEN Poll beigelegt — der Poll selbst
  // wartet nie darauf.
  let pendingReport = null;   // { day, report } fertig zum Mitschicken
  let reportRunning = false;
  function takeDayReport(sc) {
    const tz = (ctx.getCfg() || {}).schedule?.timezone || 'Europe/Berlin';
    // Kalendertag zurück — nicht „jetzt − 24 h“ (am Zeitumstellungstag wäre das
    // zwischen 23 und 24 Uhr noch HEUTE).
    const yesterday = addDaysIso(localDateIso(now(), tz), -1);
    const day = nextReportDay(sc.lastDayReported || null, yesterday);
    if (!day) return null;
    if (pendingReport && pendingReport.day === day) return pendingReport.report;
    if (!reportRunning) {
      reportRunning = true;
      // Monatswert beim neuesten Tag UND beim letzten Tag jedes abgeschlossenen
      // Monats (sonst bliebe ein über den Monatswechsel verpasster Monat
      // dauerhaft unvollständig). Die Monats-Zusammenfassung ist dann vollständig.
      buildDayReport(ctx, day, { withMonth: day === yesterday || addDaysIso(day, 1).slice(0, 7) !== day.slice(0, 7), nowMs: now() })
        .then((report) => { if (report) pendingReport = { day, report }; })
        .catch(() => { /* nächster Poll versucht es erneut */ })
        .finally(() => { reportRunning = false; });
    }
    return null;
  }

  let timer = null;
  function startPolling() {
    if (timer) return;
    // Erster Poll nach 15 s (Port freiholen), dann im Takt. beides unref —
    // der Poller darf einen Test-/Shutdown-Prozess nicht am Exit hindern.
    // Jeder Takt holt auch eine vorgemerkte Abmeldung nach — unabhängig davon,
    // ob der Portal-Zugang noch eingeschaltet ist.
    const tick = () => { retryPendingRelease().catch(() => {}); pollOnce(); };
    const first = setTimeout(tick, Math.min(15_000, pollIntervalMs));
    if (first.unref) first.unref();
    timer = setInterval(tick, pollIntervalMs);
    if (timer.unref) timer.unref();
  }

  // Pairing: Anlage → Portal. Der Code ist der Nachweis, dass der
  // Installateur die Anlage richtig identifiziert hat; das Portal schickt
  // sein Freigabe-Verhalten im Response (approved=false → wartet noch).
  async function claim({ portalUrl, pairingCode, name }) {
    const url = String(portalUrl || '').trim().replace(/\/+$/, '');
    if (!isAllowedPortalUrl(url)) throw new Error('portal_url_not_allowed');
    if (!PAIRING_CODE_RE.test(String(pairingCode || ''))) throw new Error('pairing_code_invalid');
    const applianceId = readApplianceId(dataDir(), fsImpl);
    if (!applianceId) throw new Error('appliance_id_missing');
    const gen = ++generation;
    const r = await fetchImpl(`${url}/api/pair/claim`, {
      method: 'POST',
      body: {
        applianceId,
        code: String(pairingCode),
        name: String(name || '').slice(0, 80) || undefined,
        license: buildLicenseInfo(ctx),
      },
    });
    if (r.status !== 200 || !r.json || !r.json.ok) {
      throw new Error((r.json && r.json.error) || `claim_http_${r.status}`);
    }
    if (gen !== generation) {
      // Kunde hat während der laufenden Anfrage getrennt (oder neu gekoppelt):
      // Antwort verwerfen, NICHT speichern — und das Portal best-effort
      // informieren, damit dort keine verwaiste Anfrage stehen bleibt.
      const token = r.json.applianceToken;
      if (token) {
        Promise.resolve().then(() => fetchImpl(`${url}/api/pair/release`, {
          method: 'POST', headers: { 'x-appliance-token': token }, body: { applianceId },
        })).catch(() => {});
      }
      throw new Error('pairing_cancelled');
    }
    const sc = {
      portalUrl: url,
      applianceToken: r.json.applianceToken,
      approved: r.json.status === 'approved',
      pairedAt: new Date(now()).toISOString(),
      lastPollAt: null,
      lastError: null,
    };
    saveSidecar(sc);
    startPolling();
    pushLog('installer_portal_client_paired', { portalUrl: url, status: r.json.status });
    return { ok: true, status: r.json.status, portalUrl: url };
  }

  function status() {
    const sc = loadSidecar();
    if (!sc) return { paired: false };
    return {
      paired: true,
      portalUrl: sc.portalUrl,
      approved: !!sc.approved,
      pairedAt: sc.pairedAt || null,
      lastPollAt: sc.lastPollAt || null,
      lastError: sc.lastError || null,
      revoked: !!sc.revoked,
      applianceId: readApplianceId(dataDir(), fsImpl),
    };
  }

  // Laufende Kopplungs-Anfrage / laufenden Poll verwerfen, OHNE die Kopplung
  // zu löschen — z. B. wenn der Kunde den Portal-Zugang ausschaltet, während
  // claim() noch auf das Portal wartet (sonst schaltet dessen Erfolg den
  // Zugang wieder ein).
  function cancelPending() {
    generation++;
  }

  function disconnect() {
    generation++;
    const sc = loadSidecar();
    clearSidecar();
    // Portal best-effort informieren, damit die Anlage dort frei wird (neuer
    // Code / anderer Installateur). Lokal ist die Trennung schon wirksam.
    // Abmeldung vormerken und gleich versuchen; klappt es nicht, wiederholt der
    // Poll-Takt sie (retryPendingRelease).
    const applianceId = readApplianceId(dataDir(), fsImpl);
    if (sc && sc.applianceToken && applianceId) {
      try {
        const p = releasePath();
        fsImpl.writeFileSync(`${p}.tmp`, JSON.stringify({ portalUrl: sc.portalUrl, applianceToken: sc.applianceToken, applianceId, since: new Date(now()).toISOString() }), { mode: 0o600 });
        try { fsImpl.chmodSync?.(`${p}.tmp`, 0o600); } catch { /* best effort */ }
        fsImpl.renameSync(`${p}.tmp`, p);
      } catch { /* ohne Vormerkung: nur der Sofort-Versuch unten */ }
      retryPendingRelease().catch(() => {});
    }
    pushLog('installer_portal_client_disconnected', {});
    return { ok: true };
  }

  /** Höchste vom Portal quittierte Fehler-id (für log-retention.js), sonst null. */
  function errorAckId() {
    if (!isEnabled()) return null;
    const sc = loadSidecar();
    if (!sc || !sc.approved || sc.revoked) return null;
    const v = Number(sc.errorAckId);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  return { claim, status, disconnect, cancelPending, pollOnce, startPolling, retryPendingRelease, errorAckId, buildCompactStatus: (n) => buildCompactStatus(ctx, n) };
}
