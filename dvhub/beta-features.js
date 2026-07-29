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
// Zwei Sorten, und der Unterschied ist wichtig:
//
//   gate: 'runtime'  — versteckt UND abgeschaltet. Für Funktionen, die im
//                      Zweifel gar nicht laufen sollen. Braucht eine
//                      Auflösefunktion, die `betaGateOpen` mit-auswertet.
//
//   gate: 'display'  — nur versteckt, der Wert bleibt WIRKSAM. Für Werte, bei
//                      denen das Abschalten gefährlicher wäre als das Anzeigen:
//                      eine ausgeblendete Zugriffsbeschränkung darf nicht
//                      bedeuten, dass die Beschränkung nicht mehr greift. Hier
//                      geht es nur darum, dass ein Kunde sie noch nicht
//                      verstellen kann, solange die Bedienung unfertig ist.
export const BETA_FEATURES = {
  freezeWatchdog: {
    label: 'Einfrier-Wächter',
    gate: 'runtime',
    paths: ['victron.freezeWatchdog']
  },
  mqttCrossCheck: {
    label: 'MQTT-Kreuzprobe',
    gate: 'runtime',
    paths: ['victron.mqttCrossCheck']
  },
  controlWriteVerify: {
    label: 'Schreib-Verifikation',
    gate: 'runtime',
    paths: ['schedule.controlWriteVerify']
  },
  eosProxy: {
    label: 'DV-EOS-Optimierer',
    // NUR Anzeige (Christin, 29.07.2026): der EOS-Proxy ist die EOS-Anbindung
    // selbst, kein Feldtest. Wer ihn eingerichtet hat, fährt mit
    // primarySource: 'eos' — ihn zur Laufzeit abzuschalten hieße, eine
    // eingerichtete Anlage ohne Planer laufen zu lassen. Ausgeblendet sind nur
    // die drei Bedienfelder, solange die Einrichtung über die Integrationsseite
    // läuft. Siehe resolveEosProxy() in services/optimizer/eos-adapter.js.
    gate: 'display',
    paths: ['optimizer.eosProxy']
  },
  accessControl: {
    label: 'Sicherheit & Zugang',
    gate: 'display',
    // NICHT zur Laufzeit gegated: `allowedHosts`, CORS-Herkünfte und die
    // Modbus-Freigabeliste sind Schutzwälle. Sie im Stable-Kanal wirkungslos zu
    // machen, würde jede Kundenbox ÖFFNEN statt sie zu schützen — das genaue
    // Gegenteil des Zwecks. Ausgeblendet sind die Felder nur, bis die
    // Zugangsverwaltung (Benutzer + Passwort statt Token) fertig ist; bis
    // dahin bleibt die Bedienung dem Bleeding-Edge-Kanal vorbehalten.
    paths: [
      // BEWUSST nicht der ganze `security`-Zweig: `security.lanTrust` ist der
      // vorhandene, ausgelieferte Hauptschalter der Vertrauensstufe. Ihn zu
      // verstecken würde Kunden eine Absicherung WEGNEHMEN, die sie heute
      // haben. Neu und deshalb noch zurückgehalten sind nur die Feinlisten.
      'security.lanCidrs',
      'security.lanSafeGroups',
      'security.trustedClientIps',
      'allowedHosts',
      'corsAllowedOrigins',
      'trustProxy',
      'trustedProxyIps',
      'modbusAllowedClients'
    ]
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
  const feature = Object.prototype.hasOwnProperty.call(BETA_FEATURES, key)
    ? BETA_FEATURES[key] : null;
  // Unbekannt ODER nur ein Anzeige-Gate ⇒ zu. Wer versehentlich ein
  // display-Feature zur Laufzeit abfragt, schaltet es damit ab statt es
  // ungeprüft freizugeben; test/beta-gate.test.js fängt den Fall.
  if (!feature || feature.gate !== 'runtime') return false;
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
