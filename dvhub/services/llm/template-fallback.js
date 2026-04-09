// services/llm/template-fallback.js -- Template-based German message generation.
// Provides fallback messages for Tier 1/2 systems without Ollama/LLM.
// Per D-14, D-16, D-17: German messages for energy dashboard.

const TEMPLATES = {
  status: [
    'PV: {pvKwh} kWh | Batterie: {soc}% | Netz: {gridW}W',
    'Aktuelle Produktion: {pvW}W bei {soc}% Batteriestand.',
    'Heute bisher {pvTodayKwh} kWh erzeugt, {consumedKwh} kWh verbraucht.'
  ],
  savings: [
    'Batterie wird um {time} geladen — Strom kostet nur {price} ct/kWh.',
    'Negativpreis! Einspeisung pausiert, Batterie laedt kostenlos.',
    'PV-Ueberschuss: {excessW}W fliessen ins Netz ({feedInCt} ct/kWh).'
  ],
  alert: [
    'Achtung: Batteriestand bei {soc}% — Mindest-SOC unterschritten.',
    'Forecast-Fehler: {source} antwortet nicht seit {minutes} Min.'
  ],
  pv_record: [
    'Neuer Tagesrekord: {pvTodayKwh} kWh PV-Erzeugung!',
    'PV-Rekord! {pvTodayKwh} kWh heute — bisher bester Tag.'
  ],
  negative_price: [
    'Negativpreis aktiv — kostenlose Batterieladung bis {until}.',
    'Strom hat negativen Preis ({price} ct/kWh) — Batterie wird voll geladen.'
  ]
};

const EMOJIS = {
  status: '\u26A1',
  savings: '\uD83D\uDCB0',
  alert: '\u26A0\uFE0F',
  pv_record: '\u2600\uFE0F',
  negative_price: '\uD83C\uDF89'
};

const DEFAULT_EMOJI = '\uD83D\uDCE1';

/**
 * Generate a template-based German message for the given type.
 * Falls back to 'status' type if the requested type is unknown.
 * Replaces {key} placeholders with data[key], using '?' for missing values.
 *
 * @param {string} type - Message type: status, savings, alert, pv_record, negative_price
 * @param {object} data - Key-value pairs for placeholder replacement
 * @returns {string} Generated message
 */
export function generateTemplateMessage(type, data) {
  const pool = TEMPLATES[type] || TEMPLATES.status;
  const template = pool[Math.floor(Math.random() * pool.length)];
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const val = data[key];
    return val != null ? String(val) : '?';
  });
}

/**
 * Get the emoji for a given message type (per D-16).
 *
 * @param {string} type - Message type
 * @returns {string} Emoji character
 */
export function getMessageEmoji(type) {
  return EMOJIS[type] || DEFAULT_EMOJI;
}
