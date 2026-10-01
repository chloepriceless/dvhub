import pg from 'pg';

export const LARGE_RESULT_ROWS = 50_000;

export function createPool(config = {}) {
  const pool = new pg.Pool({
    host: config.host || '/var/run/postgresql',
    port: Number(config.port || 5432),
    database: config.name || config.database || 'dvhub',
    user: config.user || 'dvhub',
    password: config.password || '',
    ssl: config.ssl || false,
    min: config.pool?.min ?? 2,
    max: config.pool?.max ?? 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err.message);
  });

  // Speicher-Diagnose (2026-10-01): DVhub sprang auf prod kurz auf ~800 MB bei
  // kleinem JS-Heap — typisch für eine Abfrage, die sehr viele Zeilen in den
  // Speicher holt. Große Ergebnisse (≥ LARGE_RESULT_ROWS) gehen ins Journal,
  // je SQL-Anfang höchstens einmal pro Stunde.
  const origQuery = pool.query.bind(pool);
  const lastWarn = new Map();
  pool.query = (...args) => {
    const started = Date.now();
    const out = origQuery(...args);
    if (out && typeof out.then === 'function') {
      out.then((res) => {
        const n = Number(res?.rowCount ?? res?.rows?.length ?? 0);
        if (n < LARGE_RESULT_ROWS || !Array.isArray(res?.rows) || res.rows.length < LARGE_RESULT_ROWS) return;
        const sql = String(typeof args[0] === 'string' ? args[0] : args[0]?.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        const t = Date.now();
        if (t - (lastWarn.get(sql) || 0) < 3_600_000) return;
        lastWarn.set(sql, t);
        console.warn(`[db] großes Ergebnis: ${res.rows.length} Zeilen in ${t - started} ms — ${sql}`);
      }, () => {});
    }
    return out;
  };

  return pool;
}
