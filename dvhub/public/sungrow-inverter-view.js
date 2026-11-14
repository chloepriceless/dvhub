// sungrow-inverter-view.js — Leitstand-Kachel „Wechselrichter" für zwei Sungrow-WR (Master/Slave, T-0422).
//
// Zeigt je WR eine Zeile: Rolle, Modell/SN, Akku/PV/SoC/BDC, EMS-Modus/Befehl/Besitz/Herzschlag, dazu eine
// Summenzeile. Quelle ist /api/status (victron.device/sungrowMaster*/sungrowSystem*, sungrowSecond, sungrowEms,
// sungrowEmsSlave). Ohne zweiten WR bleibt die Kachel weg. view() ist reine Anzeige-Logik (testbar),
// render() setzt sie in die Kachel aus index.html. Keine LAN-IP (die steht nur in der Config).
(function () {
  'use strict';
  const DASH = '–';
  const num = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const watt = (v) => (num(v) ? `${Math.round(Number(v))} W` : DASH);
  const pct = (v) => (num(v) ? `${Math.round(Number(v) * 10) / 10} %` : DASH);
  const kw = (v) => (num(v) ? `${Math.round(Number(v) / 100) / 10} kW` : DASH);

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
    };
  }
  function slaveRow(status) {
    const s = (status && status.sungrowSecond) || {};
    const ems = status && status.sungrowEmsSlave;
    const online = s.online === true;
    const controlled = s.control === 'split';
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
    };
  }

  function view(status) {
    const s = status || {};
    if (!s.sungrowSecond) return { hidden: true };
    const v = s.victron || {};
    return {
      hidden: false,
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
    if (vw.hidden) return;
    const set = (id, text) => { const el = d.getElementById(id); if (el) el.textContent = text; };
    const line = (r) => `${r.soc} · Akku ${r.battery} · PV ${r.pv}`;
    set('sungrowWrMasterRole', vw.master.role);
    set('sungrowWrMasterMeta', `${vw.master.model} · ${vw.master.serial} · BDC ${vw.master.bdc}`);
    set('sungrowWrMasterVals', line(vw.master));
    set('sungrowWrMasterEms', `${vw.master.decision} · Besitz ${vw.master.owns ? 'ja' : 'nein'} · Herzschlag ${vw.master.heartbeat}`);
    set('sungrowWrSlaveRole', vw.slave.role);
    set('sungrowWrSlaveVals', vw.slave.online ? line(vw.slave) : vw.slave.running);
    set('sungrowWrSlaveEms', vw.slave.role.indexOf('gesteuert') >= 0 ? `${vw.slave.decision} · Besitz ${vw.slave.owns ? 'ja' : 'nein'} · Herzschlag ${vw.slave.heartbeat}` : `BDC ${vw.slave.bdc}`);
    set('sungrowWrSum', `System: Akku ${vw.sum.battery} · PV ${vw.sum.pv} · SoC ${vw.sum.soc}`);
  }

  if (typeof window !== 'undefined') window.DVhubSungrowInverters = { view, render };
})();
