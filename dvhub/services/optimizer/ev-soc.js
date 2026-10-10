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
 *   - MQTT — frei waehlbares Topic (services/mqtt/vehicle-mqtt.js), fuer jede
 *     Marke, z. B. ueber Home Assistant.
 *
 * `optimizer.evSocSource` legt fest, welche gilt: 'auto' (Standard) nimmt die
 * erste, die einen Wert hat, in der Reihenfolge TeslaMate, evcc, MQTT;
 * 'teslamate' / 'evcc' / 'mqtt' nehmen genau diese Quelle — so entscheidet der
 * Betreiber, welches Auto gemeint ist, wenn mehrere Quellen Werte liefern.
 *
 * @returns {{ pct: number, source: string } | null}
 */
export const EV_SOC_SOURCES = Object.freeze(['auto', 'teslamate', 'evcc', 'mqtt']);

export function resolveEvSocPct(ctx) {
  const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const opt = ctx?.getCfg?.()?.optimizer || {};
  const wanted = EV_SOC_SOURCES.includes(opt.evSocSource) ? opt.evSocSource : 'auto';
  const use = (source) => wanted === 'auto' || wanted === source;

  if (use('teslamate')) {
    const tesla = ctx?.teslamateService?.getState?.();
    const teslaPct = num(tesla?.batteryLevel);
    if (teslaPct !== null && teslaPct >= 0 && teslaPct <= 100) return { pct: teslaPct, source: 'teslamate' };
  }

  // Hauptwallbox direkt angebunden (OpenEVSE meldet den Ladestand mit):
  // dann gilt sie, evcc wird nicht gefragt (main-wallbox.js).
  const wallbox = ctx?.mainWallbox?.state?.();
  if (wallbox && wallbox.type !== 'evcc') {
    if (use('evcc') || use('wallbox')) {
      const pct = wallbox.connected === true ? num(wallbox.vehicleSocPct) : null;
      if (pct !== null && pct >= 0 && pct <= 100) return { pct, source: wallbox.type };
    }
  } else if (use('evcc')) {
    const lpId = Number(opt.evEvccLoadpoint) || 1;
    const lps = ctx?.evccIntegration?.getLoadpoints?.() || [];
    const lp = lps.find((l) => l.id === lpId);
    // Ohne angestecktes Fahrzeug meldet evcc vehicleSoc 0 (prod 2026-09-23) —
    // das waere fuer EOS ein leerer Akku und ein voller Ladeplan.
    const evccPct = lp?.connected === true ? num(lp?.vehicleSocPct) : null;
    if (evccPct !== null && evccPct >= 0 && evccPct <= 100) return { pct: evccPct, source: 'evcc' };
  }

  if (use('mqtt')) {
    const mqttPct = num(ctx?.vehicleMqtt?.getState?.()?.socPct);
    if (mqttPct !== null && mqttPct >= 0 && mqttPct <= 100) return { pct: mqttPct, source: 'mqtt' };
  }

  return null;
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
  return typeof viaMqtt === 'boolean' ? viaMqtt : null;
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
