// services/system-timezone.js — eine Zeitzone für alles.
//
// Maßgeblich ist die Einstellung „Zeitzone“ (schedule.timezone). Viele Stellen
// rechnen mit der Uhr des Prozesses (new Date().getHours(), setHours(0,0,0,0):
// Tagesgrenzen beim Preisabruf, Mehrtages-Logik, Familien-Dashboard,
// Ruhezeiten, Backup-Uhrzeit). Steht das System auf UTC — frisch aufgesetztes
// Linux, Container ohne TZ —, lagen sie im Sommer zwei Stunden daneben, obwohl
// die Einstellung richtig war. Deshalb stellt DVhub die Uhr des Prozesses auf
// die eingestellte Zeitzone; die Zeitzone des Betriebssystems spielt dann
// keine Rolle mehr.

const FALLBACK = 'Europe/Berlin';

export function isUsableTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Setzt die eingestellte Zeitzone für den Prozess und für die Bereiche mit
 * eigener Zeitzonen-Angabe (Börsenpreise, EOS).
 * @param {object} cfg  effektive Konfiguration (wird verändert)
 * @param {object} [env=process.env]
 * @returns {{ timeZone: string, changed: boolean, previous: string|null }}
 */
export function applySystemTimeZone(cfg, env = process.env) {
  const wanted = cfg?.schedule?.timezone;
  const timeZone = isUsableTimeZone(wanted) ? wanted.trim() : FALLBACK;
  if (cfg && typeof cfg === 'object') {
    if (cfg.epex && typeof cfg.epex === 'object') cfg.epex.timezone = timeZone;
    if (cfg.optimizer && typeof cfg.optimizer === 'object') cfg.optimizer.timezone = timeZone;
  }
  const previous = env.TZ ?? null;
  const changed = previous !== timeZone;
  // Node liest TZ bei jeder Zuweisung neu ein — Date rechnet sofort um.
  if (changed) env.TZ = timeZone;
  return { timeZone, changed, previous };
}
