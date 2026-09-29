// test/helpers/active-window.js — ein Zeitplan-Fenster, das JETZT sicher aktiv
// ist. '00:00'–'23:59' war es nicht: scheduleMatch ist end-exklusiv, und
// zwischen 23:59 und 00:00 (Berlin) schlugen die Tests deshalb fehl (CI-Lauf
// 29.09.2026 23:59:54). Ein Ganztags-Fenster lässt sich nicht ausdrücken
// (start == end passt nie), daher ±2 h um die aktuelle Uhrzeit — über
// Mitternacht erlaubt (start > end).
import { localMinutesOfDay } from '../../server-utils.js';

const hhmm = (min) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function activeWindow(timezone = 'Europe/Berlin', now = new Date()) {
  const nowMin = localMinutesOfDay(now, timezone);
  return { start: hhmm(nowMin - 120), end: hhmm(nowMin + 120) };
}
