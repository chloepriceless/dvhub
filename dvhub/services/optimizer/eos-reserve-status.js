/**
 * T-RESERVE-VISIBILITY (Christin 2026-07-20): Sichtbarkeit der Übernacht-
 * Reserve in den Einstellungen. Die Reserve-Gates des EOS-Forks (price-aware
 * Release, Wasserfall) werden NICHT über DVhub konfiguriert, sondern als
 * systemd-Environment der eos.service (/etc/systemd/system/eos.service.d/
 * *.conf) — der Drop-in (eos-patches/drop-in/genetic.py) liest sie per
 * os.environ. Folge: die GUI zeigte davon nichts, obwohl die Gates aktiv sind
 * („gesetzte Defaults sieht man nicht"). Dieses Modul liest die wirksamen
 * Gates read-only für eine Status-Karte. Es SCHREIBT nichts — Konfiguration
 * bleibt bewusst bei systemd (Deploy-Kopplung an EOS-Restarts).
 *
 * Läuft EOS remote (eosProxy.url zeigt woandershin) oder fehlt das
 * Verzeichnis, liefert readEosReserveStatus available:false — die Karte zeigt
 * dann „nicht ermittelbar" statt falscher Sicherheit (Verifikations-Disziplin).
 */
import fs from 'node:fs';
import path from 'node:path';

export const EOS_SERVICE_DROPIN_DIR = '/etc/systemd/system/eos.service.d';

// Kanonische Gate-Keys = exakt die os.environ.get()-Keys des Drop-in
// (eos-patches/drop-in/genetic.py). Neue Keys dort → hier nachziehen.
export const RESERVE_ENV_KEYS = [
  'EOS_RESERVE_PRICE_AWARE',
  'EOS_RESERVE_RELEASE_MARGIN',
  'EOS_RESERVE_RELEASE_SPREAD_EUR_PER_WH',
  'EOS_RESERVE_MIN_SAFETY_FLOOR_WH',
  'EOS_RESERVE_MIN_SAFETY_CAP_WH',
  'EOS_RESERVE_SAFETY_FRACTION',
  'EOS_RESERVE_WATERFALL',
  'EOS_OVERNIGHT_RESERVE',
  'EOS_OVERNIGHT_RESERVE_MARGIN',
  // 2026-07-28: η-angepasste Freigabe-Schwelle. Lief seit dem 23.07. auf prod,
  // war aber im Status nicht sichtbar — man konnte am Gerät nicht ablesen, ob
  // die Schwelle wirkungsgradbereinigt rechnet. Rein lesend; den Vorgabewert
  // setzt das EOS-Drop-in, nicht DVhub.
  'EOS_RESERVE_EFF_ADJUST',
];

/**
 * Parst `Environment=KEY=VALUE`-Zeilen aus einer systemd-Unit-Conf.
 * Kommentare/andere Direktiven werden ignoriert; Anführungszeichen um den
 * Gesamtwert (systemd-Stil `Environment="KEY=VALUE"`) werden entfernt.
 * Später gelesene Dateien/Zeilen überschreiben frühere (systemd-Semantik).
 * Pure + exportiert für Tests.
 *
 * @param {string} text - Dateiinhalt
 * @param {object} [into] - bestehendes Env-Objekt (wird gemerged)
 * @returns {object} KEY→VALUE (Strings)
 */
export function parseSystemdEnvConf(text, into = {}) {
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^Environment\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    let rest = m[1].trim();
    if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) {
      rest = rest.slice(1, -1);
    }
    const eq = rest.indexOf('=');
    if (eq <= 0) continue;
    into[rest.slice(0, eq).trim()] = rest.slice(eq + 1).trim();
  }
  return into;
}

function toBool(v) {
  if (v == null) return false;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Liest die wirksamen Reserve-Gates aus den eos.service-Drop-ins.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir] - Drop-in-Verzeichnis (Test-Override)
 * @returns {{
 *   available: boolean, reason?: string, sourceFiles?: string[],
 *   env?: object, gates?: object
 * }}
 */
export function readEosReserveStatus({ dir = EOS_SERVICE_DROPIN_DIR } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return { available: false, reason: `dropin_dir_unreadable: ${e.code || e.message}` };
  }
  // Nur *.conf zählt für systemd — .bak/.disabled etc. bewusst ignorieren.
  const confs = entries.filter((f) => f.endsWith('.conf')).sort();
  const env = {};
  const sourceFiles = [];
  for (const f of confs) {
    try {
      parseSystemdEnvConf(fs.readFileSync(path.join(dir, f), 'utf8'), env);
      sourceFiles.push(f);
    } catch { /* einzelne unlesbare Datei überspringen */ }
  }
  if (!sourceFiles.length) {
    return { available: false, reason: 'no_readable_conf', sourceFiles: [] };
  }
  const picked = {};
  for (const k of RESERVE_ENV_KEYS) if (env[k] !== undefined) picked[k] = env[k];
  return {
    available: true,
    sourceFiles,
    env: picked,
    gates: {
      priceAware: toBool(env.EOS_RESERVE_PRICE_AWARE),
      // Relative Verkaufs-Marge (0.20 = Einspeisung muss vermiedenen
      // Nachtbezug um 20 % schlagen).
      releaseMargin: toNum(env.EOS_RESERVE_RELEASE_MARGIN),
      releaseSpreadEurPerWh: toNum(env.EOS_RESERVE_RELEASE_SPREAD_EUR_PER_WH),
      // Blackout-Puffer, der nie verkauft wird (Wh).
      safetyFloorWh: toNum(env.EOS_RESERVE_MIN_SAFETY_FLOOR_WH),
      safetyCapWh: toNum(env.EOS_RESERVE_MIN_SAFETY_CAP_WH),
      safetyFraction: toNum(env.EOS_RESERVE_SAFETY_FRACTION),
      // Wasserfall: Überschuss belegt teuerste über-Schwelle-Slots zuerst,
      // Reserve verkauft nur in übrige (Christin-Spec, Replay 16.07. validiert).
      waterfall: toBool(env.EOS_RESERVE_WATERFALL),
      overnightReserve: env.EOS_OVERNIGHT_RESERVE !== undefined ? toBool(env.EOS_OVERNIGHT_RESERVE) : null,
      // Rechnet die Freigabe-Schwelle mit dem gemessenen Wirkungsgrad statt mit
      // η=1. Setzt eine kalibrierte Wechselrichter-Kurve voraus — ohne sie ist
      // das Verhältnis 1.0 und die Einstellung wirkungslos.
      effAdjust: toBool(env.EOS_RESERVE_EFF_ADJUST),
    }
  };
}
