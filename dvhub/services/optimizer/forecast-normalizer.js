// services/optimizer/forecast-normalizer.js -- Bridge between ISO-string forecast API
// and optimizer-internal epoch-ms slot format.
// Transforms buildForecastResponse() output to optimizer-friendly shape with
// epoch-ms timestamps and per-slot confidence. Also provides 15min-to-1h aggregation.

/**
 * Normalize a single forecast section's slots from ISO-string to epoch-ms.
 * Preserves all value fields (ctKwh, powerW) and per-slot confidence.
 *
 * @param {Array<{start: string, end: string, confidence: number}>} slots - ISO-string slots
 * @param {string[]} valueKeys - Which value fields to carry over (e.g. ['ctKwh'] or ['powerW'])
 * @returns {Array<{ts: number, endTs: number, confidence: number}>}
 */
function normalizeSection(slots, valueKeys) {
  return slots.map(s => {
    const normalized = {
      ts: new Date(s.start).getTime(),
      endTs: new Date(s.end).getTime(),
      confidence: s.confidence
    };
    for (const key of valueKeys) {
      normalized[key] = s[key];
    }
    return normalized;
  });
}

/**
 * Normalize a full buildForecastResponse() output to optimizer-internal format.
 * Converts ISO-string timestamps to epoch-ms, preserves per-slot confidence.
 *
 * @param {object} forecastResponse - Output of buildForecastResponse()
 * @param {object} forecastResponse.price - Price section { resolution, slots }
 * @param {object} forecastResponse.pv - PV section { resolution, slots }
 * @param {object} forecastResponse.load - Load section { resolution, slots }
 * @returns {{ price: { resolution: string, slots: Array }, pv: { resolution: string, slots: Array }, load: { resolution: string, slots: Array } }}
 */
export function normalizeForecast(forecastResponse) {
  return {
    price: {
      resolution: forecastResponse.price.resolution,
      slots: normalizeSection(forecastResponse.price.slots, ['ctKwh'])
    },
    pv: {
      resolution: forecastResponse.pv.resolution,
      slots: normalizeSection(forecastResponse.pv.slots, ['powerW'])
    },
    load: {
      resolution: forecastResponse.load.resolution,
      slots: normalizeSection(forecastResponse.load.slots, ['powerW'])
    }
  };
}

/**
 * Compute the average confidence across an array of normalized slots.
 * Used by the optimizer to derive a single confidence value for confidence gating.
 *
 * @param {Array<{confidence: number}>} slots - Normalized slots with per-slot confidence
 * @returns {number} Average confidence 0.0-1.0, or 0.3 (conservative default) if empty
 */
export function averageSlotConfidence(slots) {
  if (!slots || slots.length === 0) return 0.3;

  let sum = 0;
  for (const slot of slots) {
    sum += slot.confidence;
  }
  return sum / slots.length;
}

/**
 * Aggregate 15-min slots into 1-hour buckets.
 * Groups by flooring ts to the hour boundary. For each hour:
 *   - valueKey is averaged across the slots in that hour
 *   - confidence uses min() (conservative: weakest link)
 *
 * If slots are already 1h-aligned (load), they pass through unchanged.
 * Partial hours (<4 slots) are aggregated with available data.
 *
 * @param {Array<{ts: number, endTs: number, confidence: number}>} slots15min - 15-min slots
 * @param {string} valueKey - Field to average: 'ctKwh' for price, 'powerW' for PV
 * @returns {Array<{ts: number, endTs: number, confidence: number}>} 1-hour slots
 */
export function aggregateTo1h(slots15min, valueKey) {
  if (!slots15min || slots15min.length === 0) return [];

  // Group slots by hour boundary
  const hourBuckets = new Map();

  for (const slot of slots15min) {
    // Floor to hour boundary: subtract remainder of ms within the hour
    const hourStart = slot.ts - (slot.ts % 3600000);

    if (!hourBuckets.has(hourStart)) {
      hourBuckets.set(hourStart, []);
    }
    hourBuckets.get(hourStart).push(slot);
  }

  // Aggregate each hour bucket
  const result = [];
  for (const [hourStart, bucketSlots] of hourBuckets) {
    let valueSum = 0;
    let minConfidence = Infinity;

    for (const s of bucketSlots) {
      valueSum += s[valueKey];
      if (s.confidence < minConfidence) minConfidence = s.confidence;
    }

    const aggregated = {
      ts: hourStart,
      endTs: hourStart + 3600000,
      confidence: Math.min(minConfidence)
    };
    aggregated[valueKey] = valueSum / bucketSlots.length;

    result.push(aggregated);
  }

  // Sort by timestamp
  result.sort((a, b) => a.ts - b.ts);

  return result;
}
