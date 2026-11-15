// sungrow-inverter-view.js — Leitstand-Kachel „Wechselrichter" für zwei Sungrow-WR (Master/Slave, T-0422).
//
// Zeigt je WR eine Zeile: Rolle, Modell/SN, Akku/PV/SoC/BDC, EMS-Modus/Befehl/Besitz/Herzschlag, dazu eine
// Summenzeile. Quelle ist /api/status (victron.device/sungrowMaster*/sungrowSystem*, sungrowSecond, sungrowEms,
// sungrowEmsSlave). Ohne zweiten WR bleibt die Kachel weg. view() ist reine Anzeige-Logik (testbar),
// render() setzt sie in die Kachel aus index.html. Keine LAN-IP (die steht nur in der Config).
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

  function decisionText(ems) {
    const d = ems && ems.decision;
    if (!d) return DASH;
    if (d.mode === 'self') return 'Eigenverbrauch';
    if (d.command === 'stop') return 'Zwangs-Stopp';
    const w = num(d.powerW) ? ` ${Math.round(Number(d.powerW))} W` : '';
    return (d.command === 'charge' ? 'Laden' : d.command === 'discharge' ? 'Entladen' : 'Zwang') + w;
  }
  function heartbeatText(ems) {
    if (!ems || ems.controlMode !== 'external') return 'Forced mode';
    if (ems.heartbeatSupported === false) return 'nicht übernommen';
    const fc = ems.heartbeatWorkingFc ? ` (FC ${ems.heartbeatWorkingFc})` : '';
    const dev = ems.heartbeatDeviceManaged ? ' Gerätewert' : '';
    const s = num(ems.heartbeatSentS) ? Number(ems.heartbeatSentS) : ems.heartbeatTimeoutS;
    return `${num(s) ? s + ' s' : DASH}${fc}${dev}`;
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
  // F1a: Countdown NUR im echten External EMS (Modus 3) — wenn DVhub ihn besitzt UND aktiv steuert (Befehl, nicht
  // Self). Im Eigenverbrauch (Modus 0) oder Forced mode (2) läuft kein Herzschlag-Countdown → „—" (Feld: fälschlich
  // 30 s im Modus 0). Angezeigt wird der WIRKSAME (zuletzt gesendete/gerätegemanagte) Wert, NICHT der Sollwert
  // (heartbeatTimeoutS).
  function countdownText(ems) {
    if (!ems || ems.controlMode !== 'external') return DASH;
    const activeExternal = ems.owns === true && ems.decision && ems.decision.mode !== 'self'
      && (!ems.device || ems.device.mode == null || Number(ems.device.mode) === EMS_MODE_EXTERNAL);
    if (!activeExternal) return DASH;
    const s = num(ems.heartbeatSentS) ? Number(ems.heartbeatSentS) : null; // wirksamer/gelesener Wert, nicht der Sollwert
    return num(s) ? `${s} s` : DASH;
  }
  // F1: Leistungsgrenze je WR (Laden/Entladen). Slave zeigt die gelesenen Gerätegrenzen (33047/33048), sonst BDC.
  function limitText({ charge, discharge, bdcRatedW }) {
    const c = num(charge) ? kw(charge) : kw(bdcRatedW);
    const d = num(discharge) ? kw(discharge) : kw(bdcRatedW);
    return `Lad ${c} / Entl ${d}`;
  }
  // Aufteilung + Regeltakt + Tages-Schreibzähler je WR (Punkt 1/2) für die Kachel.
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
  // Letzter geräteeigener Rückfall (Punkt 3): gemessene Zeit + Rate der letzten Minute.
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
    return {
      role: 'Master – gesteuert',
      model: dev.model || DASH,
      serial: dev.serial || DASH,
      bdc: kw(dev.bdcRatedW),
      soc: pct(v.sungrowMasterSocPct != null ? v.sungrowMasterSocPct : v.soc),
      battery: watt(v.sungrowMasterBatteryW != null ? v.sungrowMasterBatteryW : v.batteryPowerW),
      pv: watt(v.sungrowMasterPvW != null ? v.sungrowMasterPvW : v.pvPowerW),
      running: (dev.info && dev.info.runningStateText) || DASH,
      owns: ems ? ems.owns === true : false,
      decision: decisionText(ems),
      heartbeat: ems ? heartbeatText(ems) : DASH,
      countdown: countdownText(ems),
      // F1a: gelesene Master-Gerätegrenzen (33047/33048), sonst BDC — je Richtung getrennt (Laden 33047 ≠ Entladen 33048).
      limit: limitText({ charge: dev.maxChargeWDevice, discharge: dev.maxDischargeWDevice, bdcRatedW: dev.bdcRatedW }),
      split: splitText(ems),
      regulate: regulateText(ems),
      writes: writesText(ems),
      fallback: fallbackText(ems),
    };
  }
  function slaveRow(status) {
    const s = (status && status.sungrowSecond) || {};
    const ems = status && status.sungrowEmsSlave;
    const online = s.online === true;
    // „gesteuert", sobald eine Strategie den Slave steuert (nicht reines master-only). Fehlt die Strategie → gelesen.
    const controlled = (s.strategyCharge && s.strategyCharge !== 'master-only')
      || (s.strategyDischarge && s.strategyDischarge !== 'master-only');
    return {
      role: controlled ? 'Slave – gesteuert bei Vorgaben' : 'Slave – gelesen',
      online,
      bdc: kw(s.bdcRatedW),
      soc: online ? pct(s.socPct) : DASH,
      battery: online ? watt(s.batteryPowerW) : DASH,
      pv: online ? watt(s.pvPowerW) : DASH,
      running: online ? (s.runningStateText || DASH) : 'Nicht erreichbar',
      owns: controlled && ems ? ems.owns === true : false,
      decision: controlled ? decisionText(ems) : DASH,
      heartbeat: controlled && ems ? heartbeatText(ems) : DASH,
      countdown: controlled && ems ? countdownText(ems) : DASH,
      // F1: gelesene Slave-Gerätegrenzen (33047/33048), sonst BDC.
      limit: limitText({ charge: s.maxChargeWDevice, discharge: s.maxDischargeWDevice, bdcRatedW: s.bdcRatedW }),
      // Christin-Ergänzung: gemessene Rate/Antwortzeit JE WR (der Slave hat seinen eigenen Aktuator-Status).
      regulate: controlled ? regulateText(ems) : DASH,
      writes: controlled ? writesText(ems) : DASH,
    };
  }

  function view(status) {
    const s = status || {};
    if (!s.sungrowSecond) return { hidden: true };
    const v = s.victron || {};
    return {
      hidden: false,
      mode: modeText(s), // F1: welcher EMS-Modus gilt (0 / Forced-Split / External)
      master: masterRow(s),
      slave: slaveRow(s),
      sum: { pv: watt(v.sungrowSystemPvW), battery: watt(v.sungrowSystemBatteryW), soc: pct(v.soc) },
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
    // F1a: feste Spalten je Gruppe — SoC | Akku | PV ; Befehl | Countdown | Grenze — in getrennte Grid-Zellen,
    // NICHT als ein zusammengesetzter String (kein Wort-für-Wort-Umbruch, Label nie neben dem Wert).
    const fillGroup = (prefix, r) => {
      set(`${prefix}Soc`, r.soc); set(`${prefix}Akku`, r.battery); set(`${prefix}Pv`, r.pv);
      set(`${prefix}Cmd`, r.decision); set(`${prefix}Countdown`, r.countdown); set(`${prefix}Limit`, r.limit);
    };
    set('sungrowWrMode', `Modus: ${vw.mode}`);
    set('sungrowWrMasterRole', vw.master.role);
    set('sungrowWrMasterMeta', `${vw.master.model} · ${vw.master.serial} · BDC ${vw.master.bdc}`);
    fillGroup('sungrowWrMaster', vw.master);
    set('sungrowWrMasterEms', `${vw.master.decision} · Besitz ${vw.master.owns ? 'ja' : 'nein'} · Herzschlag ${vw.master.heartbeat}`);
    // Aufteilung + Regeltakt + Tages-Schreibzähler (Punkt 1/2).
    set('sungrowWrMasterSplit', `Aufteilung ${vw.master.split} · Takt ${vw.master.regulate} · Rückfall ${vw.master.fallback}`);
    set('sungrowWrMasterWrites', `Writes heute: ${vw.master.writes}`);
    set('sungrowWrSlaveRole', vw.slave.role);
    // Slave online → Grid füllen; offline → nur die Statuszeile (Nicht erreichbar), Grid aus.
    if (vw.slave.online) { setHidden('sungrowWrSlaveStatus', true); setHidden('sungrowWrSlaveGrid', false); fillGroup('sungrowWrSlave', vw.slave); }
    else { set('sungrowWrSlaveStatus', vw.slave.running); setHidden('sungrowWrSlaveStatus', false); setHidden('sungrowWrSlaveGrid', true); }
    set('sungrowWrSlaveEms', vw.slave.role.indexOf('gesteuert') >= 0 ? `${vw.slave.decision} · Besitz ${vw.slave.owns ? 'ja' : 'nein'} · Takt ${vw.slave.regulate}` : `BDC ${vw.slave.bdc}`);
    set('sungrowWrSlaveWrites', vw.slave.role.indexOf('gesteuert') >= 0 ? `Writes heute: ${vw.slave.writes}` : '');
    set('sungrowWrSumSoc', vw.sum.soc); set('sungrowWrSumAkku', vw.sum.battery); set('sungrowWrSumPv', vw.sum.pv);
  }

  if (typeof window !== 'undefined') window.DVhubSungrowInverters = { view, render };
})();
