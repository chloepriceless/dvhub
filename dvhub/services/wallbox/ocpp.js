// services/wallbox/ocpp.js — Wallbox über DVhubs OCPP-Zentrale (2026-10-20).
//
//   Laden(A)   → SetChargingProfile (TxDefaultProfile, Einheit A, Grenze = A);
//                steckt das Auto und läuft kein Ladevorgang → RemoteStartTransaction
//   Stopp      → Ladeprofil mit 0 A (der Vorgang bleibt offen, die Box pausiert)
//   Freigeben  → ClearChargingProfile (die Box lädt nach eigener Einstellung)
// Ladepunkt-ID leer = der erste verbundene Ladepunkt.
import { isReadOnlyMode } from '../../read-only-guard.js';

const READ_ONLY = Object.freeze({ ok: false, error: 'read_only' });
const PROFILE_ID = 4711;
const PLUGGED = new Set(['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing']);

export function createOcppAdapter(getSettings, deps = {}) {
  const server = () => deps.getServer?.() || null;
  const connectorId = () => Math.max(1, Number(getSettings()?.connectorId) || 1);
  function cpId() {
    const want = String(getSettings()?.chargePointId || '').trim();
    if (want) return want;
    return server()?.list?.().find((c) => c.connected)?.id || '';
  }
  function profile(limitA) {
    return {
      connectorId: connectorId(),
      csChargingProfiles: {
        chargingProfileId: PROFILE_ID,
        stackLevel: 1,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Relative',
        chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: limitA }] },
      },
    };
  }
  async function send(action, payload) {
    const s = server();
    const id = cpId();
    if (!s || !id) return { ok: false, error: 'OCPP: Zentrale aus oder kein Ladepunkt verbunden' };
    const r = await s.callAction(id, action, payload);
    if (!r.ok) return r;
    const st = r.payload?.status;
    return st && st !== 'Accepted' ? { ok: false, error: `OCPP ${action}: ${st}` } : { ok: true };
  }

  return {
    type: 'ocpp',
    isConfigured: () => Boolean(server() && cpId()),
    async charge(currentA) {
      if (isReadOnlyMode()) return READ_ONLY;
      const amps = Math.max(6, Math.floor(Number(currentA)));
      const r = await send('SetChargingProfile', profile(amps));
      if (!r.ok) return r;
      const c = server()?.chargePoint?.(cpId())?.connectors?.[connectorId()];
      if (c && PLUGGED.has(c.status) && c.transactionId == null) {
        const start = await send('RemoteStartTransaction', { connectorId: connectorId(), idTag: 'DVhub' });
        if (!start.ok) return start;
      }
      return { ok: true };
    },
    stop: async () => (isReadOnlyMode() ? READ_ONLY : send('SetChargingProfile', profile(0))),
    release: async () => (isReadOnlyMode() ? READ_ONLY : send('ClearChargingProfile', { id: PROFILE_ID })),
    async status() {
      const id = cpId();
      const cp = id ? server()?.chargePoint?.(id) : null;
      if (!cp?.connected) return { ok: false, error: `OCPP: Ladepunkt ${id || '(keiner)'} nicht verbunden` };
      const c = cp.connectors?.[connectorId()] || {};
      const fault = c.status === 'Faulted';
      return {
        ok: true,
        connected: fault ? null : PLUGGED.has(c.status),
        charging: c.status === 'Charging',
        carState: fault ? 'error' : c.status === 'SuspendedEV' || c.status === 'SuspendedEVSE' || c.status === 'Preparing' ? 'waiting' : c.status === 'Finishing' ? 'complete' : null,
        powerW: c.powerW ?? null,
        currentA: c.currentA ?? null,
        vehicleSocPct: null,
        raw: { chargePointId: id, status: c.status ?? null, transactionId: c.transactionId ?? null, energyWh: c.energyWh ?? null, vendor: cp.vendor, model: cp.model },
      };
    },
  };
}
