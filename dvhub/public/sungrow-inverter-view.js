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
    const w = num(d.powerW) ? ` ${Math.round(Number(d.powerW))} W` : '';
    return (d.command === 'charge' ? 'Laden' : d.command === 'discharge' ? 'Entladen' : 'Zwang') + w;
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
  function regulateText(ems) {
    if (!ems || !num(ems.regulateEveryMs)) return DASH;
    const resp = num(ems.responseMs) ? ` · Antwort ${Math.round(Number(ems.responseMs))} ms` : '';
    return `${Math.round(Number(ems.regulateEveryMs))} ms${resp}`;
  }
  function writesText(ems) {
    const w = ems && ems.writesToday;
    if (!w) return DASH;
    const left = num(ems.modeBudgetLeft) ? Number(ems.modeBudgetLeft) : null;
    return `13050 ${w.mode13050 || 0}${left != null ? ` (Rest ${left})` : ''} · 13051 ${w.cmd13051 || 0} · 13052 ${w.power13052 || 0} · 13080 ${w.heartbeat13080 || 0}`;
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
      soc: pct(v.sungrowMasterSocPct != null ? v.sungrowMasterSocPct : v.soc),
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
      split: splitText(ems),
      regulate: regulateText(ems),
      writes: writesText(ems),
      fallback: fallbackText(ems),
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
      soc: online ? pct(s.socPct) : DASH,
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
      regulate: controlled ? regulateText(emsSlave) : DASH,
      writes: controlled ? writesText(emsSlave) : DASH,
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
      sum: { pv: watt(v.sungrowSystemPvW), battery: batteryDirText(v.sungrowSystemBatteryW), soc: pct(v.soc) },
    };
  }

  function render(status, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const card = d && d.getElementById('sungrowWrCard');
    if (!card) return;
    const vw = view(status);
    card.hidden = vw.hidden;
    // Punkt 6: bei zwei Sungrow-WR den Akku im Leitstand als „Sungrow (Master + Slave)" benennen (statt „Victron").
    const nameEl = d && d.getElementById('batSourceName');
    if (nameEl) nameEl.textContent = vw.hidden ? 'Victron' : 'Sungrow (Master + Slave)';
    if (vw.hidden) return;
    const set = (id, text) => { const el = d.getElementById(id); if (el) el.textContent = text; };
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
    setBadges('sungrowWrMasterBadges', [vw.master.emergencyCharge ? 'Notladung' : null]);
    set('sungrowWrMasterMeta', `${vw.master.model} · ${vw.master.serial} · BDC ${vw.master.bdc}`);
    fillGroup('sungrowWrMaster', vw.master);
    set('sungrowWrMasterEms', `${vw.master.decision} · Besitz ${vw.master.owns ? 'ja' : 'nein'} · Herzschlag ${vw.master.heartbeat}`);
    set('sungrowWrMasterSplit', `Aufteilung ${vw.master.split} · Takt ${vw.master.regulate} · Rückfall ${vw.master.fallback}`);
    set('sungrowWrMasterWrites', `Writes heute: ${vw.master.writes}`);
    set('sungrowWrSlaveRole', vw.slave.role);
    setBadges('sungrowWrSlaveBadges', [
      vw.slave.emergencyCharge ? 'Notladung' : null,
      vw.slave.fellBack ? 'Slave-Anteil am Master' : null,
    ]);
    // Slave online → Grid füllen; offline → nur die Statuszeile (Nicht erreichbar), Grid aus.
    if (vw.slave.online) { setHidden('sungrowWrSlaveStatus', true); setHidden('sungrowWrSlaveGrid', false); fillGroup('sungrowWrSlave', vw.slave); }
    else { set('sungrowWrSlaveStatus', vw.slave.running); setHidden('sungrowWrSlaveStatus', false); setHidden('sungrowWrSlaveGrid', true); }
    set('sungrowWrSlaveEms', vw.slave.role.indexOf('gesteuert') >= 0 ? `${vw.slave.decision} · Besitz ${vw.slave.owns ? 'ja' : 'nein'} · Takt ${vw.slave.regulate}` : `BDC ${vw.slave.bdc}`);
    set('sungrowWrSlaveWrites', vw.slave.role.indexOf('gesteuert') >= 0 ? `Writes heute: ${vw.slave.writes}` : '');
    set('sungrowWrSumSoc', vw.sum.soc); set('sungrowWrSumAkku', vw.sum.battery); set('sungrowWrSumPv', vw.sum.pv);
  }

  if (typeof window !== 'undefined') window.DVhubSungrowInverters = { view, render };
})();
