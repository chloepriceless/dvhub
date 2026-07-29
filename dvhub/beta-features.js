// beta-features.js — Beta-Gate für Einstellungen (Christin, 29.07.2026)
//
// Es gab bisher nur ein halbes Gate: `listManufacturerProfiles()` in
// routes-api.js blendet Herstellerprofile mit `"beta": true` aus, solange
// `updateChannel` nicht 'dev' ist. Für EINSTELLUNGEN fehlte das Gegenstück —
// ein Feldtest wanderte damit zwangsläufig mit dem nächsten Release auf jede
// Kundenbox, sobald sein Schalter im Code stand.
//
// Zwei Hälften, und die zweite ist die wichtige:
//
//   SICHTBAR — ein Feld mit `beta: true` erscheint in den Einstellungen nur im
//   Bleeding-Edge-Kanal (public/settings.js → isFieldVisible).
//
//   WIRKSAM — ein verstecktes Feld steht trotzdem in der config.json, und der
//   Code liest es weiter. Deshalb darf kein Beta-Feature seinen Schalter direkt
//   auswerten, sondern nur UND-verknüpft mit `betaGateOpen()`. Damit schaltet
//   sich ein halbfertiges Feature von selbst ab, wenn jemand von 'dev' zurück
//   auf 'stable' wechselt — statt still weiterzulaufen.
//
// So bleibt der Code für beide Kanäle identisch (kein divergierender
// dev/stable-Zweig) — dieselbe Begründung wie beim Profil-Gate.

// Registry: was gilt als Beta, und welcher Config-Teilbaum gehört dazu.
// `paths` ist die Präfix-Liste, an der test/beta-gate.test.js abgleicht, dass
// jedes als `beta: true` markierte Einstellungsfeld auch wirklich zu einem
// registrierten Feature gehört (sonst wäre es zwar unsichtbar, aber ungegatet).
export const BETA_FEATURES = {
  freezeWatchdog: {
    label: 'Einfrier-Wächter',
    paths: ['victron.freezeWatchdog']
  },
  mqttCrossCheck: {
    label: 'MQTT-Kreuzprobe',
    paths: ['victron.mqttCrossCheck']
  },
  controlWriteVerify: {
    label: 'Schreib-Verifikation',
    paths: ['schedule.controlWriteVerify']
  }
};

export const DEV_CHANNEL = 'dev';

/**
 * Update-Kanal der Anlage. Fehlt der Schlüssel, gilt 'stable' — eine Box ohne
 * ausdrückliche Entscheidung ist eine Produktivanlage.
 * @param {object} cfg  effektive oder rohe DVhub-Config
 * @returns {string}
 */
export function updateChannelOf(cfg) {
  const raw = cfg?.updateChannel;
  return (typeof raw === 'string' && raw.trim()) ? raw.trim() : 'stable';
}

/**
 * Darf ein Beta-Feature überhaupt laufen?
 *
 * Fail-closed: ein unbekannter Schlüssel liefert false. Ein Tippfehler an einer
 * Aufrufstelle schaltet das Feature also ab, statt es versehentlich für alle
 * freizugeben — und test/beta-gate.test.js fängt genau diesen Fall.
 *
 * @param {object} cfg  effektive DVhub-Config
 * @param {string} key  Schlüssel aus BETA_FEATURES
 * @returns {boolean}
 */
export function betaGateOpen(cfg, key) {
  if (!Object.prototype.hasOwnProperty.call(BETA_FEATURES, key)) return false;
  return updateChannelOf(cfg) === DEV_CHANNEL;
}

/**
 * Gehört ein Config-Pfad zu einem registrierten Beta-Feature?
 * @param {string} path  Punkt-Pfad einer Felddefinition
 * @returns {string|null}  Feature-Schlüssel oder null
 */
export function betaFeatureForPath(path) {
  if (typeof path !== 'string' || !path) return null;
  for (const [key, feature] of Object.entries(BETA_FEATURES)) {
    for (const prefix of feature.paths) {
      if (path === prefix || path.startsWith(`${prefix}.`)) return key;
    }
  }
  return null;
}
