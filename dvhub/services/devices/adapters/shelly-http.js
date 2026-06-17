// services/devices/adapters/shelly-http.js -- Shelly HTTP Gen2 adapter (INTG-05)
//
// Polls Shelly Gen2 devices via local HTTP RPC for power/energy readings.
// Each device is polled at its configured interval (default 30s).
//
// Threat mitigations:
//   T-04-15: Parse only expected fields (apower, aenergy.total) from response
//   T-04-16: SSRF prevention — validate host against private IP regex
//   T-04-17: 5s AbortController timeout per request, offline after 3 consecutive failures

const DEFAULT_POLL_INTERVAL_SEC = 30;
const FETCH_TIMEOUT_MS = 5000;
const OFFLINE_AFTER_FAILURES = 3;

/**
 * Validate that a host string is a private/local IP address (T-04-16).
 * Accepts: 192.168.x.x, 10.x.x.x, 172.16-31.x.x, 127.0.0.1, localhost
 * Host may include :port suffix — strip before validation.
 */
const PRIVATE_IP_RE = /^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1|localhost)$/;

function isPrivateHost(hostWithPort) {
  // Strip port if present
  const host = hostWithPort.replace(/:\d+$/, '');
  return PRIVATE_IP_RE.test(host);
}

/**
 * @param {Array<{id: string, name: string, shelly: {host: string, pollIntervalSec?: number}}>} deviceConfigs
 * @param {Function} pushLog
 * @returns {{ type: string, start: Function, close: Function, getDevices: Function, _pollDevice: Function }}
 */
export function createShellyHttpAdapter(deviceConfigs, pushLog) {
  /** @type {Map<string, {id: string, name: string, host: string, pollIntervalSec: number, powerW: number|null, energyTodayWh: number|null, lastSeen: number, failCount: number, online: boolean, timer: ReturnType<typeof setInterval>|null}>} */
  const devices = new Map();

  // Filter valid devices (SSRF check at construction time)
  for (const cfg of deviceConfigs) {
    const host = cfg.shelly?.host;
    if (!host || !isPrivateHost(host)) {
      pushLog('shelly_ssrf_blocked', { host: host || '(empty)', deviceId: cfg.id });
      continue;
    }
    devices.set(cfg.id, {
      id: cfg.id,
      name: cfg.name,
      host,
      pollIntervalSec: cfg.shelly.pollIntervalSec || DEFAULT_POLL_INTERVAL_SEC,
      powerW: null,
      energyTodayWh: null,
      output: null,        // Relais-Zustand (an/aus) aus Switch.GetStatus
      lastSeen: 0,
      failCount: 0,
      online: false,
      timer: null,
    });
  }

  /**
   * Poll a single Shelly device via HTTP RPC.
   * Parses only apower and aenergy.total (T-04-15).
   */
  async function pollDevice(deviceId) {
    const dev = devices.get(deviceId);
    if (!dev) return;

    const url = `http://${dev.host}/rpc/Switch.GetStatus?id=0`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      // T-04-15: Extract only expected fields
      const powerW = Number(data.apower);
      const energyTotal = Number(data.aenergy?.total);

      dev.powerW = Number.isFinite(powerW) ? powerW : null;
      dev.energyTodayWh = Number.isFinite(energyTotal) ? energyTotal : null;
      dev.output = (typeof data.output === 'boolean') ? data.output : null;
      dev.lastSeen = Date.now();
      dev.failCount = 0;
      dev.online = true;
    } catch {
      dev.failCount += 1;
      if (dev.failCount >= OFFLINE_AFTER_FAILURES) {
        dev.online = false;
      }
    }
  }

  /**
   * Toggle a Shelly relay via Switch.Set (Gen2/3 RPC). Re-polls on success so the
   * cached output/power reflects the new state immediately. SSRF-safe: host was
   * validated at construction; no user-controlled host reaches here.
   */
  async function setOutput(deviceId, on) {
    const dev = devices.get(deviceId);
    if (!dev) return { ok: false, error: 'unknown_device' };
    const url = `http://${dev.host}/rpc/Switch.Set?id=0&on=${on ? 'true' : 'false'}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pollDevice(deviceId);  // refresh output/power from the device
      pushLog('shelly_set_ok', { deviceId, on: !!on, output: dev.output });
      return { ok: true, output: dev.output };
    } catch (e) {
      pushLog('shelly_set_error', { deviceId, on: !!on, error: e.message });
      return { ok: false, error: e.message };
    }
  }

  async function start() {
    for (const dev of devices.values()) {
      // Do initial poll immediately
      await pollDevice(dev.id);
      // Set up recurring poll
      dev.timer = setInterval(() => pollDevice(dev.id), dev.pollIntervalSec * 1000);
    }
    if (devices.size) {
      pushLog('shelly_http_started', { count: devices.size });
    }
  }

  async function close() {
    for (const dev of devices.values()) {
      if (dev.timer) {
        clearInterval(dev.timer);
        dev.timer = null;
      }
    }
  }

  function getDevices() {
    const result = [];
    for (const dev of devices.values()) {
      result.push({
        id: dev.id,
        name: dev.name,
        powerW: dev.powerW,
        energyTodayWh: dev.energyTodayWh,
        output: dev.output,
        switchable: true,        // Shelly relay supports on/off via setOutput
        online: dev.online,
        lastSeen: dev.lastSeen,
      });
    }
    return result;
  }

  // Test helper: allows tests to trigger a manual poll
  async function _pollDevice(deviceId) {
    await pollDevice(deviceId);
  }

  return { type: 'shelly-http', start, close, getDevices, setOutput, _pollDevice };
}
