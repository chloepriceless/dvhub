// services/devices/mypv.js — my-PV AC THOR / ELWA 2 direkt per Modbus TCP.
//
// Register laut my-PV „Documentation Controls“ (Adressen wie auf dem Draht),
// übernommen aus dem Ohmpilot-Übersetzer (acthor.py), der so an einem echten
// AC THOR läuft:
//   1000  Leistung in W — Schreiben = Vorgabe, Lesen = Ist-Leistung
//   1001  Temperatur in 0,1 °C
//   1003  Status (9 = Betrieb, ab 200 = Fehler)
//   1070  Steuerungsart (Vorgaben per Modbus nur in „Modbus TCP“)
//   1081  Gerätestatus (Bit 0 = an)
//
// Wichtig am Gerät: der AC THOR lässt nur EINEN Modbus-Teilnehmer zu und nimmt
// Vorgaben nur in der Steuerungsart „Modbus TCP“ an. Dort zusätzlich einen
// „Power Timeout“ (z. B. 30 s) setzen: fällt DVhub aus, schaltet der Heizstab
// von selbst ab. DVhub schreibt deshalb in jedem Takt, auch bei gleichem Wert.

import { createModbusTransport } from '../../transport-modbus.js';

export const MYPV_REG_POWER = 1000;
export const MYPV_REG_CTRL = 1070;
export const MYPV_REG_DEVICE_STATE = 1081;
const TIMEOUT_MS = 2000;

/** Register 1000..1003 → Messwerte. */
export function parseMypvRegisters(regs) {
  const status = Number(regs?.[3]);
  return {
    powerW: Number(regs?.[0]) || 0,
    tempC: Number.isFinite(Number(regs?.[1])) ? Number(regs[1]) / 10 : null,
    status: Number.isFinite(status) ? status : null,
    statusText: status === 9 ? 'Betrieb' : status >= 200 ? 'Fehler' : (Number.isFinite(status) ? `Status ${status}` : null)
  };
}

/**
 * @param {{host:string, port?:number, unit?:number}} endpoint
 * @param {{transport?:object}} [deps]  Modbus-Transport (Tests: Fake)
 */
export function createMypvClient(endpoint, { transport = createModbusTransport({ connectTimeoutMs: 3000 }) } = {}) {
  const host = endpoint.host;
  const port = Number(endpoint.port) || 502;
  const unitId = Number.isInteger(Number(endpoint.unit)) ? Number(endpoint.unit) : 1;

  async function read() {
    const regs = await transport.mbRequest({ host, port, unitId, fc: 3, address: MYPV_REG_POWER, quantity: 4, timeoutMs: TIMEOUT_MS });
    const setup = await transport.mbRequest({
      host, port, unitId, fc: 3, address: MYPV_REG_CTRL, quantity: MYPV_REG_DEVICE_STATE - MYPV_REG_CTRL + 1, timeoutMs: TIMEOUT_MS
    });
    return {
      ...parseMypvRegisters(regs),
      ctrlMode: Number(setup[0]),
      deviceOn: Boolean(Number(setup[setup.length - 1]) & 1)
    };
  }

  async function writePower(watts) {
    const value = Math.max(0, Math.min(0xffff, Math.round(Number(watts) || 0)));
    await transport.mbWriteSingle({ host, port, unitId, address: MYPV_REG_POWER, value, timeoutMs: TIMEOUT_MS });
    return value;
  }

  return { host, port, unitId, read, writePower, close: () => transport.destroy?.() };
}
