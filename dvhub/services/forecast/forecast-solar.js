// services/forecast/forecast-solar.js -- Forecast.Solar API client.
// Free, no API key required. 12 requests/hour limit.
// API: https://api.forecast.solar/estimate/{lat}/{lon}/{dec}/{az}/{kwp}
import { effectivePvKwp } from './effective-pv.js';

/**
 * Create Forecast.Solar client.
 * @param {object} ctx - DI context { getCfg, pushLog }
 * @param {object} deps - { store }
 */
export function createForecastSolar(ctx, { store }) {
  const { getCfg, pushLog } = ctx;

  let lastFetchAt = null;
  let cachedData = null;
  const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min between fetches (12/hour limit)

  /**
   * Resolve PV system parameters from config.
   * Falls back to existing pvPlants and location data.
   */
  function resolveParams() {
    const cfg = getCfg();
    const fc = cfg.forecast || {};
    const pv = fc.pv || {};

    // Location: forecast.location -> schedule.smallMarketAutomation.location
    const lat = fc.location?.latitude
      || cfg.schedule?.smallMarketAutomation?.location?.latitude;
    const lon = fc.location?.longitude
      || cfg.schedule?.smallMarketAutomation?.location?.longitude;

    if (!lat || !lon) return null;

    // kWp: forecast.pv.totalKwp -> sum of pvPlants, plus PV am zweiten Sungrow-WR (Punkt 5)
    let kwp = pv.totalKwp;
    if (!kwp && Array.isArray(cfg.userEnergyPricing?.pvPlants)) {
      kwp = cfg.userEnergyPricing.pvPlants.reduce((sum, p) => sum + (p.kwp || 0), 0);
    }
    kwp = effectivePvKwp(cfg, kwp);
    if (!kwp) return null;

    // Neigung (dec) und Ausrichtung (dvhubAz) der abgefragten Fläche.
    // M13 (Feld 16.11.): Im Detail-Modus gibt es keine pv.tiltDeg/azimuthDeg — früher fiel die
    // Abfrage auf 35°/180° (Süd) zurück, obwohl z. B. String 2 nach NNO zeigt.
    //
    // M13b: Die Forecast.Solar-GRATIS-API kennt nur EINE Fläche je Abfrage (Pfad
    // /estimate/{lat}/{lon}/{dec}/{az}/{kwp}); echte Multi-Flächen gibt es erst im
    // bezahlten JSON-Tarif. Ein einzelner Ebenen-Abruf für eine real GESPREIZTE
    // Anlage (z. B. String 1 216° SW, String 2 25° NNO) ist systematisch falsch:
    // Nimmt man die Geometrie des größten Strings mit der GESAMT-kWp, überschätzt
    // man den abgewandten String kräftig. Da Forecast.Solar nur ein Ensemble-Member
    // ist, ist der robuste Weg, es bei einer gespreizten Detail-Anlage GANZ aus dem
    // Ensemble zu nehmen (kein Fetch, kein Store-Write → effektiv Gewicht 0), statt
    // eine verzerrte Prognose einzuspeisen. Koplanare Detail-Strings (ein Dach) und
    // Single-String/Simple/Standard laufen wie bisher weiter.
    let dec = pv.tiltDeg ?? 35;
    let dvhubAz = pv.azimuthDeg ?? 180;
    const strings = (pv.configLevel === 'detailed' && Array.isArray(pv.strings))
      ? pv.strings.filter(s => Number(s?.kwp) > 0)
      : [];
    if (strings.length >= 2) {
      // Gespreizt? Azimut-Spanne (zyklisch, 0–180°) oder Neigungsspanne prüfen.
      const azs = strings.map(s => Number(s.azimuthDeg)).filter(Number.isFinite);
      const tilts = strings.map(s => Number(s.tiltDeg)).filter(Number.isFinite);
      let azSpread = 0;
      for (let i = 0; i < azs.length; i++) {
        for (let j = i + 1; j < azs.length; j++) {
          const d = Math.abs(azs[i] - azs[j]) % 360;
          azSpread = Math.max(azSpread, d > 180 ? 360 - d : d);
        }
      }
      const tiltSpread = tilts.length >= 2 ? Math.max(...tilts) - Math.min(...tilts) : 0;
      if (azSpread > 45 || tiltSpread > 15) {
        return { skip: 'multi_plane_detailed', azSpread: Math.round(azSpread), tiltSpread };
      }
    }
    if (strings.length > 0) {
      const largest = strings.reduce((a, b) => (Number(b.kwp) > Number(a.kwp) ? b : a));
      if (Number.isFinite(Number(largest.tiltDeg))) dec = Number(largest.tiltDeg);
      if (Number.isFinite(Number(largest.azimuthDeg))) dvhubAz = Number(largest.azimuthDeg);
    }
    // Forecast.Solar uses different azimuth convention: -180=N, -90=E, 0=S, 90=W
    // DVhub uses: 0=N, 90=E, 180=S, 270=W
    // Conversion: forecastSolarAz = dvhubAz - 180
    const az = dvhubAz - 180;

    return { lat, lon, dec, az, kwp };
  }

  /**
   * Fetch PV forecast from Forecast.Solar API.
   * Returns array of { ts_utc, power_w } for the next ~48h.
   */
  async function fetchForecast() {
    const params = resolveParams();
    if (!params) {
      pushLog('forecast_solar_skip', { reason: 'missing_params' });
      return null;
    }
    // M13b: gespreizte Detail-Anlage → Forecast.Solar aus dem Ensemble nehmen.
    if (params.skip) {
      pushLog('forecast_solar_skip', {
        reason: params.skip, azSpread: params.azSpread, tiltSpread: params.tiltSpread,
      });
      return null;
    }

    // Rate limit check
    if (lastFetchAt && (Date.now() - lastFetchAt) < MIN_INTERVAL_MS) {
      return cachedData;
    }

    const { lat, lon, dec, az, kwp } = params;
    const url = `https://api.forecast.solar/estimate/${lat}/${lon}/${dec}/${az}/${kwp}`;

    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        pushLog('forecast_solar_error', { status: res.status, body: text.slice(0, 200) });
        return cachedData; // Return cached on error
      }

      const data = await res.json();
      lastFetchAt = Date.now();

      // M13b: `power_w` ist LEISTUNG (W), also die mittlere Leistung je Slot aus
      // `result.watts` lesen — NICHT `watt_hours_period` (das ist ENERGIE in Wh je
      // Intervall). Das alte Mapping power_w = watt_hours_period stimmte nur zufällig
      // bei exakt stündlichen Intervallen; bei den unregelmäßigen Sonnenauf-/
      // untergangs-Intervallen (Doc-Beispiel 07:29/18:27) oder anderer `resolution`
      // war die gespeicherte „Leistung" falsch und der Leitstand re-integrierte sie
      // (power_w × Δt) ein zweites Mal. `watts` (Durchschnittsleistung je Periode)
      // ist bei jeder Auflösung korrekt. Fallback: aus watt_hours_period / Intervall.
      const result = data?.result || {};
      const watts = result.watts;
      let entries;
      if (watts && typeof watts === 'object' && Object.keys(watts).length > 0) {
        entries = Object.entries(watts).map(([timeStr, w]) => [timeStr, Number(w)]);
      } else {
        // Fallback: Energie → Leistung über das echte Intervall zum Vorslot umrechnen.
        const whPeriod = result.watt_hours_period || {};
        const keys = Object.keys(whPeriod).sort();
        entries = keys.map((timeStr, i) => {
          const wh = Number(whPeriod[timeStr]);
          let dtH = 1;
          if (i > 0) {
            const dt = (new Date(timeStr) - new Date(keys[i - 1])) / 3600000;
            if (Number.isFinite(dt) && dt > 0) dtH = dt;
          }
          return [timeStr, wh / dtH]; // Wh / h = W
        });
      }

      const slots = [];
      for (const [timeStr, powerRaw] of entries) {
        const ts = new Date(timeStr);
        if (isNaN(ts.getTime())) continue;
        const powerW = Number(powerRaw);
        if (!Number.isFinite(powerW)) continue;
        slots.push({
          ts_utc: ts.toISOString(),
          power_w: Math.round(powerW * 10) / 10
        });
      }

      // Also persist to DB if store available
      if (store && slots.length > 0) {
        const points = slots.map(s => ({
          model: 'forecast_solar',
          ts_utc: s.ts_utc,
          power_w: s.power_w,
          confidence: 0.7 // Free API, decent accuracy
        }));
        await store.writePvForecasts(points).catch(e =>
          pushLog('forecast_solar_store_error', { error: e.message })
        );
      }

      cachedData = slots;
      pushLog('forecast_solar_ok', { slots: slots.length, kwp });
      return slots;

    } catch (e) {
      pushLog('forecast_solar_error', { error: e.message });
      return cachedData;
    }
  }

  return {
    fetchForecast,
    get lastFetchAt() { return lastFetchAt; },
    get cachedSlots() { return cachedData?.length || 0; }
  };
}
