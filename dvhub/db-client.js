import pg from 'pg';

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

  return pool;
}
