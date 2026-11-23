// services/mobile-link/integrations-view.js — Integrationen für die Handy-App.
//
// GET /api/integrations/status zeigt der Weboberfläche auch Adressen im
// Heimnetz (Wechselrichter, Zähler, evcc, EOS, MQTT-Broker), Benutzernamen und
// Kennungen (VRM-Portal, Seriennummern). Das gehört nicht aufs Handy und nicht
// über das Relay. Diese Sicht baut die Antwort deshalb NEU auf — per
// Positivliste: Nur was hier benannt ist, geht hinaus, und nur als Wahrheitswert,
// Zahl oder kurzer Text ohne Adresse. Ein neues Feld in der großen Antwort
// erscheint hier erst, wenn es jemand bewusst einträgt (Lehre vom 13.11.2026:
// Ausschluss-Filter lassen Neues durch).

const bool = (v) => v === true;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Kurzer Anzeigetext (Modell, Firmware, Zustand). Alles, was nach Adresse,
// Zugang oder Fehlermeldung mit Adresse aussieht, fällt weg.
const ADDRESS_LIKE = /:\/\/|@|\b\d{1,3}(\.\d{1,3}){3}\b|\[[0-9a-f:]+\]|\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){3,}\b|\.(local|lan|home|fritz\.box|internal)\b/i;
export function safeText(v, max = 60) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > max || ADDRESS_LIKE.test(s)) return null;
  return s;
}

// Zeitstempel als Zahl (ms) oder ISO-Text — sonst nichts.
function when(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v))) return v;
  return null;
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function mobileIntegrationsView(status) {
  const s = obj(status);
  const mqtt = obj(s.mqtt);
  const tesla = obj(s.tesla);
  const evcc = obj(s.evcc);
  const charger = evcc.charger && typeof evcc.charger === 'object' ? evcc.charger : null;
  const p14a = obj(s.p14a);
  const eebus = obj(s.eebus);
  const fp = obj(s['forecast-providers']);
  const pv = obj(s.pvstrings);
  return {
    ok: true,
    timestamp: num(s.timestamp),
    mqtt: {
      enabled: bool(mqtt.enabled),
      connected: bool(mqtt.connected),
      // Eigener Broker auf der Box oder ein fremder — ohne dessen Adresse.
      embedded: bool(mqtt.embedded),
      topicCount: num(mqtt.topicCount) ?? 0,
      passwordSet: bool(obj(mqtt.config).passwordSet),
      haDiscovery: bool(obj(s.homeAssistant).haDiscovery),
    },
    tesla: {
      enabled: bool(tesla.enabled),
      name: safeText(obj(tesla.config).name, 40),
      // Der Fahrzeugzustand selbst (mit Standort) bleibt auf der Box.
      hasState: !!tesla.state,
      lastUpdate: when(tesla.lastUpdate),
    },
    victron: {
      configured: !!obj(s.victron).host,
      modelId: safeText(obj(s.victron).modelId),
      firmware: safeText(obj(s.victron).firmware),
    },
    mid: {
      configured: bool(obj(s.mid).configured),
      firmware: safeText(obj(s.mid).firmware),
    },
    dveos: {
      enabled: bool(obj(s.dveos).enabled),
      active: bool(obj(s.dveos).active),
      primarySource: safeText(obj(s.dveos).primarySource, 20),
    },
    luox: {
      configured: !!obj(s.luox).identifier,
      firmware: safeText(obj(s.luox).firmware),
    },
    loxone: { configured: bool(obj(s.loxone).configured) },
    devices: {
      total: num(obj(s.devices).total) ?? 0,
      online: num(obj(s.devices).online) ?? 0,
    },
    notifications: {
      enabled: bool(obj(s.notifications).enabled),
      providers: (Array.isArray(obj(s.notifications).providers) ? obj(s.notifications).providers : [])
        .map((p) => ({ name: safeText(p?.name, 30), enabled: bool(p?.enabled) }))
        .filter((p) => p.name)
        .slice(0, 12),
    },
    vrm: {
      enabled: bool(obj(s.vrm).enabled),
      portalIdSet: !!obj(s.vrm).vrmPortalId,
      tokenSet: bool(obj(s.vrm).vrmTokenSet),
    },
    forecastProviders: {
      solcast: {
        enabled: bool(obj(fp.solcast).enabled),
        apiKeySet: bool(obj(fp.solcast).apiKeySet),
        siteIdSet: bool(obj(fp.solcast).siteIdSet),
      },
      pvnode: {
        enabled: bool(obj(fp.pvnode).enabled),
        apiKeySet: bool(obj(fp.pvnode).apiKeySet),
        siteIdSet: bool(obj(fp.pvnode).siteIdSet),
        nowcastEnabled: bool(obj(fp.pvnode).nowcastEnabled),
      },
    },
    evcc: {
      configured: !!evcc.url,
      reachable: bool(evcc.reachable),
      loadpointCount: num(evcc.loadpointCount) ?? 0,
      wallboxType: safeText(evcc.wallboxType, 20),
      // Fehlertexte nennen oft die Adresse der Gegenstelle — nur, DASS es einen gibt.
      hasError: !!evcc.lastError,
      charger: charger ? {
        reachable: bool(charger.reachable),
        connected: typeof charger.connected === 'boolean' ? charger.connected : null,
        charging: typeof charger.charging === 'boolean' ? charger.charging : null,
        powerW: num(charger.powerW),
        mode: safeText(charger.mode, 20),
        hasError: !!charger.lastError,
      } : null,
    },
    p14a: {
      available: bool(p14a.available),
      active: bool(p14a.active),
      source: safeText(p14a.source, 20),
      limitW: num(p14a.limitW),
      pminW: num(p14a.pminW),
      devices: num(p14a.devices) ?? 0,
      relayEnabled: bool(p14a.relayEnabled),
    },
    eebus: {
      enabled: bool(eebus.enabled),
      status: safeText(eebus.status, 20),
      statusLabel: safeText(eebus.statusLabel, 30),
      gridPeer: bool(eebus.gridPeer),
      gridConnected: bool(eebus.gridConnected),
      gridStateLabel: safeText(eebus.gridStateLabel, 30),
      devices: num(eebus.devices) ?? 0,
    },
    schedulable: {
      total: num(obj(s.schedulable).total) ?? 0,
      deferrable: num(obj(s.schedulable).deferrable) ?? 0,
      modulating: num(obj(s.schedulable).modulating) ?? 0,
      eosActive: bool(obj(s.schedulable).eosActive),
    },
    pvStrings: {
      enabled: bool(pv.enabled),
      sourceCount: num(pv.sourceCount) ?? 0,
      groupCount: num(pv.groupCount) ?? 0,
      lastSyncAt: when(pv.lastSyncAt),
      hasError: !!pv.lastError,
      backfillRunning: bool(pv.backfillRunning),
    },
  };
}
