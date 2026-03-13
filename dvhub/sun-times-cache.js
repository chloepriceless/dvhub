import fs from 'node:fs';
import path from 'node:path';
import { toFiniteNumber } from './util.js';

export function buildSunTimesCacheKey({ latitude, longitude, year }) {
  return `${latitude}:${longitude}:${year}`;
}

export function readSunTimesForDate({ cache, dateKey }) {
  return cache?.[dateKey] || null;
}

export function isSunTimesCacheStale({ cachedLocation, requestedLocation, cachedYear, requestedYear }) {
  return cachedYear !== requestedYear
    || toFiniteNumber(cachedLocation?.latitude) !== toFiniteNumber(requestedLocation?.latitude)
    || toFiniteNumber(cachedLocation?.longitude) !== toFiniteNumber(requestedLocation?.longitude);
}

export function readSunTimesCacheStore(cachePath) {
  try {
    if (!cachePath || !fs.existsSync(cachePath)) return null;
    const text = fs.readFileSync(cachePath, 'utf8');
    if (!text.trim()) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSunTimesCacheStore(cachePath, store) {
  if (!cachePath) return;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}
