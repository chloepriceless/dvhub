import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = process.env.DV_APP_CONFIG || path.join(__dirname, 'config.json');

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (Array.isArray(v)) out[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null) {
      out[k] = deepMerge(out[k], v);
    } else out[k] = v;
  }
  return out;
}

function loadConfig() {
  const defaults = {
    httpPort: 8080,
    apiToken: '',
    modbusListenHost: '0.0.0.0',
    modbusListenPort: 1502,
    offLeaseMs: 8 * 60 * 1000,
    meterPollMs: 2000,
    keepalivePulseSec: 60,
    gridPositiveMeans: 'feed_in',
    victron: {
      host: '192.168.20.19',
      port: 502,
      unitId: 100,
      timeoutMs: 1000
    },
    meter: {
      fc: 4,
      address: 820,
      quantity: 3,
      timeoutMs: 1200
    },
    points: {
      soc: { enabled: true, fc: 4, address: 843, quantity: 1, signed: false, scale: 1, offset: 0 },
      batteryPowerW: { enabled: true, fc: 4, address: 842, quantity: 1, signed: true, scale: 1, offset: 0 },
      pvPowerW: { enabled: true, fc: 4, address: 850, quantity: 1, signed: false, scale: 1, offset: 0 },
      acPvL1W: { enabled: true, fc: 4, address: 808, quantity: 1, signed: false, scale: 1, offset: 0 },
      acPvL2W: { enabled: true, fc: 4, address: 809, quantity: 1, signed: false, scale: 1, offset: 0 },
      acPvL3W: { enabled: true, fc: 4, address: 810, quantity: 1, signed: false, scale: 1, offset: 0 },
      gridSetpointW: { enabled: true, fc: 4, address: 2700, quantity: 1, signed: true, scale: 1, offset: 0 },
      minSocPct: { enabled: true, fc: 4, address: 2901, quantity: 1, signed: false, scale: 0.1, offset: 0 },
      selfConsumptionW: { enabled: true, fc: 4, address: 817, quantity: 3, signed: false, scale: 1, offset: 0, sumRegisters: true }
    },
    controlWrite: {
      gridSetpointW: { enabled: true, fc: 6, address: 2700, writeType: 'int16', signed: true, scale: 1, offset: 0 },
      chargeCurrentA: { enabled: true, fc: 6, address: 2705, writeType: 'int16', signed: true, scale: 1, offset: 0 },
      minSocPct: { enabled: true, fc: 6, address: 2901, writeType: 'uint16', signed: false, scale: 0.1, offset: 0 }
    },
    dvControl: {
      enabled: false,
      feedExcessDcPv: { enabled: true, fc: 6, address: 2848, writeType: 'uint16', signed: false, scale: 1, offset: 0 },
      dontFeedExcessAcPv: { enabled: true, fc: 6, address: 2850, writeType: 'uint16', signed: false, scale: 1, offset: 0 },
      negativePriceProtection: { enabled: true, gridSetpointW: -40 }
    },
    schedule: {
      timezone: 'Europe/Berlin',
      evaluateMs: 15000,
      defaultGridSetpointW: null,
      defaultChargeCurrentA: null,
      rules: []
    },
    scan: {
      host: '192.168.20.19',
      port: 502,
      unitId: 0,
      fc: 4,
      start: 2500,
      end: 2700,
      step: 10,
      quantity: 10,
      timeoutMs: 700,
      onlyNonZero: true
    },
    influx: {
      enabled: false,
      url: 'http://127.0.0.1:8086/api/v2/write',
      org: '',
      bucket: '',
      token: '',
      measurement: 'dv'
    },
    epex: {
      enabled: true,
      bzn: 'DE-LU',
      timezone: 'Europe/Berlin'
    }
  };

  if (!fs.existsSync(CONFIG_PATH)) return applyVictronDefaults(defaults);
  try {
    const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return applyVictronDefaults(deepMerge(defaults, fileCfg));
  } catch (e) {
    console.error('Config parse error, using defaults:', e.message);
    return applyVictronDefaults(defaults);
  }
}

function applyVictronDefaults(c) {
  const v = c.victron || {};
  const fill = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    obj.host = obj.host ?? v.host;
    obj.port = obj.port ?? v.port;
    obj.unitId = obj.unitId ?? v.unitId;
    obj.timeoutMs = obj.timeoutMs ?? v.timeoutMs;
  };
  fill(c.meter);
  for (const p of Object.values(c.points || {})) fill(p);
  for (const w of Object.values(c.controlWrite || {})) fill(w);
  if (c.dvControl) {
    for (const [k, v] of Object.entries(c.dvControl)) {
      if (v && typeof v === 'object' && k !== 'enabled') fill(v);
    }
  }
  return c;
}

const cfg = loadConfig();
const state = {
  dvRegs: { 0: 0, 1: 0, 3: 0, 4: 0 },
  ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: Date.now() },
  keepalive: {
    modbusLastQuery: null,
    appPulse: { periodSec: cfg.keepalivePulseSec }
  },
  meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
  victron: {
    updatedAt: 0,
    soc: null,
    batteryPowerW: null,
    pvPowerW: null,
    acPvL1W: null,
    acPvL2W: null,
    acPvL3W: null,
    pvTotalW: null,
    gridSetpointW: null,
    minSocPct: null,
    gridImportW: null,
    gridExportW: null,
    selfConsumptionW: null,
    batteryChargeW: null,
    batteryDischargeW: null,
    errors: {}
  },
  scan: { running: false, updatedAt: 0, params: null, rows: [], error: null },
  schedule: {
    rules: Array.isArray(cfg.schedule.rules) ? cfg.schedule.rules : [],
    config: {
      defaultGridSetpointW: cfg.schedule.defaultGridSetpointW,
      defaultChargeCurrentA: cfg.schedule.defaultChargeCurrentA
    },
    active: { gridSetpointW: null, chargeCurrentA: null },
    lastWrite: { gridSetpointW: null, chargeCurrentA: null },
    lastEvalAt: 0
  },
  energy: {
    day: null,
    importWh: 0,
    exportWh: 0,
    costEur: 0,
    revenueEur: 0,
    lastTs: 0
  },
  epex: { ok: false, date: null, nextDate: null, updatedAt: 0, data: [], error: null },
  log: []
};

let tidCounter = 1;

function persistConfig() {
  try {
    const current = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
    current.schedule = current.schedule || {};
    current.schedule.rules = state.schedule.rules;
    current.schedule.defaultGridSetpointW = state.schedule.config.defaultGridSetpointW;
    current.schedule.defaultChargeCurrentA = state.schedule.config.defaultChargeCurrentA;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
  } catch (e) {
    pushLog('config_persist_error', { error: e.message });
  }
}

const ENERGY_PATH = path.join(__dirname, 'energy_state.json');

function persistEnergy() {
  try {
    const data = {
      day: state.energy.day,
      importWh: state.energy.importWh,
      exportWh: state.energy.exportWh,
      costEur: state.energy.costEur,
      revenueEur: state.energy.revenueEur,
      lastTs: state.energy.lastTs,
      savedAt: Date.now()
    };
    fs.writeFileSync(ENERGY_PATH, JSON.stringify(data) + '\n', 'utf8');
  } catch (e) {
    // silent - avoid recursive log if pushLog triggers persist
  }
}

function loadEnergy() {
  try {
    if (!fs.existsSync(ENERGY_PATH)) return;
    const data = JSON.parse(fs.readFileSync(ENERGY_PATH, 'utf8'));
    const today = berlinDateString();
    if (data.day === today) {
      state.energy.day = data.day;
      state.energy.importWh = Number(data.importWh) || 0;
      state.energy.exportWh = Number(data.exportWh) || 0;
      state.energy.costEur = Number(data.costEur) || 0;
      state.energy.revenueEur = Number(data.revenueEur) || 0;
      state.energy.lastTs = Number(data.lastTs) || 0;
      console.log(`Energy state restored for ${data.day}: import=${(state.energy.importWh / 1000).toFixed(2)}kWh export=${(state.energy.exportWh / 1000).toFixed(2)}kWh`);
    } else {
      console.log(`Energy state file is from ${data.day}, today is ${today} - starting fresh`);
    }
  } catch (e) {
    console.error('Failed to load energy state:', e.message);
  }
}

function nowIso() { return new Date().toISOString(); }
function pushLog(event, details = {}) {
  const row = { ts: nowIso(), event, ...details };
  state.log.push(row);
  if (state.log.length > 1000) state.log.shift();
}

function u16(v) {
  let x = Math.trunc(Number(v) || 0);
  if (x < 0) x += 0x10000;
  return x & 0xffff;
}
function s16(v) {
  const x = Number(v) & 0xffff;
  return x >= 0x8000 ? x - 0x10000 : x;
}

const MAX_BODY_BYTES = 256 * 1024; // 256 KB

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('body too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function berlinDateString(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: cfg.epex.timezone }).format(d);
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function localWeekdayIndex(date = new Date()) {
  const s = date.toLocaleString('en-US', { timeZone: cfg.schedule.timezone, weekday: 'short' });
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[s] ?? 0;
}

function localMinutesOfDay(date = new Date()) {
  const hh = Number(date.toLocaleString('en-GB', { timeZone: cfg.schedule.timezone, hour: '2-digit', hour12: false }));
  const mm = Number(date.toLocaleString('en-GB', { timeZone: cfg.schedule.timezone, minute: '2-digit', hour12: false }));
  return hh * 60 + mm;
}

function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function gridDirection(value) {
  const v = Number(value) || 0;
  const positiveFeedIn = cfg.gridPositiveMeans !== 'grid_import';
  if (v === 0) return { mode: 'neutral', label: 'neutral' };
  const exporting = positiveFeedIn ? v > 0 : v < 0;
  return exporting ? { mode: 'feed_in', label: 'Einspeisung' } : { mode: 'grid_import', label: 'Netzbezug' };
}

function expireLeaseIfNeeded() {
  if (state.ctrl.forcedOff && Date.now() > state.ctrl.offUntil) {
    state.ctrl.forcedOff = false;
    state.ctrl.offUntil = 0;
    state.ctrl.lastSignal = 'lease_expired';
    state.ctrl.updatedAt = Date.now();
    pushLog('ctrl_lease_expired');
    applyDvVictronControl(true);
  }
}

function setForcedOff(reason) {
  state.ctrl.forcedOff = true;
  state.ctrl.offUntil = Date.now() + cfg.offLeaseMs;
  state.ctrl.lastSignal = reason;
  state.ctrl.updatedAt = Date.now();
  pushLog('ctrl_off', { reason, offUntil: new Date(state.ctrl.offUntil).toISOString() });
  applyDvVictronControl(false);
}

function clearForcedOff(reason) {
  state.ctrl.forcedOff = false;
  state.ctrl.offUntil = 0;
  state.ctrl.lastSignal = reason;
  state.ctrl.updatedAt = Date.now();
  pushLog('ctrl_on', { reason });
  applyDvVictronControl(true);
}

async function applyDvVictronControl(feedIn) {
  const dc = cfg.dvControl;
  if (!dc?.enabled) return;
  const results = {};

  // Feed excess DC-coupled PV into grid: 1 = feed, 0 = block
  if (dc.feedExcessDcPv?.enabled) {
    const val = feedIn ? 1 : 0;
    try {
      await mbWriteSingle({
        host: dc.feedExcessDcPv.host,
        port: dc.feedExcessDcPv.port,
        unitId: dc.feedExcessDcPv.unitId,
        address: dc.feedExcessDcPv.address,
        value: val,
        timeoutMs: dc.feedExcessDcPv.timeoutMs
      });
      results.feedExcessDcPv = { ok: true, value: val };
      pushLog('dv_victron_write', { register: 'feedExcessDcPv', address: dc.feedExcessDcPv.address, value: val, feedIn });
    } catch (e) {
      results.feedExcessDcPv = { ok: false, error: e.message };
      pushLog('dv_victron_write_error', { register: 'feedExcessDcPv', error: e.message });
    }
  }

  // Don't feed excess AC-coupled PV into grid: 1 = block, 0 = allow
  if (dc.dontFeedExcessAcPv?.enabled) {
    const val = feedIn ? 0 : 1;
    try {
      await mbWriteSingle({
        host: dc.dontFeedExcessAcPv.host,
        port: dc.dontFeedExcessAcPv.port,
        unitId: dc.dontFeedExcessAcPv.unitId,
        address: dc.dontFeedExcessAcPv.address,
        value: val,
        timeoutMs: dc.dontFeedExcessAcPv.timeoutMs
      });
      results.dontFeedExcessAcPv = { ok: true, value: val };
      pushLog('dv_victron_write', { register: 'dontFeedExcessAcPv', address: dc.dontFeedExcessAcPv.address, value: val, feedIn });
    } catch (e) {
      results.dontFeedExcessAcPv = { ok: false, error: e.message };
      pushLog('dv_victron_write_error', { register: 'dontFeedExcessAcPv', error: e.message });
    }
  }

  state.ctrl.dvControl = { feedIn, ...results, at: Date.now() };
}

function controlValue() {
  expireLeaseIfNeeded();
  return state.ctrl.forcedOff ? 0 : 1;
}

function setReg(addr, value) { state.dvRegs[addr] = u16(value); }
function getReg(addr) { return u16(state.dvRegs[addr] ?? 0); }

function buildException(tid, unit, fc, code) {
  const b = Buffer.alloc(9);
  b.writeUInt16BE(tid, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(3, 4);
  b.writeUInt8(unit, 6);
  b.writeUInt8((fc | 0x80) & 0xff, 7);
  b.writeUInt8(code, 8);
  return b;
}

function buildReadResp(tid, unit, fc, addr, qty) {
  const byteCount = qty * 2;
  const out = Buffer.alloc(9 + byteCount);
  out.writeUInt16BE(tid, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(3 + byteCount, 4);
  out.writeUInt8(unit, 6);
  out.writeUInt8(fc, 7);
  out.writeUInt8(byteCount, 8);
  const regs = [];
  for (let i = 0; i < qty; i++) {
    const v = getReg(addr + i);
    regs.push(v);
    out.writeUInt16BE(v, 9 + i * 2);
  }
  return { out, regs };
}

function handleWriteSignal(addr, values) {
  if (addr === 0 && values.length >= 2) {
    if (values[0] === 0 && values[1] === 0) return setForcedOff('fc16_addr0_0000');
    if (values[0] === 0xffff && values[1] === 0xffff) return clearForcedOff('fc16_addr0_ffff');
  }
  if (addr === 3 && values.length >= 1) {
    if (values[0] === 1) return setForcedOff('fc16_addr3_0001');
    if (values[0] === 0) return clearForcedOff('fc16_addr3_0000');
  }
}

function rememberModbusQuery({ remote, fc, addr, qty, sample }) {
  state.keepalive.modbusLastQuery = {
    ts: Date.now(),
    remote,
    fc,
    addr,
    qty,
    sample
  };
}

function processModbusFrame(frame, remote) {
  if (frame.length < 8) return null;
  const tid = frame.readUInt16BE(0);
  const pid = frame.readUInt16BE(2);
  const len = frame.readUInt16BE(4);
  if (pid !== 0 || len < 2 || frame.length < 6 + len) return null;
  const unit = frame.readUInt8(6);
  const fc = frame.readUInt8(7);

  expireLeaseIfNeeded();

  if (fc === 3 || fc === 4) {
    if (len < 6) return buildException(tid, unit, fc, 3);
    const addr = frame.readUInt16BE(8);
    const qty = frame.readUInt16BE(10);
    if (qty < 1 || qty > 125) return buildException(tid, unit, fc, 3);
    const { out, regs } = buildReadResp(tid, unit, fc, addr, qty);
    rememberModbusQuery({ remote, fc, addr, qty, sample: regs.slice(0, 8) });
    return out;
  }

  if (fc === 6) {
    if (len < 6) return buildException(tid, unit, fc, 3);
    const addr = frame.readUInt16BE(8);
    const val = frame.readUInt16BE(10);
    setReg(addr, val);
    handleWriteSignal(addr, [val]);
    pushLog('modbus_fc6', { remote, addr, value: val, forcedOff: state.ctrl.forcedOff });
    return frame.subarray(0, 12);
  }

  if (fc === 16) {
    if (len < 7) return buildException(tid, unit, fc, 3);
    const addr = frame.readUInt16BE(8);
    const qty = frame.readUInt16BE(10);
    const bc = frame.readUInt8(12);
    if (bc !== qty * 2) return buildException(tid, unit, fc, 3);
    if (13 + bc > 6 + len) return buildException(tid, unit, fc, 3);

    const values = [];
    for (let i = 0; i < qty; i++) {
      const v = frame.readUInt16BE(13 + i * 2);
      values.push(v);
      setReg(addr + i, v);
    }
    handleWriteSignal(addr, values);
    pushLog('modbus_fc16', { remote, addr, qty, values, forcedOff: state.ctrl.forcedOff });

    const ack = Buffer.alloc(12);
    ack.writeUInt16BE(tid, 0);
    ack.writeUInt16BE(0, 2);
    ack.writeUInt16BE(6, 4);
    ack.writeUInt8(unit, 6);
    ack.writeUInt8(16, 7);
    ack.writeUInt16BE(addr, 8);
    ack.writeUInt16BE(qty, 10);
    return ack;
  }

  return buildException(tid, unit, fc, 1);
}

let mbServer = null;
function startModbusServer() {
  const server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 7) {
        const len = buffer.readUInt16BE(4);
        const total = 6 + len;
        if (buffer.length < total) break;

        const frame = buffer.subarray(0, total);
        buffer = buffer.subarray(total);
        const resp = processModbusFrame(frame, remote);
        if (resp) socket.write(resp);
      }
    });
    socket.on('error', () => {});
  });

  server.listen(cfg.modbusListenPort, cfg.modbusListenHost, () => {
    console.log(`Modbus server listening on ${cfg.modbusListenHost}:${cfg.modbusListenPort}`);
  });
  mbServer = server;
}

const mbPool = new Map();
const MB_IDLE_MS = 30000;

function getMbConn(host, port) {
  const key = `${host}:${port}`;
  let c = mbPool.get(key);
  if (c && !c.destroyed) return c;

  c = {
    key,
    sock: null,
    destroyed: false,
    buf: Buffer.alloc(0),
    pending: null,
    queue: [],
    idleTimer: null,
    connect() {
      if (this.sock && !this.sock.destroyed) return;
      this.sock = new net.Socket();
      this.sock.setKeepAlive(true, 10000);
      this.sock.connect(port, host);
      this.sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        this._drain();
      });
      this.sock.on('error', (e) => this._fail(e));
      this.sock.on('close', () => this._fail(new Error('connection closed')));
    },
    _resetIdle() {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.destroy(), MB_IDLE_MS);
    },
    _drain() {
      while (this.pending && this.buf.length >= 7) {
        const len = this.buf.readUInt16BE(4);
        const total = 6 + len;
        if (this.buf.length < total) break;
        const frame = this.buf.subarray(0, total);
        this.buf = this.buf.subarray(total);
        const p = this.pending;
        this.pending = null;
        if (p.timer) clearTimeout(p.timer);
        p.resolve(frame);
        this._resetIdle();
        this._next();
      }
    },
    _fail(err) {
      const p = this.pending;
      if (p) {
        this.pending = null;
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      for (const q of this.queue) {
        if (q.timer) clearTimeout(q.timer);
        q.reject(err);
      }
      this.queue = [];
      this.buf = Buffer.alloc(0);
      if (this.sock && !this.sock.destroyed) this.sock.destroy();
      this.sock = null;
    },
    destroy() {
      this.destroyed = true;
      this._fail(new Error('pool cleanup'));
      mbPool.delete(this.key);
    },
    send(reqBuf, timeoutMs) {
      return new Promise((resolve, reject) => {
        const entry = { reqBuf, resolve, reject, timer: null, timeoutMs };
        this.queue.push(entry);
        this._next();
      });
    },
    _next() {
      if (this.pending || !this.queue.length) return;
      if (!this.sock || this.sock.destroyed) {
        this.connect();
        this.sock.once('connect', () => this._next());
        return;
      }
      if (!this.sock.writable) {
        this.connect();
        this.sock.once('connect', () => this._next());
        return;
      }
      const entry = this.queue.shift();
      this.pending = entry;
      entry.timer = setTimeout(() => {
        if (this.pending === entry) {
          this.pending = null;
          entry.reject(new Error('modbus timeout'));
          if (this.sock && !this.sock.destroyed) this.sock.destroy();
          this.sock = null;
          this._next();
        }
      }, entry.timeoutMs || 1000);
      this.sock.write(entry.reqBuf);
    }
  };
  mbPool.set(key, c);
  return c;
}

function mbRequest({ host, port, unitId, fc, address, quantity, timeoutMs }) {
  const tid = (tidCounter++ & 0xffff) || 1;
  const req = Buffer.alloc(12);
  req.writeUInt16BE(tid, 0);
  req.writeUInt16BE(0, 2);
  req.writeUInt16BE(6, 4);
  req.writeUInt8(unitId, 6);
  req.writeUInt8(fc, 7);
  req.writeUInt16BE(address, 8);
  req.writeUInt16BE(quantity, 10);

  const conn = getMbConn(host, port);
  return conn.send(req, timeoutMs).then((frame) => {
    const rTid = frame.readUInt16BE(0);
    const pid = frame.readUInt16BE(2);
    const unit = frame.readUInt8(6);
    const rFc = frame.readUInt8(7);
    if (pid !== 0 || unit !== unitId || rTid !== tid) throw new Error('invalid modbus response');
    if ((rFc & 0x80) === 0x80) throw new Error(`modbus exception ${frame.readUInt8(8)}`);
    if (rFc !== fc) throw new Error(`unexpected fc ${rFc}`);
    const byteCount = frame.readUInt8(8);
    const data = frame.subarray(9, 9 + byteCount);
    const regs = [];
    for (let i = 0; i + 1 < data.length; i += 2) regs.push(data.readUInt16BE(i));
    return regs;
  });
}

function mbWriteSingle({ host, port, unitId, address, value, timeoutMs }) {
  const tid = (tidCounter++ & 0xffff) || 1;
  const req = Buffer.alloc(12);
  req.writeUInt16BE(tid, 0);
  req.writeUInt16BE(0, 2);
  req.writeUInt16BE(6, 4);
  req.writeUInt8(unitId, 6);
  req.writeUInt8(6, 7);
  req.writeUInt16BE(address, 8);
  req.writeUInt16BE(value & 0xffff, 10);

  const conn = getMbConn(host, port);
  return conn.send(req, timeoutMs).then((frame) => {
    const rTid = frame.readUInt16BE(0);
    const pid = frame.readUInt16BE(2);
    const unit = frame.readUInt8(6);
    const fc = frame.readUInt8(7);
    if (pid !== 0 || unit !== unitId || rTid !== tid || fc !== 6) throw new Error('invalid write ack');
    return { addr: frame.readUInt16BE(8), value: frame.readUInt16BE(10) };
  });
}

function mbWriteMultiple({ host, port, unitId, address, values, timeoutMs }) {
  const words = Array.isArray(values) ? values.map((v) => Number(v) & 0xffff) : [];
  if (!words.length) return Promise.reject(new Error('modbus write multiple: empty values'));
  if (words.length > 123) return Promise.reject(new Error('modbus write multiple: too many values'));

  const tid = (tidCounter++ & 0xffff) || 1;
  const qty = words.length;
  const byteCount = qty * 2;
  const req = Buffer.alloc(13 + byteCount);
  req.writeUInt16BE(tid, 0);
  req.writeUInt16BE(0, 2);
  req.writeUInt16BE(7 + byteCount, 4);
  req.writeUInt8(unitId, 6);
  req.writeUInt8(16, 7);
  req.writeUInt16BE(address, 8);
  req.writeUInt16BE(qty, 10);
  req.writeUInt8(byteCount, 12);
  for (let i = 0; i < qty; i += 1) req.writeUInt16BE(words[i], 13 + i * 2);

  const conn = getMbConn(host, port);
  return conn.send(req, timeoutMs).then((frame) => {
    const rTid = frame.readUInt16BE(0);
    const pid = frame.readUInt16BE(2);
    const unit = frame.readUInt8(6);
    const fc = frame.readUInt8(7);
    if (pid !== 0 || unit !== unitId || rTid !== tid || fc !== 16) throw new Error('invalid write ack');
    return { addr: frame.readUInt16BE(8), quantity: frame.readUInt16BE(10) };
  });
}

function pointFromRegs(regs, conf) {
  if (!regs || !regs.length) return null;
  const scale = Number(conf.scale ?? 1);
  const offset = Number(conf.offset ?? 0);
  if (conf.quantity > 1 && conf.sumRegisters) {
    let sum = 0;
    for (const r of regs) sum += conf.signed ? s16(r) : r;
    const v = sum * scale + offset;
    return Number(v.toFixed(3));
  }
  let v = regs[0];
  if (conf.signed) v = s16(v);
  v = Number(v) * scale + offset;
  return Number(v.toFixed(3));
}

function toRawForWrite(value, conf) {
  const scale = Number(conf.scale ?? 1);
  const offset = Number(conf.offset ?? 0);
  if (!Number.isFinite(scale) || scale === 0) throw new Error('invalid write scale');
  const engineeringValue = Number(value);
  if (!Number.isFinite(engineeringValue)) throw new Error('invalid write value');

  const writeTypeRaw = String(conf.writeType || (conf.signed ? 'int16' : 'uint16')).toLowerCase();
  const writeType = writeTypeRaw === 'signed' || writeTypeRaw === 's16'
    ? 'int16'
    : writeTypeRaw === 'unsigned' || writeTypeRaw === 'u16'
      ? 'uint16'
      : writeTypeRaw;
  const wordOrderRaw = String(conf.wordOrder || 'be').toLowerCase();
  const wordOrder = (wordOrderRaw === 'le' || wordOrderRaw === 'little' || wordOrderRaw === 'swapped' || wordOrderRaw === 'swap') ? 'le' : 'be';
  const scaled = Math.round((engineeringValue - offset) / scale);

  if (writeType === 'int16') {
    if (scaled < -32768 || scaled > 32767) throw new Error(`int16 range exceeded: ${scaled}`);
    const b = Buffer.allocUnsafe(2);
    b.writeInt16BE(scaled, 0);
    const raw = b.readUInt16BE(0);
    return { raw, words: [raw], scaled, writeType, wordOrder: 'be' };
  }

  if (writeType === 'uint16') {
    if (scaled < 0 || scaled > 65535) throw new Error(`uint16 range exceeded: ${scaled}`);
    const raw = scaled & 0xffff;
    return { raw, words: [raw], scaled, writeType, wordOrder: 'be' };
  }

  if (writeType === 'int32') {
    if (scaled < -2147483648 || scaled > 2147483647) throw new Error(`int32 range exceeded: ${scaled}`);
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(scaled, 0);
    const words = [b.readUInt16BE(0), b.readUInt16BE(2)];
    if (wordOrder === 'le') words.reverse();
    return { raw: words[0], words, scaled, writeType, wordOrder };
  }

  if (writeType === 'uint32') {
    if (scaled < 0 || scaled > 4294967295) throw new Error(`uint32 range exceeded: ${scaled}`);
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(scaled, 0);
    const words = [b.readUInt16BE(0), b.readUInt16BE(2)];
    if (wordOrder === 'le') words.reverse();
    return { raw: words[0], words, scaled, writeType, wordOrder };
  }

  throw new Error(`unsupported writeType: ${conf.writeType}`);
}

async function pollPoint(name, conf) {
  if (!conf?.enabled) return;
  try {
    const regs = await mbRequest(conf);
    state.victron[name] = pointFromRegs(regs, conf);
    delete state.victron.errors[name];
    state.victron.updatedAt = Date.now();
  } catch (e) {
    state.victron.errors[name] = e.message;
    state.victron.updatedAt = Date.now();
  }
}

function updateEnergyIntegrals(nowMs, totalW) {
  const day = berlinDateString(new Date(nowMs));
  if (state.energy.day !== day) {
    if (state.energy.day) {
      pushLog('energy_day_end', {
        day: state.energy.day,
        importKwh: Number((state.energy.importWh / 1000).toFixed(4)),
        exportKwh: Number((state.energy.exportWh / 1000).toFixed(4)),
        costEur: Number(state.energy.costEur.toFixed(4)),
        revenueEur: Number(state.energy.revenueEur.toFixed(4))
      });
    }
    state.energy.day = day;
    state.energy.importWh = 0;
    state.energy.exportWh = 0;
    state.energy.costEur = 0;
    state.energy.revenueEur = 0;
    state.energy.lastTs = nowMs;
    persistEnergy();
    return;
  }
  if (!state.energy.lastTs) {
    state.energy.lastTs = nowMs;
    return;
  }
  const dtH = Math.max(0, (nowMs - state.energy.lastTs) / 3600000);
  state.energy.lastTs = nowMs;
  if (dtH <= 0) return;

  const dir = gridDirection(totalW);
  const pAbs = Math.abs(Number(totalW) || 0);
  const importW = dir.mode === 'grid_import' ? pAbs : 0;
  const exportW = dir.mode === 'feed_in' ? pAbs : 0;
  state.energy.importWh += importW * dtH;
  state.energy.exportWh += exportW * dtH;

  const priceCt = Number(epexNowNext()?.current?.ct_kwh ?? 0);
  const priceEurKwh = priceCt / 100;
  state.energy.costEur += (importW / 1000) * dtH * priceEurKwh;
  state.energy.revenueEur += (exportW / 1000) * dtH * priceEurKwh;
}

let influxBuffer = [];
const INFLUX_FLUSH_MS = 10000;

async function flushInflux() {
  if (!cfg.influx.enabled || !influxBuffer.length) return;
  const lines = influxBuffer.splice(0);
  try {
    const qp = new URLSearchParams({ org: cfg.influx.org, bucket: cfg.influx.bucket, precision: 's' });
    const url = `${cfg.influx.url}?${qp.toString()}`;
    const body = lines.join('\n');
    const headers = { 'content-type': 'text/plain; charset=utf-8' };
    if (cfg.influx.token) headers.Authorization = `Token ${cfg.influx.token}`;
    const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    pushLog('influx_error', { error: e.message });
  }
}

function bufferInflux(lines) {
  if (!cfg.influx.enabled || !lines.length) return;
  influxBuffer.push(...lines);
}

function buildInfluxLines(nowSec) {
  const m = cfg.influx.measurement;
  const lines = [];
  const meter = state.meter;
  const vic = state.victron;
  lines.push(`${m},source=meter grid_l1_w=${Number(meter.grid_l1_w || 0)},grid_l2_w=${Number(meter.grid_l2_w || 0)},grid_l3_w=${Number(meter.grid_l3_w || 0)},grid_total_w=${Number(meter.grid_total_w || 0)} ${nowSec}`);
  lines.push(`${m},source=ctrl dv_control=${Number(controlValue())},forced_off=${state.ctrl.forcedOff ? 1 : 0} ${nowSec}`);
  const f = [];
  for (const [k, v] of Object.entries(vic)) {
    if (k === 'errors' || k === 'updatedAt') continue;
    if (v == null || Number.isNaN(Number(v))) continue;
    f.push(`${k}=${Number(v)}`);
  }
  if (f.length) lines.push(`${m},source=victron ${f.join(',')} ${nowSec}`);
  lines.push(`${m},source=energy import_wh=${state.energy.importWh.toFixed(3)},export_wh=${state.energy.exportWh.toFixed(3)},cost_eur=${state.energy.costEur.toFixed(6)},revenue_eur=${state.energy.revenueEur.toFixed(6)} ${nowSec}`);
  return lines;
}

async function pollMeter() {
  try {
    const regs = await mbRequest(cfg.meter);
    const rawL1 = regs.length > 0 ? s16(regs[0]) : 0;
    const rawL2 = regs.length > 1 ? s16(regs[1]) : 0;
    const rawL3 = regs.length > 2 ? s16(regs[2]) : 0;
    const rawTotal = rawL1 + rawL2 + rawL3;

    const posImport = cfg.gridPositiveMeans === 'grid_import';
    const sign = posImport ? 1 : -1;
    const l1 = rawL1 * sign;
    const l2 = rawL2 * sign;
    const l3 = rawL3 * sign;
    const total = rawTotal * sign;

    state.meter = {
      ok: true,
      updatedAt: Date.now(),
      raw: regs,
      grid_l1_w: l1,
      grid_l2_w: l2,
      grid_l3_w: l3,
      grid_total_w: total,
      error: null
    };

    setReg(0, u16(total));
    setReg(1, total < 0 ? 0xffff : 0x0000);
    setReg(3, 0);
    setReg(4, 0);

    updateEnergyIntegrals(state.meter.updatedAt, total);
  } catch (e) {
    state.meter.ok = false;
    state.meter.error = e.message;
    state.meter.updatedAt = Date.now();
  }

  await Promise.all([
    pollPoint('soc', cfg.points.soc),
    pollPoint('batteryPowerW', cfg.points.batteryPowerW),
    pollPoint('pvPowerW', cfg.points.pvPowerW),
    pollPoint('acPvL1W', cfg.points.acPvL1W),
    pollPoint('acPvL2W', cfg.points.acPvL2W),
    pollPoint('acPvL3W', cfg.points.acPvL3W),
    pollPoint('gridSetpointW', cfg.points.gridSetpointW),
    pollPoint('minSocPct', cfg.points.minSocPct),
    pollPoint('selfConsumptionW', cfg.points.selfConsumptionW)
  ]);

  const pvDc = Number(state.victron.pvPowerW || 0);
  const pvAc = Number(state.victron.acPvL1W || 0) + Number(state.victron.acPvL2W || 0) + Number(state.victron.acPvL3W || 0);
  state.victron.pvTotalW = Number((pvDc + pvAc).toFixed(3));

  const gridW = state.meter.grid_total_w || 0;
  const posImport = cfg.gridPositiveMeans === 'grid_import';
  state.victron.gridImportW = Math.max(0, posImport ? gridW : -gridW);
  state.victron.gridExportW = Math.max(0, posImport ? -gridW : gridW);

  const batP = Number(state.victron.batteryPowerW || 0);
  state.victron.batteryChargeW = Math.max(0, batP);
  state.victron.batteryDischargeW = Math.max(0, -batP);

  bufferInflux(buildInfluxLines(Math.floor(Date.now() / 1000)));
}

async function fetchEpexDay() {
  if (!cfg.epex.enabled) return;
  const day = berlinDateString();
  const day2 = addDays(day, 1);
  const url = `https://api.energy-charts.info/price?bzn=${encodeURIComponent(cfg.epex.bzn)}&start=${day}&end=${day2}`;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const p = await r.json();
    const unix = Array.isArray(p?.unix_seconds) ? p.unix_seconds : [];
    const prices = Array.isArray(p?.price) ? p.price : [];
    const n = Math.min(unix.length, prices.length);
    const data = [];

    for (let i = 0; i < n; i++) {
      const sec = Number(unix[i]);
      const eur = Number(prices[i]);
      if (!Number.isFinite(sec) || !Number.isFinite(eur)) continue;
      const ts = sec * 1000;
      const ds = berlinDateString(new Date(ts));
      if (ds !== day && ds !== day2) continue;
      data.push({ ts, day: ds, eur_mwh: eur, ct_kwh: Number((eur / 10).toFixed(3)) });
    }

    data.sort((a, b) => a.ts - b.ts);
    state.epex = { ok: true, date: day, nextDate: day2, updatedAt: Date.now(), data, error: null };
    pushLog('epex_refresh_ok', { count: data.length });
  } catch (e) {
    state.epex.ok = false;
    state.epex.error = e.message;
    state.epex.updatedAt = Date.now();
    pushLog('epex_refresh_err', { error: e.message });
  }
}

function epexNowNext() {
  const rec = state.epex;
  if (!rec.ok || !Array.isArray(rec.data) || rec.data.length === 0) return null;
  const now = Date.now();
  let current = rec.data[0];
  let next = null;
  for (const row of rec.data) {
    if (row.ts <= now) current = row;
    else { next = row; break; }
  }

  const hasFutureNegative = rec.data.some((r) => r.ts > now && Number(r.eur_mwh) < 0);
  const tomorrowRows = rec.data.filter((r) => r.day === rec.nextDate);
  const todayRows = rec.data.filter((r) => r.day === rec.date);

  return {
    current,
    next,
    hasFutureNegative,
    today: rec.date,
    tomorrow: rec.nextDate,
    todayMin: todayRows.length ? Math.min(...todayRows.map((r) => Number(r.eur_mwh))) : null,
    todayMax: todayRows.length ? Math.max(...todayRows.map((r) => Number(r.eur_mwh))) : null,
    tomorrowNegative: tomorrowRows.some((r) => Number(r.eur_mwh) < 0),
    tomorrowMin: tomorrowRows.length ? Math.min(...tomorrowRows.map((r) => Number(r.eur_mwh))) : null,
    tomorrowMax: tomorrowRows.length ? Math.max(...tomorrowRows.map((r) => Number(r.eur_mwh))) : null
  };
}

async function runMeterScan(params = {}) {
  if (state.scan.running) throw new Error('scan already running');
  const p = { ...cfg.scan, ...params };
  p.start = Number(p.start);
  p.end = Number(p.end);
  p.step = Math.max(1, Number(p.step));
  p.quantity = Math.max(1, Math.min(125, Number(p.quantity)));

  state.scan.running = true;
  state.scan.updatedAt = Date.now();
  state.scan.params = p;
  state.scan.rows = [];
  state.scan.error = null;
  pushLog('scan_start', p);

  const rows = [];
  try {
    for (let addr = p.start; addr <= p.end; addr += p.step) {
      try {
        const regs = await mbRequest({
          host: p.host,
          port: p.port,
          unitId: p.unitId,
          fc: p.fc,
          address: addr,
          quantity: p.quantity,
          timeoutMs: p.timeoutMs
        });
        const hasNonZero = regs.some((x) => Number(x) !== 0);
        if (!p.onlyNonZero || hasNonZero) rows.push({ addr, regs, s16: regs.map((v) => s16(v)) });
      } catch (e) {
        rows.push({ addr, error: e.message });
      }
      if (rows.length >= 1000) break;
    }
    state.scan.rows = rows;
    pushLog('scan_done', { rows: rows.length });
  } catch (e) {
    state.scan.error = e.message;
    pushLog('scan_error', { error: e.message });
  } finally {
    state.scan.running = false;
    state.scan.updatedAt = Date.now();
  }
}

function scheduleMatch(rule, nowDay, nowMin) {
  if (!rule || rule.enabled === false) return false;
  if (Array.isArray(rule.days) && rule.days.length && !rule.days.includes(nowDay)) return false;
  const s = parseHHMM(rule.start);
  const e = parseHHMM(rule.end);
  if (s == null || e == null) return false;
  if (s <= e) return nowMin >= s && nowMin < e;
  return nowMin >= s || nowMin < e;
}

function effectiveTargetValue(target) {
  const now = Date.now();
  const day = localWeekdayIndex(new Date(now));
  const mod = localMinutesOfDay(new Date(now));

  const hit = state.schedule.rules.find((r) => r.target === target && scheduleMatch(r, day, mod));
  if (hit) return { value: Number(hit.value), source: `rule:${hit.id || 'unnamed'}` };

  if (target === 'gridSetpointW' && state.schedule.config.defaultGridSetpointW != null) return { value: Number(state.schedule.config.defaultGridSetpointW), source: 'default' };
  if (target === 'chargeCurrentA' && state.schedule.config.defaultChargeCurrentA != null) return { value: Number(state.schedule.config.defaultChargeCurrentA), source: 'default' };
  return { value: null, source: 'none' };
}

async function applyControlTarget(target, value, source) {
  const conf = cfg.controlWrite[target];
  if (!conf?.enabled) return { ok: false, error: 'write target not enabled in config' };
  if (Number(conf.address) === 0 && conf.allowAddressZero !== true) return { ok: false, error: 'unsafe address 0 blocked (set allowAddressZero=true to override)' };

  const prev = state.schedule.lastWrite[target];
  if (prev != null && Number(prev.value) === Number(value)) {
    state.schedule.active[target] = { value, source, at: Date.now(), skipped: true };
    return { ok: true, skipped: true };
  }

  try {
    const encoded = toRawForWrite(value, conf);
    const words = Array.isArray(encoded.words) && encoded.words.length ? encoded.words : [encoded.raw];
    const fc = Number(conf.fc || (words.length > 1 ? 16 : 6));

    if (fc === 6) {
      if (words.length !== 1) throw new Error(`fc6 only supports one register, got ${words.length}`);
      await mbWriteSingle({ host: conf.host, port: conf.port, unitId: conf.unitId, address: conf.address, value: words[0], timeoutMs: conf.timeoutMs });
    } else if (fc === 16) {
      await mbWriteMultiple({ host: conf.host, port: conf.port, unitId: conf.unitId, address: conf.address, values: words, timeoutMs: conf.timeoutMs });
    } else {
      throw new Error(`unsupported write fc: ${fc}`);
    }

    state.schedule.lastWrite[target] = {
      value,
      source,
      raw: encoded.raw,
      words,
      scaled: encoded.scaled,
      writeType: encoded.writeType,
      fc,
      address: conf.address,
      at: Date.now()
    };
    state.schedule.active[target] = { value, source, at: Date.now() };
    pushLog('control_write', {
      target,
      value,
      raw: encoded.raw,
      words,
      scaled: encoded.scaled,
      writeType: encoded.writeType,
      wordOrder: encoded.wordOrder,
      fc,
      address: conf.address,
      source
    });
    return { ok: true, raw: encoded.raw, words, scaled: encoded.scaled, writeType: encoded.writeType, wordOrder: encoded.wordOrder, fc, address: conf.address };
  } catch (e) {
    pushLog('control_write_error', { target, value, source, error: e.message });
    return { ok: false, error: e.message };
  }
}

async function evaluateSchedule() {
  const now = Date.now();
  state.schedule.lastEvalAt = now;

  const npp = cfg.dvControl?.negativePriceProtection;
  const priceNow = epexNowNext()?.current;
  const priceNegative = npp?.enabled && priceNow && Number(priceNow.ct_kwh) < 0;

  for (const target of ['gridSetpointW', 'chargeCurrentA']) {
    const eff = effectiveTargetValue(target);
    if (eff.value == null) continue;

    // Bei negativen Preisen: Grid Setpoint auf Schutzwert begrenzen
    if (target === 'gridSetpointW' && priceNegative) {
      const limit = Number(npp.gridSetpointW ?? -40);
      if (eff.value < limit) {
        const prev = state.ctrl.negativePriceActive;
        if (!prev) pushLog('negative_price_protection_on', { price: priceNow.ct_kwh, limit });
        state.ctrl.negativePriceActive = true;
        await applyControlTarget(target, limit, 'negative_price_protection');
        // Auch Victron-Abregelung bei negativen Preisen
        if (cfg.dvControl?.enabled && !state.ctrl.forcedOff) {
          applyDvVictronControl(false);
        }
        continue;
      }
    }

    await applyControlTarget(target, eff.value, eff.source);
  }

  // Negative-Preis-Schutz aufheben wenn Preis wieder positiv
  if (state.ctrl.negativePriceActive && !priceNegative) {
    state.ctrl.negativePriceActive = false;
    pushLog('negative_price_protection_off', { price: priceNow?.ct_kwh });
    if (cfg.dvControl?.enabled && !state.ctrl.forcedOff) {
      applyDvVictronControl(true);
    }
  }
}

function keepaliveModbusPayload() {
  return {
    ok: !!state.keepalive.modbusLastQuery,
    lastQuery: state.keepalive.modbusLastQuery,
    now: Date.now()
  };
}

function keepalivePulsePayload() {
  const now = Date.now();
  const slot = Math.floor(now / (cfg.keepalivePulseSec * 1000));
  const slotTs = slot * cfg.keepalivePulseSec * 1000;
  return {
    ok: true,
    periodSec: cfg.keepalivePulseSec,
    pulseSlot: slot,
    pulseTimestamp: slotTs,
    now
  };
}

function costSummary() {
  return {
    day: state.energy.day,
    importWh: Number(state.energy.importWh.toFixed(3)),
    exportWh: Number(state.energy.exportWh.toFixed(3)),
    importKwh: Number((state.energy.importWh / 1000).toFixed(4)),
    exportKwh: Number((state.energy.exportWh / 1000).toFixed(4)),
    costEur: Number(state.energy.costEur.toFixed(4)),
    revenueEur: Number(state.energy.revenueEur.toFixed(4)),
    netEur: Number((state.energy.revenueEur - state.energy.costEur).toFixed(4)),
    priceNowCtKwh: Number(epexNowNext()?.current?.ct_kwh ?? 0)
  };
}

function integrationState() {
  return {
    timestamp: Date.now(),
    dvControlValue: controlValue(),
    forcedOff: state.ctrl.forcedOff,
    gridTotalW: state.meter.grid_total_w,
    gridDirection: gridDirection(state.meter.grid_total_w).mode,
    gridSetpointW: state.victron.gridSetpointW,
    minSocPct: state.victron.minSocPct,
    soc: state.victron.soc,
    batteryPowerW: state.victron.batteryPowerW,
    pvTotalW: state.victron.pvTotalW,
    scheduleActive: state.schedule.active,
    costs: costSummary()
  };
}

function checkAuth(req, res) {
  if (!cfg.apiToken) return true;
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${cfg.apiToken}`) return true;
  const urlToken = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
  if (urlToken === cfg.apiToken) return true;
  res.writeHead(401, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};

function json(res, code, payload) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function text(res, code, payload) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(String(payload));
}

function serveStatic(req, res) {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  const reqPath = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  const publicDir = path.resolve(__dirname, 'public');
  const file = path.resolve(publicDir, reqPath.replace(/^\/+/, ''));
  if (!file.startsWith(publicDir + path.sep) && file !== publicDir) return text(res, 400, 'bad path');
  if (!fs.existsSync(file)) return text(res, 404, 'not found');
  const ext = path.extname(file).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': mime });
  fs.createReadStream(file).pipe(res);
}

const web = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dv/')) {
    if (!checkAuth(req, res)) return;
  }

  if (url.pathname === '/dv/control-value' && req.method === 'GET') return text(res, 200, controlValue());

  if (url.pathname === '/api/keepalive/modbus' && req.method === 'GET') return json(res, 200, keepaliveModbusPayload());
  if (url.pathname === '/api/keepalive/pulse' && req.method === 'GET') return json(res, 200, keepalivePulsePayload());

  if (url.pathname === '/api/status' && req.method === 'GET') {
    expireLeaseIfNeeded();
    return json(res, 200, {
      now: Date.now(),
      dvControlValue: controlValue(),
      dvRegs: state.dvRegs,
      ctrl: { ...state.ctrl, dvControl: state.ctrl.dvControl || null },
      keepalive: state.keepalive,
      meter: {
        ...state.meter,
        l1Dir: gridDirection(state.meter.grid_l1_w),
        l2Dir: gridDirection(state.meter.grid_l2_w),
        l3Dir: gridDirection(state.meter.grid_l3_w),
        totalDir: gridDirection(state.meter.grid_total_w),
        semantics: { positiveMeans: cfg.gridPositiveMeans }
      },
      victron: state.victron,
      scan: state.scan,
      schedule: state.schedule,
      costs: costSummary(),
      epex: { ...state.epex, summary: epexNowNext() }
    });
  }

  if (url.pathname === '/api/costs' && req.method === 'GET') return json(res, 200, costSummary());

  if (url.pathname === '/api/integration/home-assistant' && req.method === 'GET') return json(res, 200, integrationState());

  if (url.pathname === '/api/integration/loxone' && req.method === 'GET') {
    const s = integrationState();
    const lines = Object.entries(s).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    return text(res, 200, lines.join('\n'));
  }

  if (url.pathname === '/api/log' && req.method === 'GET') return json(res, 200, { rows: state.log.slice(-300) });

  if (url.pathname === '/api/epex/refresh' && req.method === 'POST') {
    await fetchEpexDay();
    return json(res, 200, { ok: state.epex.ok, error: state.epex.error });
  }

  if (url.pathname === '/api/meter/scan' && req.method === 'POST') {
    const body = await parseBody(req);
    runMeterScan(body).catch((e) => {
      state.scan.running = false;
      state.scan.error = e.message;
    });
    return json(res, 200, { ok: true, running: true });
  }

  if (url.pathname === '/api/meter/scan' && req.method === 'GET') return json(res, 200, state.scan);

  if (url.pathname === '/api/schedule' && req.method === 'GET') {
    return json(res, 200, {
      config: state.schedule.config,
      rules: state.schedule.rules,
      active: state.schedule.active,
      lastWrite: state.schedule.lastWrite
    });
  }

  if (url.pathname === '/api/schedule/rules' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!Array.isArray(body.rules)) return json(res, 400, { ok: false, error: 'rules array required' });
    state.schedule.rules = body.rules;
    pushLog('schedule_rules_updated', { count: body.rules.length });
    persistConfig();
    return json(res, 200, { ok: true, count: body.rules.length });
  }

  if (url.pathname === '/api/schedule/config' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.defaultGridSetpointW !== undefined) {
      const v = Number(body.defaultGridSetpointW);
      if (!Number.isFinite(v)) return json(res, 400, { ok: false, error: 'defaultGridSetpointW invalid' });
      state.schedule.config.defaultGridSetpointW = v;
    }
    if (body.defaultChargeCurrentA !== undefined) {
      const v = Number(body.defaultChargeCurrentA);
      if (!Number.isFinite(v)) return json(res, 400, { ok: false, error: 'defaultChargeCurrentA invalid' });
      state.schedule.config.defaultChargeCurrentA = v;
    }
    pushLog('schedule_config_updated', { config: state.schedule.config });
    persistConfig();
    return json(res, 200, { ok: true, config: state.schedule.config });
  }

  if (url.pathname === '/api/control/write' && req.method === 'POST') {
    const body = await parseBody(req);
    const target = String(body.target || '');
    const value = Number(body.value);
    if (!['gridSetpointW', 'chargeCurrentA', 'minSocPct'].includes(target) || !Number.isFinite(value)) {
      return json(res, 400, { ok: false, error: 'target/value invalid' });
    }
    const result = await applyControlTarget(target, value, 'api_manual_write');
    return json(res, result.ok ? 200 : 500, result);
  }

  return serveStatic(req, res);
  } catch (e) {
    console.error('HTTP handler error:', e);
    if (!res.headersSent) json(res, 500, { error: 'internal server error' });
  }
});

web.listen(cfg.httpPort, () => {
  console.log(`Web server listening on :${cfg.httpPort}`);
});

loadEnergy();
startModbusServer();
setInterval(expireLeaseIfNeeded, 1000);
pollMeter().catch((e) => console.error('Initial pollMeter error:', e));
setInterval(() => {
  pollMeter().catch((e) => pushLog('poll_meter_error', { error: e.message }));
}, Math.max(500, cfg.meterPollMs));
fetchEpexDay();
setInterval(() => {
  const mustRefresh = !state.epex.date || state.epex.date !== berlinDateString();
  if (mustRefresh || (Date.now() - state.epex.updatedAt) > 6 * 60 * 60 * 1000) fetchEpexDay();
}, 5 * 60 * 1000);
setInterval(() => {
  evaluateSchedule().catch((e) => pushLog('schedule_eval_error', { error: e.message }));
}, Math.max(5000, Number(cfg.schedule.evaluateMs || 15000)));
setInterval(() => {
  flushInflux().catch((e) => pushLog('influx_flush_error', { error: e.message }));
}, INFLUX_FLUSH_MS);
setInterval(persistEnergy, 60000);

function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  persistEnergy();
  if (mbServer) mbServer.close();
  web.close();
  for (const c of mbPool.values()) c.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

console.log('Config loaded:', {
  httpPort: cfg.httpPort,
  modbusListenPort: cfg.modbusListenPort,
  meterPollMs: cfg.meterPollMs,
  meterAddress: `${cfg.meter.host}:${cfg.meter.port} uid=${cfg.meter.unitId} reg=${cfg.meter.address}`,
  apiTokenSet: !!cfg.apiToken,
  influxEnabled: cfg.influx.enabled,
  epexEnabled: cfg.epex.enabled,
  scheduleRules: cfg.schedule.rules.length
});
