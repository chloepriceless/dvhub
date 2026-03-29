# Code Review — 2026-03-30

**Reviewer:** octo:code-reviewer (Claude, AI-elevated rigor)
**Scope:** Full dvhub/ codebase — correctness, security, architecture, TDD
**Provenance:** AI-assisted

---

## 🔴 Critical

### C1 — Config export leaks secrets
- **File:** `dvhub/routes-api.js:617`
- **Issue:** `/api/config/export` calls `ctx.getRawCfg()` without `redactConfig()`. Dumps apiToken, telemetry DB password, and VRM token in plaintext. Route is in `LAN_SAFE_ENDPOINTS` — no auth required for LAN users.
- **Fix:** `return downloadJson(res, 'dvhub-config.json', redactConfig(ctx.getRawCfg()));`

### C2 — Unvalidated body spread into authenticated VRM call
- **File:** `dvhub/routes-api.js:1118`
- **Issue:** `{ ...body, mode: requestedMode }` forwards all user-supplied JSON keys into the VRM API call. Attacker can inject `vrmToken`, `provider`, or arbitrary properties.
- **Fix:** `ctx.historyImportManager.backfillHistoryFromConfiguredSource({ mode: requestedMode, requestedBy: 'api' })`

---

## 🟡 High

### H1 — Auth token in query string
- **File:** `dvhub/routes-api.js:250`
- **Issue:** `?token=` tokens appear in proxy logs, browser history, and referer headers (OWASP sensitive data exposure).
- **Fix:** Remove query-string token support or document the risk explicitly.

### H2 — LAN requests bypass rate limiting entirely
- **File:** `dvhub/routes-api.js:208`
- **Issue:** `checkRateLimit()` returns `true` immediately for all LAN requests. A compromised IoT device on the LAN can exhaust the schedule evaluator.
- **Fix:** Apply a higher rate limit for LAN (e.g. 600 req/min) rather than bypassing entirely.

### H3 — No allowlist on `/api/control/write` target
- **File:** `dvhub/routes-api.js:1211`
- **Issue:** `body.target` is stored as `state.schedule.manualOverride[target]` with no allowlist. Arbitrary keys pollute internal state.
- **Fix:**
  ```js
  const VALID_TARGETS = new Set(['gridSetpointW', 'chargeCurrentA', 'feedExcessDcPv', 'minSocPct']);
  if (!VALID_TARGETS.has(target)) return json(res, 400, { error: 'invalid target' });
  ```

### H4 — Modbus server accepts connections from any IP
- **File:** `dvhub/modbus-server.js:131`
- **Issue:** FC6/FC16 write codes can toggle `forcedOff` on the inverter. Any LAN device can disable the system.
- **Fix:** Add `modbusAllowedIps` config option; reject connections from unlisted addresses.

### H5 — SOC stop threshold off-by-one (hardware safety)
- **File:** `dvhub/schedule-runtime.js:59`
- **Issue:** `Number(batterySocPct) > stopSocPct` leaves rule active at exactly the threshold. Battery can discharge one extra evaluation cycle (~15s) below protection level.
- **Fix:** Change `>` to `>=`.

---

## 🟠 Medium

| ID | File | Issue |
|----|------|-------|
| M1 | schedule-eval.js:291 | DC export SOC guard uses hardcoded 2h window — not configurable |
| M2 | schedule-eval.js:78,95 | `Date.now()` called twice — TOCTOU risk at window boundary |
| M3 | server-utils.js:41 | `parseBody` returns `{}` on malformed JSON instead of 400 |
| M4 | schedule-runtime.js:11 | Overnight manual rules become permanent — no date binding |
| M5 | server.js:546-600 | DI ctx mutation order — fragile temporal coupling |
| M6 | small-market-automation-integration.test.js | Test re-implements `buildNeedsRegeneration` locally — false confidence |
| M7 | routes-api.js:216 | Fixed-window rate limit allows 2x burst at window boundary |

---

## 🟢 Low / Nitpicks

| ID | File | Issue |
|----|------|-------|
| L1 | modbus-server.js:148 | Socket errors silently swallowed — should log |
| L2 | server.js:486 | `pushLog` uses O(n) `.shift()` — use circular buffer |
| L3 | epex-fetch.js:185 | `epexNowNext()` returns stale slot if no slot matches current time |
| L4 | server-utils.js:52 | `berlinDateString` relies on `sv-SE` locale trick |
| L5 | routes-api.js:22 | CSP allows `unsafe-inline` styles |
| L6 | routes-api.js:115 | No `Cache-Control: no-store` on JSON API responses |
| L7 | routes-api.js:8 | Dead import: `spawn` never used |

---

## ✅ What's done well

- Timing-safe token comparison (`crypto.timingSafeEqual`), full security headers, default-deny auth
- Crash-safe atomic energy persistence (write + rename)
- Plan-lock prevents mid-execution optimizer re-run
- Correct Modbus int16/uint16/int32/uint32 encoding with word ordering
- Clean factory/DI architecture with clear module boundaries
- Prototype pollution protection in config-model.js (`FORBIDDEN_PATH_SEGMENTS`)
- Good behavioral test coverage for scheduling and optimization logic

---

## Priority Order for Fixes

1. **C1** — 1 line, immediate security fix
2. **C2** — 3 lines, closes authenticated API injection
3. **H5** — 1 character, hardware safety (SOC protection)
4. **H3** — 5 lines, closes state pollution
5. **H4** — config option + IP check in modbus-server.js
6. **H1/H2** — hardening, lower urgency

---

*Generated: 2026-03-30*
