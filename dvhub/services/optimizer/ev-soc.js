import fs from 'node:fs';

/**
 * Ladestand des E-Autos fuer EOS.
 *
 * EOS braucht fuer ein angemeldetes Fahrzeug einen Start-SoC. 0.3 rechnete
 * ohne ihn stillschweigend mit 0; ab 0.4 bricht der GANZE Lauf ab ("Fresh SoC
 * missing for ev11") — auch der Hausakku bekommt dann keinen Plan (prod
 * 2026-09-23). DVhub hat den Wert bisher nie geliefert: `state.victron.evSocPct`
 * setzt niemand.
 *
 * Quellen:
 *   - TeslaMate (`batteryLevel`) — sendet nur bei Aenderung, der letzte Wert
 *     gilt (ein schlafendes Auto aendert seinen SoC nicht) und wird beim
 *     Start aus der DB vorgeladen.
 *   - evcc — SoC am gesteuerten Ladepunkt (nur wenn ein Fahrzeug erkannt ist).
 *   - evcc-Fahrzeugtreiber (services/vehicle-evcc) — Hersteller-Cloud, ~45 Marken.
 *   - MQTT — frei waehlbares Topic (services/mqtt/vehicle-mqtt.js), fuer jede
 *     Marke, z. B. ueber Home Assistant.
 *   - HTTP-Endpunkt (JSON + Pfad) und Home Assistant REST
 *     (services/vehicle-pull) — fuer jede Marke ohne Broker.
 *
 * `optimizer.evSocSource` legt fest, welche gilt: 'auto' (Standard) nimmt die
 * erste, die einen Wert hat, in der Reihenfolge TeslaMate, evcc, MQTT;
 * 'teslamate' / 'evcc' / 'mqtt' nehmen genau diese Quelle — so entscheidet der
 * Betreiber, welches Auto gemeint ist, wenn mehrere Quellen Werte liefern.
 *
 * @returns {{ pct: number, source: string } | null}
 */
export const EV_SOC_SOURCES = Object.freeze(['auto', 'teslamate', 'evcc', 'evccvehicle', 'mqtt', 'http', 'homeassistant']);
// Quellen, die den Ladestand vom FAHRZEUG liefern — auch wenn es nicht steckt
// (unterwegs). Wallbox/evcc-Ladepunkt kennen ihn nur angesteckt.
export const VEHICLE_SOC_SOURCES = Object.freeze(new Set(['teslamate', 'evccvehicle', 'mqtt', 'http', 'homeassistant']));
// Ladestand über evccs Fahrzeug-Treiber (services/vehicle-evcc) gilt höchstens so lange.
export const EVCC_VEHICLE_MAX_AGE_MS = 24 * 3600_000;

const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const pctOf = (v) => { const n = num(v); return n !== null && n >= 0 && n <= 100 ? n : null; };
const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const ms = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v));
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Alle Ladestand-Werte, die DVhub gerade kennt — in der Rangfolge von 'auto'
 * und gefiltert nach optimizer.evSocSource. Jeder Wert nennt seinen Zeitpunkt
 * (atMs, null = unbekannt); zu alte Werte liefern die Quellen selbst schon als
 * null (MQTT/HTTP/HA: optimizer.evMqttMaxAgeH, evcc-Fahrzeugtreiber 24 h).
 * TeslaMate bleibt ohne Altersgrenze (sendet nur bei Aenderung, ein
 * schlafendes Auto aendert seinen Ladestand nicht) — sein Zeitpunkt entscheidet
 * aber ueber „live“ (ev-arrival.js).
 *
 * @returns {Array<{ pct: number, source: string, atMs: number|null }>}
 */
export function collectEvSocReadings(ctx, nowMs = Date.now()) {
  const opt = ctx?.getCfg?.()?.optimizer || {};
  const wanted = EV_SOC_SOURCES.includes(opt.evSocSource) ? opt.evSocSource : 'auto';
  const use = (source) => wanted === 'auto' || wanted === source;
  const out = [];

  if (use('teslamate') && ctx?.teslamateService?.getState) {
    const pct = pctOf(ctx.teslamateService.getState()?.batteryLevel);
    if (pct !== null) {
      const stamps = ctx.teslamateService.getFieldUpdatedAt?.() || {};
      out.push({ pct, source: 'teslamate', atMs: toMs(stamps.batteryLevel) ?? toMs(ctx.teslamateService.lastUpdateAt) });
    }
  }

  // Hauptwallbox direkt angebunden (OpenEVSE meldet den Ladestand mit):
  // dann gilt sie, evcc wird nicht gefragt (main-wallbox.js). Nur angesteckt —
  // ohne Auto meldet evcc vehicleSoc 0 (prod 2026-09-23), fuer EOS waere das
  // ein leerer Akku und ein voller Ladeplan.
  const wallbox = ctx?.mainWallbox?.state?.();
  if (wallbox && wallbox.type !== 'evcc') {
    if (use('evcc') || use('wallbox')) {
      const pct = wallbox.connected === true ? pctOf(wallbox.vehicleSocPct) : null;
      if (pct !== null) out.push({ pct, source: wallbox.type, atMs: toMs(wallbox.at) ?? nowMs });
    }
  } else if (use('evcc')) {
    const lpId = Number(opt.evEvccLoadpoint) || 1;
    const lps = ctx?.evccIntegration?.getLoadpoints?.() || [];
    const lp = lps.find((l) => l.id === lpId);
    const pct = lp?.connected === true ? pctOf(lp?.vehicleSocPct) : null;
    // Zeitpunkt der letzten erfolgreichen Abfrage: faellt evcc aus, bleibt die
    // Liste stehen — „jetzt“ machte einen alten Wert immer wieder frisch.
    const polled = toMs(ctx?.evccIntegration?.getStatus?.()?.lastPolledAt);
    if (pct !== null) out.push({ pct, source: 'evcc', atMs: polled && polled > 0 ? polled : nowMs });
  }

  if (use('evccvehicle')) {
    const v = ctx?.vehicleEvcc?.getState?.();
    const pct = pctOf(v?.socPct);
    const atMs = toMs(v?.at);
    if (pct !== null && atMs !== null && nowMs - atMs <= EVCC_VEHICLE_MAX_AGE_MS) out.push({ pct, source: 'evccvehicle', atMs });
  }

  if (use('mqtt')) {
    const m = ctx?.vehicleMqtt?.getState?.();
    const pct = pctOf(m?.socPct);
    if (pct !== null) out.push({ pct, source: 'mqtt', atMs: toMs(m.socAt) });
  }

  // HTTP-Endpunkt / Home Assistant (services/vehicle-pull): veraltete Werte
  // liefert der Dienst bereits als null.
  for (const kind of ['http', 'homeassistant']) {
    if (!use(kind)) continue;
    const st = ctx?.vehiclePull?.getState?.(kind);
    const pct = pctOf(st?.socPct);
    if (pct !== null) out.push({ pct, source: kind, atMs: toMs(st.socAt) });
  }
  return out;
}

export function resolveEvSocPct(ctx) {
  const first = collectEvSocReadings(ctx)[0];
  return first ? { pct: first.pct, source: first.source } : null;
}

/**
 * Juengster bekannter Ladestand mit Zeitpunkt { pct, source, atMs } oder null
 * — fuer den erwarteten Ladestand bei Ankunft (ev-arrival.js). Dazu der
 * gemerkte Wert (ctx.evSocMemory), damit ein Wallbox-Wert das Abstecken
 * uebersteht.
 */
export function resolveEvSocReading(ctx, nowMs = Date.now()) {
  const opt = ctx?.getCfg?.()?.optimizer || {};
  const wanted = EV_SOC_SOURCES.includes(opt.evSocSource) ? opt.evSocSource : 'auto';
  const out = collectEvSocReadings(ctx, nowMs);
  // Gewaehlt „evcc“ heisst „die Wallbox“ — auch eine direkt angebundene
  // (Quelle dann openevse, goe …).
  const memMatches = (src) => wanted === 'auto' || src === wanted || (wanted === 'evcc' && !VEHICLE_SOC_SOURCES.has(src));
  const mem = ctx?.evSocMemory?.get?.();
  if (mem && pctOf(mem.pct) !== null && memMatches(mem.source)) out.push(mem);
  if (!out.length) return null;
  const best = [...out].sort((a, b) => (b.atMs ?? -Infinity) - (a.atMs ?? -Infinity))[0];
  return { pct: best.pct, source: best.source, atMs: best.atMs ?? null };
}

const CHECKPOINT_MS = 3600_000;

/**
 * Merkt sich den juengsten Ladestand (die Minuten-Wache ruft observe()), damit
 * der letzte Wallbox-Wert nach dem Abstecken als Schaetzbasis bleibt. Mit
 * filePath ueberlebt er einen Neustart; geschrieben wird bei neuem Wert/Quelle
 * und sonst hoechstens stuendlich (der Zeitpunkt).
 */
export function createEvSocMemory({ filePath = null } = {}) {
  let last = null;
  let writtenAtMs = null;
  if (filePath) {
    try {
      const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (pctOf(j?.pct) !== null && typeof j.source === 'string') last = { pct: Number(j.pct), source: j.source, atMs: toMs(j.atMs) };
      writtenAtMs = last?.atMs ?? null;
    } catch { /* noch keine Datei */ }
  }
  return {
    observe(reading) {
      if (!reading || pctOf(reading.pct) === null) return;
      const atMs = toMs(reading.atMs);
      if (last && last.atMs !== null && (atMs === null || atMs < last.atMs)) return;
      const changed = !last || last.pct !== reading.pct || last.source !== reading.source;
      last = { pct: Number(reading.pct), source: String(reading.source || ''), atMs };
      const checkpoint = atMs !== null && (writtenAtMs === null || atMs - writtenAtMs >= CHECKPOINT_MS);
      if ((changed || checkpoint) && filePath) {
        try { fs.writeFileSync(filePath, JSON.stringify(last)); writtenAtMs = atMs; } catch { /* Schaetzhilfe, kein Fehlerfall */ }
      }
    },
    get() { return last ? { ...last } : null; }
  };
}

/**
 * Steckt das Auto am gesteuerten Ladepunkt? Quelle: die Wallbox selbst
 * (OpenEVSE/go-e), sonst evcc (`connected`), sonst ein MQTT-Topic.
 * @returns {boolean|null} null = unbekannt (evcc nicht erreichbar/kein Ladepunkt)
 */
export function resolveEvPlugged(ctx) {
  // Die Hauptwallbox ist die Quelle (main-wallbox.js): eine direkt angebundene
  // Box selbst, sonst evcc. Ist eine Box direkt gewählt, wird evcc NICHT
  // ersatzweise gefragt — schweigt die Box, ist der Zustand unbekannt.
  const wallbox = ctx?.mainWallbox?.state?.();
  if (wallbox) {
    if (wallbox.available && typeof wallbox.connected === 'boolean') return wallbox.connected;
  } else {
    const direct = ctx?.chargerStatus?.fresh?.();
    if (direct) return direct.connected === true;
    const lpId = Number(ctx?.getCfg?.()?.optimizer?.evEvccLoadpoint) || 1;
    const lps = ctx?.evccIntegration?.getLoadpoints?.() || [];
    const lp = lps.find((l) => l.id === lpId);
    if (lp) return lp.connected === true;
  }
  // Weder Wallbox noch evcc sagen es: ein eingestelltes MQTT-Topic
  // (vehicle-mqtt.js), sonst unbekannt.
  const viaMqtt = ctx?.vehicleMqtt?.getState?.()?.plugged;
  if (typeof viaMqtt === 'boolean') return viaMqtt;
  // Dann HTTP-Endpunkt bzw. Home Assistant (services/vehicle-pull).
  for (const kind of ['http', 'homeassistant']) {
    const p = ctx?.vehiclePull?.getState?.(kind)?.plugged;
    if (typeof p === 'boolean') return p;
  }
  return null;
}

/**
 * Entprellt den Steck-Zustand: ein Wechsel zaehlt erst, wenn er `stableTicks`
 * Abfragen in Folge gleich bleibt (evcc meldet beim Anstecken/Abziehen kurz
 * wechselnde Werte; jeder Wechsel kostet einen EOS-Neuplan). Die allererste
 * Beobachtung setzt nur den Ausgangszustand — beim DVhub-Start meldet der
 * regulaere Abgleich das Auto ohnehin passend an.
 */
export function createEvPlugTracker({ stableTicks = 2 } = {}) {
  let stable;          // undefined = noch keine Beobachtung
  let candidate;
  let count = 0;
  return {
    update(value) {
      if (stable === undefined) { stable = value; return { changed: false, stable }; }
      if (value === stable) { candidate = undefined; count = 0; return { changed: false, stable }; }
      if (value !== candidate) { candidate = value; count = 1; } else count += 1;
      if (count >= stableTicks) {
        const from = stable;
        stable = value; candidate = undefined; count = 0;
        return { changed: true, from, stable };
      }
      return { changed: false, stable };
    },
    get stable() { return stable; }
  };
}
