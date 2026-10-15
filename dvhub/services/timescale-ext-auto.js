// services/timescale-ext-auto.js — TimescaleDB-Erweiterung nach einem
// DB-Image-Update selbst anheben (Container, 2026-10-15).
//
// Christin: „Kunden führen ein Update auf die neue DVhub-Version aus, und alles
// ist danach auf dem neuesten Stand.“ Im Container kommt eine neue TimescaleDB
// mit dem DB-Image (TIMESCALE_TAG); die Erweiterung IN der Datenbank bleibt
// aber auf der alten Version, bis jemand `ALTER EXTENSION timescaledb UPDATE`
// ausführt — die GUI-Taste dafür ist im Container gesperrt (sie startet den
// systemd-Postgres neu, den es dort nicht gibt).
//
// Nach einem Image-Tausch läuft Postgres frisch mit der neuen Bibliothek; es
// genügt, das ALTER als ERSTEN Befehl einer neuen Sitzung auszuführen (so
// verlangt es TimescaleDB). Das geschieht hier beim Start, bevor DVhub seinen
// Pool aufbaut — mit dem Admin-Zugang (DVHUB_DB_ADMIN_USER, wie tuneDatabase).
// Nativ übernimmt das stack-update.sh (als root, mit Postgres-Neustarts).
// Blockiert den Start nie.

const PROBE_SQL = `SELECT installed_version, default_version
  FROM pg_available_extensions WHERE name = 'timescaledb'`;
const META_SQL = `UPDATE _timescaledb_catalog.metadata m SET value = e.extversion
  FROM pg_extension e WHERE e.extname = 'timescaledb' AND m.key = 'timescaledb_version' AND m.value <> e.extversion`;

/**
 * @returns {Promise<{upgraded:boolean, from?:string, to?:string, reason?:string, version?:string, error?:string}>}
 */
export async function upgradeTimescaleIfPending({
  createPool, dbConfig = {}, adminUser, adminPassword, pushLog = () => {}, connect = null,
} = {}) {
  if (!adminUser || !adminPassword) return { upgraded: false, reason: 'no_admin' };
  const adminCfg = { ...dbConfig, user: adminUser, password: adminPassword, pool: { min: 0, max: 1 } };
  let probe = null;
  let up = null;
  try {
    probe = createPool(adminCfg);
    if (connect) await connect(probe);
    const row = (await probe.query(PROBE_SQL)).rows?.[0] || {};
    await probe.end().catch(() => {});
    probe = null;
    const from = row.installed_version || null;
    const to = row.default_version || null;
    if (!from) return { upgraded: false, reason: 'not_installed' };
    if (!to || from === to) return { upgraded: false, reason: 'current', version: from };
    // Frische Verbindung: ALTER EXTENSION muss der erste Befehl der Sitzung sein.
    up = createPool(adminCfg);
    await up.query('ALTER EXTENSION timescaledb UPDATE');
    await up.query(META_SQL).catch(() => {});
    pushLog('timescale_extension_upgraded', { from, to });
    return { upgraded: true, from, to };
  } catch (e) {
    pushLog('timescale_extension_upgrade_error', { error: e?.message || String(e) }, 'warn');
    return { upgraded: false, reason: 'error', error: e?.message || String(e) };
  } finally {
    if (probe) await probe.end().catch(() => {});
    if (up) await up.end().catch(() => {});
  }
}
