---
phase: 9
slug: http-enhancements-caching
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-29
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in test runner (`node --test`, ≥18) |
| **Config file** | None — uses `package.json` script `"test": "node --test"` |
| **Quick run command** | `cd dvhub && node --test test/http-*.test.js` |
| **Full suite command** | `cd dvhub && node --test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd dvhub && node --test test/http-*.test.js`
- **After every plan wave:** Run `cd dvhub && node --test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 09-01 | 1 | HTTP-02 | unit | `cd dvhub && node --test test/http-content-length.test.js` | ❌ W0 | ⬜ pending |
| 09-01-02 | 09-01 | 1 | HTTP-01 | unit | `cd dvhub && node --test test/http-health.test.js` | ❌ W0 | ⬜ pending |
| 09-02-01 | 09-02 | 2 | HTTP-03 | unit | `cd dvhub && node --test test/http-access-log.test.js` | ❌ W0 | ⬜ pending |
| 09-02-02 | 09-02 | 2 | FE-03 | unit | `cd dvhub && node --test test/http-cache-control.test.js` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `dvhub/test/http-health.test.js` — covers HTTP-01 (mock ctx, call handleRequest, assert JSON shape `{ ok, uptimeSec, version }`)
- [ ] `dvhub/test/http-content-length.test.js` — covers HTTP-02 (call json/text with Umlaut strings, assert `Content-Length` equals `Buffer.byteLength`)
- [ ] `dvhub/test/http-access-log.test.js` — covers HTTP-03 (spy on console.log, trigger finish event, assert log format)
- [ ] `dvhub/test/http-cache-control.test.js` — covers FE-03 (call serveStatic/servePage for different file types, assert Cache-Control header values)

**Testability note:** `json()`, `text()`, `downloadJson()` are internal to `createApiRoutes()` closure. Test HTTP-02 by calling `handleRequest` with a mock request/response that triggers a route using these helpers (option a — tests full path). For HTTP-01, call `handleRequest` with `url.pathname === '/health'` on a mock. For HTTP-03, the access logging is in `server.js`'s `http.createServer` callback — test by spying on `console.log`.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|

*None — all behaviors are unit-testable.*
