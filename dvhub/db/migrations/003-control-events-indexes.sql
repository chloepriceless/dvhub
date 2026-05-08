-- Migration 003: control_events indexes (REPOLENS database/index-strategy/003).
--
-- The control_events table currently has zero indexes. Every query of the form
-- "show recent writes to gridSetpointW" or "list all dv_victron_write events
-- since X" performs a sequential scan. On a Pi with millions of rows this is
-- the difference between a 50ms response and a multi-second hang under
-- concurrent load.
--
-- The three indexes below cover the canonical access patterns:
--   - (target, ts_utc DESC): "what is the recent history for this register?"
--     used by /api/control/events?target=gridSetpointW
--   - (event_type, ts_utc DESC): "show all dv_victron_write events"
--     used by audit queries grouping by event_type
--   - (ts_utc DESC): "show the last N events regardless of type/target"
--     used by the operator log panel
BEGIN;

CREATE INDEX IF NOT EXISTS idx_control_events_target_ts ON control_events (target, ts_utc DESC);
CREATE INDEX IF NOT EXISTS idx_control_events_event_ts ON control_events (event_type, ts_utc DESC);
CREATE INDEX IF NOT EXISTS idx_control_events_ts ON control_events (ts_utc DESC);

INSERT INTO schema_migrations (version, description, applied_at)
VALUES (3, 'control_events indexes on (target, ts_utc), (event_type, ts_utc), (ts_utc)', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
