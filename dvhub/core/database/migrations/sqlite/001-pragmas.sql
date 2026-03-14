-- 001-pragmas.sql
-- Optimal PRAGMAs for HEMS telemetry workload on SQLite.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -20000;
PRAGMA mmap_size = 268435456;
PRAGMA wal_autocheckpoint = 1000;
