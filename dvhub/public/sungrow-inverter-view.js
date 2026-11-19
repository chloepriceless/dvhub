// sungrow-inverter-view.js — Leitstand-Kachel „Wechselrichter" für zwei Sungrow-WR (Master/Slave, T-0422).
//
// Zeigt je WR SEINEN eigenen Zustand: Rolle, Modell/SN, SoC/Akku(mit Richtung)/PV, Befehl (eigener Anteil, NICHT die
// Summe), wirksame Leistungs-/SoC-Grenzen, Notladung/Rückfall-Hinweise, dazu eine Summenzeile. Quelle ist /api/status
// (victron.device/sungrowMaster*/sungrowSystem*/runningState, sungrowSecond, sungrowEms[.decision.split],
// sungrowEmsSlave). Ohne zweiten WR bleibt die Kachel weg. view() ist reine Anzeige-Logik (testbar), render() setzt
// sie in die Kachel aus index.html. Keine LAN-IP (die steht nur in der Config).
//
// Feld 15.11. (Handy ~375 px): Werte nie mit „…" abschneiden (umbrechen erlaubt), je WR der EIGENE Anteil, Grenze =
// wirksamer Wert (min(Gerät 33047/33048, BDC)), Countdown NUR in Modus 3, Akku mit Laderichtung.
(function () {
  'use strict';
  const DASH = '–';
  const EMS_MODE_EXTERNAL = 3; // Doku 13050: External EMS = Modus 3 (Countdown gilt nur hier)
  const num = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  // Deutsches Dezimaltrennzeichen durchgängig (Christin 15.11.): 2,6 % und 10,6 kW.
  const de = (v) => String(v).replace('.', ',');
  const watt = (v) => (num(v) ? `${Math.round(Number(v))} W` : DASH);
  const pct = (v) => (num(v) ? `${de(Math.round(Number(v) * 10) / 10)} %` : DASH);
  const kw = (v) => (num(v) ? `${de(Math.round(Number(v) / 100) / 10)} kW` : DASH);

  // Fensterrelativer SoC → echter SoC (M1, Feld 16.11.): Sungrow meldet den SoC relativ zum Min…Max-SoC-Fenster des
  // WR (13059…13058). real = min + gemeldet × (max − min)/100. Ohne gültiges Fenster null (keine Umrechnung möglich).
  function realSoc(reported, min, max) {
    if (!num(reported)) return null;
    if (!num(min) || !num(max) || Number(max) <= Number(min)) return null;
    return Math.min(100, Math.max(0, Number(min) + (Number(reported) * (Number(max) - Number(min))) / 100));
  }
  // SoC-Text: gemeldet, und falls umrechenbar der echte dahinter („0,8 % · real 10,7 %"). So sieht der Betreiber
  // beides — der gemeldete Wert (am WR-Display) und der echte, mit dem DVhub/EOS rechnen.
  function socText(reported, min, max) {
    if (!num(reported)) return DASH;
    const real = realSoc(reported, min, max);
    return real == null ? pct(reported) : `${pct(reported)} · real ${pct(real)}`;
  }

  // Akku mit Richtung (Feld 15.11.): Energiefluss-Konvention — positiv = lädt, negativ = entlädt. Nicht
  // richtungslos „1442 W", sondern „lädt 1442 W" / „entlädt 1442 W" (bei ~0 „0 W").
  function batteryDirText(v) {
    if (!num(v)) return DASH;
    const n = Math.round(Number(v));
    if (n > 0) return `lädt ${n} W`;
    if (n < 0) return `entlädt ${-n} W`;
    return '0 W';
  }

  // Befehl je WR aus dem EIGENEN Anteil (split.masterW/slaveW), NICHT der Systemsumme (Feld: fälschlich die Summe).
  // Richtung aus decision.command; ohne Besitz/Self „Eigenverbrauch", 0-Anteil oder Stopp → „Stopp".
  function commandText(decision, shareW) {
    if (!decision || decision.mode === 'self' || decision.command == null) return 'Eigenverbrauch';
    if (decision.command === 'stop') return 'Stopp';
    if (!num(shareW) || Math.round(Number(shareW)) <= 0) return 'Stopp';
    const w = Math.round(Number(shareW));
    const dir = decision.command === 'charge' ? 'Laden' : decision.command === 'discharge' ? 'Entladen' : 'Zwang';
    return `${dir} ${w} W`;
  }

  // Wirksame Leistungsgrenze einer Richtung = min(Gerätegrenze 33047/33048, BDC-Nennleistung). Ein zu hoch
  // gelesener Gerätewert kann nicht schaden (min mit BDC), fehlt eine Angabe, zählt die andere.
  function effectiveW(deviceW, bdcW) {
    const d = num(deviceW) ? Number(deviceW) : null;
    const b = num(bdcW) ? Number(bdcW) : null;
    if (d != null && b != null) return Math.min(d, b);
    return d != null ? d : b;
  }
  // SoC-Spanne „c–d %" aus Min-/Max-SoC der Anlage (Gerätewerte 13059/13058, sonst Konfig-Grenze). null, wenn keine.
  function socRangeText(lo, hi) {
    const l = num(lo) ? Math.round(Number(lo)) : null;
    const h = num(hi) ? Math.round(Number(hi)) : null;
    if (l == null && h == null) return null;
    return `${l != null ? de(l) : '?'}–${h != null ? de(h) : '?'} %`;
  }
  // Grenzen-Zeile (Raster Zeile 3): „Laden a kW · Entladen b kW · SoC c–d %" — wirksame Werte, nie gekürzt.
  function limitLine({ chargeDeviceW, dischargeDeviceW, bdcRatedW, minSocPctDevice, maxSocPctDevice, floorPct, ceilPct }) {
    const c = effectiveW(chargeDeviceW, bdcRatedW);
    const d = effectiveW(dischargeDeviceW, bdcRatedW);
    const parts = [`Laden ${kw(c)}`, `Entladen ${kw(d)}`];
    const lo = num(minSocPctDevice) ? minSocPctDevice : floorPct;
    const hi = num(maxSocPctDevice) ? maxSocPctDevice : ceilPct;
    const range = socRangeText(lo, hi);
    if (range) parts.push(`SoC ${range}`);
    return parts.join(' · ');
  }
  // Optionaler kleiner Geräte-Hinweis, wenn die BDC-Nennleistung die gelesene Gerätegrenze deckelt (Gerät > wirksam):
  // dann steht wirksam die BDC-Grenze und wir zeigen klein den rohen Gerätewert dahinter. Sonst „".
  function limitDeviceHint({ chargeDeviceW, dischargeDeviceW, bdcRatedW }) {
    const b = num(bdcRatedW) ? Number(bdcRatedW) : null;
    if (b == null) return '';
    const hints = [];
    if (num(chargeDeviceW) && Number(chargeDeviceW) > b) hints.push(`Lad ${kw(chargeDeviceW)}`);
    if (num(dischargeDeviceW) && Number(dischargeDeviceW) > b) hints.push(`Entl ${kw(dischargeDeviceW)}`);
    return hints.length ? `Gerät ${hints.join(' · ')}` : '';
  }

  function heartbeatText(ems) {
    if (!ems || ems.controlMode !== 'external') return 'Forced mode';
    if (ems.heartbeatSupported === false) return 'nicht übernommen';
    const fc = ems.heartbeatWorkingFc ? ` (FC ${ems.heartbeatWorkingFc})` : '';
    const dev = ems.heartbeatDeviceManaged ? ' Gerätewert' : '';
    const s = num(ems.heartbeatSentS) ? Number(ems.heartbeatSentS) : ems.heartbeatTimeoutS;
    return `${num(s) ? s + ' s' : DASH}${fc}${dev}`;
  }
  // System-Entscheidung (Summe) für die Advanced-EMS-Zeile — NICHT der je-WR-Befehl.
  function decisionText(ems) {
    const d = ems && ems.decision;
    if (!d) return DASH;
    if (d.mode === 'self') return 'Eigenverbrauch';
    if (d.command === 'stop') return 'Zwangs-Stopp';
    const w = num(d.powerW) ? Math.round(Number(d.powerW)) : null;
    const label = d.command === 'charge' ? 'Laden' : d.command === 'discharge' ? 'Entladen' : 'Zwang';
    // M7b: Bedarf > 0, aber beide WR an ihrer SoC-Grenze (Split 0/0) → es wird nichts gefahren. Nicht „Entladen
    // 1990 W" (irreführend), sondern „Bedarf 1990 W → 0 W (beide an der Grenze 11 %)".
    const sp = d.split;
    if (sp && w != null && w > 0) {
      const sumW = (num(sp.masterW) ? Number(sp.masterW) : 0) + (num(sp.slaveW) ? Number(sp.slaveW) : 0);
      if (Math.round(sumW) <= 0) {
        const limit = d.command === 'charge' ? sp.masterCeilPct : sp.masterFloorPct;
        const atStr = num(limit) ? ` (beide an der Grenze ${de(Math.round(Number(limit)))} %)` : ' (beide an der Grenze)';
        return `Bedarf ${w} W → 0 W${atStr}`;
      }
    }
    return `${label}${w != null ? ` ${w} W` : ''}`;
  }

  // F1: welcher Modus gilt — Eigenverbrauch (0) / Forced-Split (2) / External EMS (3). Im Dauer-Forced bleibt der
  // Master in Modus 2, auch im Leerlauf (Besitz ja, Befehl Stopp); nur ohne Besitz/echte Rücknahme ist es Modus 0.
  function modeText(status) {
    const ems = status && status.sungrowEms;
    if (!ems) return DASH;
    const owns = ems.owns === true;
    const dec = ems.decision || {};
    if (!owns || dec.mode === 'self') return 'Eigenverbrauch (0)';
    if (ems.controlMode === 'external') return 'External EMS (3)';
    return status && status.sungrowSecond ? 'Forced-Split (2)' : 'Forced (2)';
  }
  // External EMS (Modus 3) aktiv? Nur dann läuft ein echter Herzschlag-Countdown (Feld: sonst fälschlich 30 s).
  function isExternalActive(ems) {
    if (!ems || ems.controlMode !== 'external') return false;
    return ems.owns === true && ems.decision && ems.decision.mode !== 'self'
      && (!ems.device || ems.device.mode == null || Number(ems.device.mode) === EMS_MODE_EXTERNAL);
  }
  // F1a: Countdown NUR im echten External EMS (Modus 3). Angezeigt wird der WIRKSAME (zuletzt gesendete/
  // gerätegemanagte) Wert heartbeatSentS, NICHT der Sollwert.
  function countdownText(ems) {
    if (!isExternalActive(ems)) return null;
    const s = num(ems.heartbeatSentS) ? Number(ems.heartbeatSentS) : null;
    return num(s) ? `${s} s` : null;
  }

  function splitText(ems) {
    const sp = ems && ems.decision && ems.decision.split;
    if (!sp) return DASH;
    return `${watt(sp.masterW)}/${watt(sp.slaveW)} (${sp.strategy || '?'})`;
  }
  // M7b: nur der Regelzyklus (wirksamer Takt). Die Antwortzeit steht EINMAL in der Modbus-Zeile (healthText),
  // nicht zusätzlich hier — sonst zwei „Antwort"-Werte.
  function regulateText(ems) {
    if (!ems || !num(ems.regulateEveryMs)) return DASH;
    return `Regelzyklus ${Math.round(Number(ems.regulateEveryMs))} ms`;
  }
  // Uhrzeit HH:MM aus einem Zeitstempel (ms) — für „letzter Fehler".
  function hhmm(ms) {
    if (!num(ms)) return '';
    try { const d = new Date(Number(ms)); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
    catch { return ''; }
  }
  // M22: Fehlerart wie im Protokoll (ECONNREFUSED ist „abgelehnt", nicht „Timeout").
  function errKindText(kind) {
    if (kind === 'timeout') return 'Timeout';
    if (kind === 'exception') return 'Ausnahme';
    if (kind === 'refused') return 'abgelehnt';
    if (kind === 'reset') return 'getrennt';
    if (kind === 'unreachable') return 'nicht erreichbar';
    return 'Fehler';
  }
  // Modbus-Gesundheit einer Verbindung (N5/M7b): Anfragen/s · Antwortzeit (EIN Median-Wert) · Fehler 24 h · letzter
  // Fehler mit Zeit. Der wirksame Takt/Regelzyklus steht separat (regulateText), nicht hier — sonst doppelt.
  function healthText(health) {
    const h = health || {};
    const parts = [];
    if (num(h.requestsPerSec)) parts.push(`${de(h.requestsPerSec)}/s`);
    if (num(h.responseMs)) parts.push(`Antwort ${Math.round(Number(h.responseMs))} ms`);
    parts.push(`Fehler 24 h ${num(h.errors24h) ? Math.round(Number(h.errors24h)) : 0}`);
    if (h.lastError && num(h.lastError.at)) parts.push(`zuletzt ${errKindText(h.lastError.kind)} ${hhmm(h.lastError.at)}`);
    return parts.length ? parts.join(' · ') : DASH;
  }
  // M14b: Tagesbudget des Einspeise-Abregelungs-Pfads (13074/13087/13088/31222)
  // neben „Writes heute". Eigener Zähler, getrennt vom 13050-EMS-Budget.
  function dvSeqBudgetText(budget) {
    if (!budget || !Number.isFinite(Number(budget.count))) return '';
    const left = Number.isFinite(Number(budget.left)) ? Number(budget.left) : null;
    return ` · Einspeise-Abregelung ${Number(budget.count) || 0}${left != null ? ` (Rest ${left})` : ''}`;
  }
  function writesText(ems, dvSeqBudget) {
    const w = ems && ems.writesToday;
    const dv = dvSeqBudgetText(dvSeqBudget);
    if (!w) return dv ? dv.replace(/^ · /, '') : DASH;
    const left = num(ems.modeBudgetLeft) ? Number(ems.modeBudgetLeft) : null;
    return `13050 ${w.mode13050 || 0}${left != null ? ` (Rest ${left})` : ''} · 13051 ${w.cmd13051 || 0} · 13052 ${w.power13052 || 0} · 13080 ${w.heartbeat13080 || 0}${dv}`;
  }
  // M28 (+ Grundsatz 0): Hinweis je WR, wenn er seinen Anteil nicht liefert. An der Grenze (SoC/Marge oder „liefert
  // nicht") → „Master an der Grenze, Slave übernimmt"; teilweise → „Master liefert nur 300 von 600 W, Slave übernimmt den
  // Rest"; kann der andere nichts übernehmen → „Slave liefert nur 600 von 1120 W". Sonst null.
  function takeoverText(wr, sp) {
    if (!sp) return null;
    const me = wr === 'master' ? 'Master' : 'Slave';
    const otherKey = wr === 'master' ? 'slave' : 'master';
    const other = wr === 'master' ? 'Slave' : 'Master';
    const limitW = sp[`${wr}LimitW`];
    const cmdW = sp[`${wr}W`];
    const baseW = num(sp[`${wr}BaseW`]) ? sp[`${wr}BaseW`] : cmdW;
    if (sp.takeover === otherKey) {
      if (sp.takeoverReason === 'partial' && num(limitW) && num(baseW)) return `${me} liefert nur ${Math.round(Number(limitW))} von ${Math.round(Number(baseW))} W, ${other} übernimmt den Rest`;
      return `${me} an der Grenze, ${other} übernimmt`;
    }
    if (num(limitW) && num(cmdW) && Number(cmdW) > Number(limitW)) return `${me} liefert nur ${Math.round(Number(limitW))} von ${Math.round(Number(cmdW))} W`;
    return null;
  }

  function fallbackText(ems) {
    if (!ems) return DASH;
    if (!num(ems.deviceFallbackAfterS)) return 'keiner';
    const n = Number(ems.deviceFallbackCount60s) || 0;
    return `${Math.round(Number(ems.deviceFallbackAfterS))} s${n ? ` · ${n}/min` : ''}`;
  }

  function masterRow(status) {
    const v = (status && status.victron) || {};
    const dev = v.device || {};
    const ems = status && status.sungrowEms;
    const sp = (ems && ems.decision && ems.decision.split) || null;
    // Befehl aus dem Master-Anteil (Split), sonst – ohne Split (master-only/extern) – aus der System-Entscheidung.
    const shareW = sp ? sp.masterW : (ems && ems.decision ? ems.decision.powerW : null);
    return {
      role: 'Master – gesteuert',
      model: dev.model || DASH,
      serial: dev.serial || DASH,
      bdc: kw(dev.bdcRatedW),
      // M1: gemeldeter SoC + echter (umgerechnet mit dem Gerätefenster 13059/13058).
      soc: socText(v.sungrowMasterSocPct != null ? v.sungrowMasterSocPct : v.soc, dev.minSocPctDevice, dev.maxSocPctDevice),
      battery: batteryDirText(v.sungrowMasterBatteryW != null ? v.sungrowMasterBatteryW : v.batteryPowerW),
      pv: watt(v.sungrowMasterPvW != null ? v.sungrowMasterPvW : v.pvPowerW),
      running: v.runningStateText || (dev.info && dev.info.runningStateText) || DASH,
      owns: ems ? ems.owns === true : false,
      command: commandText(ems && ems.decision, shareW),
      decision: decisionText(ems),
      heartbeat: ems ? heartbeatText(ems) : DASH,
      countdown: countdownText(ems),
      // Grenze = wirksamer Wert (min(Gerät 33047/33048, BDC)) je Richtung + SoC-Spanne der Anlage.
      limit: limitLine({
        chargeDeviceW: dev.maxChargeWDevice, dischargeDeviceW: dev.maxDischargeWDevice, bdcRatedW: dev.bdcRatedW,
        minSocPctDevice: dev.minSocPctDevice, maxSocPctDevice: dev.maxSocPctDevice,
        floorPct: sp ? sp.masterFloorPct : null, ceilPct: sp ? sp.masterCeilPct : null,
      }),
      limitDevice: limitDeviceHint({ chargeDeviceW: dev.maxChargeWDevice, dischargeDeviceW: dev.maxDischargeWDevice, bdcRatedW: dev.bdcRatedW }),
      // Notladung (runningState 16385): der WR lädt eigenmächtig unter seinem Min-SoC aus dem Netz.
      emergencyCharge: v.emergencyCharge === true,
      // M28: Master an seiner Grenze bzw. liefert nur teilweise, der Slave übernimmt (takeoverText).
      takeover: takeoverText('master', sp),
      split: splitText(ems),
      regulate: regulateText(ems),
      writes: writesText(ems, status && status.dvSeqBudget),
      fallback: fallbackText(ems),
      // N5: Modbus-Gesundheit des Master-Steuerpfads.
      health: healthText(ems && ems.health),
    };
  }

  function slaveRow(status) {
    const s = (status && status.sungrowSecond) || {};
    const ems = status && status.sungrowEms; // Split steht beim Master-EMS
    const emsSlave = status && status.sungrowEmsSlave;
    const sp = (ems && ems.decision && ems.decision.split) || null;
    const online = s.online === true;
    // „gesteuert", sobald eine Strategie den Slave steuert (nicht reines master-only). Im Dauer-Forced immer
    // gesteuert → schlicht „Slave – gesteuert" (nicht „…bei Vorgaben", Feld 15.11.). Fehlt die Strategie → gelesen.
    const controlled = (s.strategyCharge && s.strategyCharge !== 'master-only')
      || (s.strategyDischarge && s.strategyDischarge !== 'master-only');
    const shareW = sp ? sp.slaveW : (emsSlave && emsSlave.decision ? emsSlave.decision.powerW : null);
    const emergencyCharge = s.emergencyCharge === true || (sp ? sp.slaveEmergencyCharge === true : false);
    return {
      role: controlled ? 'Slave – gesteuert' : 'Slave – gelesen',
      online,
      bdc: kw(s.bdcRatedW),
      // M1: gemeldeter SoC + echter (Gerätefenster 13059/13058 des Slave).
      soc: online ? socText(s.socPct, s.minSocPctDevice, s.maxSocPctDevice) : DASH,
      battery: online ? batteryDirText(s.batteryPowerW) : DASH,
      pv: online ? watt(s.pvPowerW) : DASH,
      running: online ? (s.runningStateText || DASH) : 'Nicht erreichbar',
      owns: controlled && emsSlave ? emsSlave.owns === true : false,
      command: controlled ? commandText(ems && ems.decision, shareW) : DASH,
      decision: controlled ? decisionText(emsSlave) : DASH,
      heartbeat: controlled && emsSlave ? heartbeatText(emsSlave) : DASH,
      // Countdown gilt am Slave wie am Master nur im echten Modus 3.
      countdown: controlled ? countdownText(ems) : null,
      limit: limitLine({
        chargeDeviceW: s.maxChargeWDevice, dischargeDeviceW: s.maxDischargeWDevice, bdcRatedW: s.bdcRatedW,
        minSocPctDevice: s.minSocPctDevice, maxSocPctDevice: s.maxSocPctDevice,
        floorPct: sp ? sp.slaveFloorPct : null, ceilPct: sp ? sp.slaveCeilPct : null,
      }),
      limitDevice: limitDeviceHint({ chargeDeviceW: s.maxChargeWDevice, dischargeDeviceW: s.maxDischargeWDevice, bdcRatedW: s.bdcRatedW }),
      emergencyCharge,
      // Aufgabe 3: Slave-Fehler im Split → sein Anteil ging an den Master; Hinweis „Slave-Anteil am Master".
      fellBack: sp ? sp.slaveFellBack === true : false,
      // M28: Slave an seiner Grenze bzw. liefert nur teilweise, der Master übernimmt (takeoverText).
      takeover: takeoverText('slave', sp),
      regulate: controlled ? regulateText(emsSlave) : DASH,
      writes: controlled ? writesText(emsSlave) : DASH,
      // N5: Modbus-Gesundheit des Slave-Lesepfads (Poller) — auch ohne Steuerung aussagekräftig.
      health: healthText(s.health),
    };
  }

  function view(status) {
    const s = status || {};
    if (!s.sungrowSecond) return { hidden: true };
    const v = s.victron || {};
    return {
      hidden: false,
      mode: modeText(s),
      showCountdown: s.sungrowEms ? isExternalActive(s.sungrowEms) : false,
      master: masterRow(s),
      slave: slaveRow(s),
      // Summe (M5b): SoC = ECHTER System-SoC (energyBalance.battery.socPct, von planningSocPct real berechnet),
      // NICHT der gemeldete Fenster-Mittel (v.soc). Akku/PV = Systemsummen.
      sum: {
        pv: watt(v.sungrowSystemPvW),
        battery: batteryDirText(v.sungrowSystemBatteryW),
        soc: pct(v.soc),
        socReal: pct(s.energyBalance && s.energyBalance.battery ? s.energyBalance.battery.socPct : null),
      },
    };
  }

  function render(status, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const card = d && d.getElementById('sungrowWrCard');
    if (!card) return;
    const vw = view(status);
    card.hidden = vw.hidden;
    // Punkt 6 + Kann-3 (Feld 16.11.): bei zwei Sungrow-WR heißt der Akku „Sungrow" (einzeilig), die Rollen
    // „Master + Slave" stehen als Untertitel darunter — bei 300 px Spaltenbreite brach der lange Name sonst dreizeilig um.
    const nameEl = d && d.getElementById('batSourceName');
    if (nameEl) nameEl.textContent = vw.hidden ? 'Victron' : 'Sungrow';
    const subEl = d && d.getElementById('batSourceSub');
    if (subEl) { subEl.textContent = 'Master + Slave'; subEl.hidden = vw.hidden; }
    if (vw.hidden) return;
    const set = (id, text) => { const el = d.getElementById(id); if (el) el.textContent = text; };
    // M5c: lange Zeilen werden per CSS gekürzt (Ellipsis) — den VOLLEN Text als Tooltip (title) mitgeben, damit
    // nichts verloren geht („Besitz ja · Herzschlag …", „Takt Regel…", „Writes heute: …").
    const setT = (id, text) => { const el = d.getElementById(id); if (el) { el.textContent = text; el.title = text; } };
    const setHidden = (id, h) => { const el = d.getElementById(id); if (el) el.hidden = h; };
    // Badges je WR (Notladung / Slave-Anteil am Master): Text + sichtbar, sonst versteckt.
    const setBadges = (id, labels) => {
      const el = d.getElementById(id);
      if (!el) return;
      const list = (labels || []).filter(Boolean);
      el.textContent = list.join(' · ');
      el.hidden = list.length === 0;
    };
    // Raster je WR: Zeile 1 SoC|Akku|PV (3-Spalten-Grid), Zeile 2 Befehl (ganze Zeile), Zeile 3 Grenzen (ganze Zeile).
    // Countdown-Zeile nur im Modus 3.
    const fillGroup = (prefix, r) => {
      set(`${prefix}Soc`, r.soc); set(`${prefix}Akku`, r.battery); set(`${prefix}Pv`, r.pv);
      set(`${prefix}Cmd`, r.command);
      set(`${prefix}Limit`, r.limitDevice ? `${r.limit}  (${r.limitDevice})` : r.limit);
      set(`${prefix}Countdown`, r.countdown || DASH);
      setHidden(`${prefix}CountdownRow`, !(vw.showCountdown && r.countdown));
    };
    // Kopf: Modus auf EIGENER Zeile unter dem Titel (nicht daneben).
    set('sungrowWrMode', `Modus: ${vw.mode}`);
    set('sungrowWrMasterRole', vw.master.role);
    setBadges('sungrowWrMasterBadges', [vw.master.emergencyCharge ? 'Notladung' : null, vw.master.takeover]);
    set('sungrowWrMasterMeta', `${vw.master.model} · ${vw.master.serial} · BDC ${vw.master.bdc}`);
    fillGroup('sungrowWrMaster', vw.master);
    setT('sungrowWrMasterEms', `${vw.master.decision} · Besitz ${vw.master.owns ? 'ja' : 'nein'} · Herzschlag ${vw.master.heartbeat}`);
    setT('sungrowWrMasterSplit', `Aufteilung ${vw.master.split} · Takt ${vw.master.regulate} · Rückfall ${vw.master.fallback}`);
    setT('sungrowWrMasterHealth', vw.master.health);
    setT('sungrowWrMasterWrites', `Writes heute: ${vw.master.writes}`);
    set('sungrowWrSlaveRole', vw.slave.role);
    setBadges('sungrowWrSlaveBadges', [
      vw.slave.emergencyCharge ? 'Notladung' : null,
      vw.slave.fellBack ? 'Slave-Anteil am Master' : null,
      vw.slave.takeover,
    ]);
    // Slave online → Grid füllen; offline → nur die Statuszeile (Nicht erreichbar), Grid aus.
    if (vw.slave.online) { setHidden('sungrowWrSlaveStatus', true); setHidden('sungrowWrSlaveGrid', false); fillGroup('sungrowWrSlave', vw.slave); }
    else { set('sungrowWrSlaveStatus', vw.slave.running); setHidden('sungrowWrSlaveStatus', false); setHidden('sungrowWrSlaveGrid', true); }
    setT('sungrowWrSlaveEms', vw.slave.role.indexOf('gesteuert') >= 0 ? `${vw.slave.decision} · Besitz ${vw.slave.owns ? 'ja' : 'nein'} · Takt ${vw.slave.regulate}` : `BDC ${vw.slave.bdc}`);
    setT('sungrowWrSlaveHealth', vw.slave.health);
    setT('sungrowWrSlaveWrites', vw.slave.role.indexOf('gesteuert') >= 0 ? `Writes heute: ${vw.slave.writes}` : '');
    // Summe einzeilig im Kopfbereich (M5b): echter System-SoC, sonst gemeldeter als Rückfall.
    const sumSoc = vw.sum.socReal !== DASH ? `real ${vw.sum.socReal}` : `${vw.sum.soc} (gemeldet)`;
    set('sungrowWrSum', `Summe: SoC ${sumSoc} · Akku ${vw.sum.battery} · PV ${vw.sum.pv}`);
    wireReleaseButton(d);
  }

  // M2: den Freigabe-Button einmalig verdrahten (render läuft bei jedem Status-Update). POST /api/sungrow/release
  // über den Auth-Helfer (Bearer-Token). Mit Bestätigung; der Button nimmt den Forced/External-EMS-Betrieb zurück.
  function wireReleaseButton(d) {
    const btn = d.getElementById('sungrowWrReleaseBtn');
    if (!btn || btn.__wired || typeof btn.addEventListener !== 'function') return;
    btn.__wired = true;
    const statusEl = d.getElementById('sungrowWrReleaseStatus');
    const apiFetch = (typeof window !== 'undefined' && window.DVhubCommon && window.DVhubCommon.apiFetch) || null;
    btn.addEventListener('click', async () => {
      if (typeof window !== 'undefined' && window.confirm && !window.confirm('Sungrow freigeben: Master auf Eigenverbrauch (Modus 0), beide Wechselrichter auf Stopp (0xCC). Fortfahren?')) return;
      btn.disabled = true;
      if (statusEl) statusEl.textContent = 'läuft…';
      try {
        const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) };
        const res = apiFetch ? await apiFetch('/api/sungrow/release', opts) : await fetch('/api/sungrow/release', opts);
        let j = {};
        try { j = await res.json(); } catch { j = {}; }
        if (statusEl) statusEl.textContent = (res.ok && j.ok) ? 'freigegeben (Modus 0)' : ('Fehler' + (j.error ? ': ' + j.error : ''));
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Fehler: ' + (e && e.message ? e.message : 'Netzwerk');
      } finally {
        btn.disabled = false;
      }
    });
  }

  if (typeof window !== 'undefined') window.DVhubSungrowInverters = { view, render };
})();
