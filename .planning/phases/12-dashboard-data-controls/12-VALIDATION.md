---
phase: 12
slug: dashboard-data-controls
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-15
---

# Phase 12 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in test runner (node:test) |
| **Config file** | none — uses `node --test` directly |
| **Quick run command** | `node --test dvhub/test/<changed-module>.test.js` |
| **Full suite command** | `node --test dvhub/test/*.test.js` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `node --test dvhub/test/<changed-module>.test.js`
- **After every plan wave:** Run `node --test dvhub/test/*.test.js`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 12-01-01 | 01 | 1 | DATA-01 | unit | `node --test dvhub/test/dashboard-data-cards.test.js` | Plan Task 1 | ⬜ pending |
| 12-01-02 | 01 | 1 | DATA-02 | unit | `node --test dvhub/test/dashboard-data-cards.test.js` | Plan Task 1 | ⬜ pending |
| 12-01-03 | 01 | 1 | DATA-03 | unit | `node --test dvhub/test/dashboard-data-cards.test.js` | Plan Task 1 | ⬜ pending |
| 12-01-04 | 01 | 1 | DATA-04 | unit | `node --test dvhub/test/dashboard-data-cards.test.js` | Plan Task 1 | ⬜ pending |
| 12-01-05 | 01 | 1 | DATA-05 | unit | `node --test dvhub/test/dashboard-data-cards.test.js` | Plan Task 1 | ⬜ pending |
| 12-01-06 | 01 | 1 | DATA-08 | unit | `node --test dvhub/test/dashboard-data-cards.test.js` | Plan Task 1 | ⬜ pending |
| 12-02-01 | 02 | 2 | CTRL-01 | unit | `node --test dvhub/test/control-panel-writes.test.js` | Plan Task 1 | ⬜ pending |
| 12-02-02 | 02 | 2 | CTRL-02 | unit | `node --test dvhub/test/control-panel-writes.test.js` | Plan Task 1 | ⬜ pending |
| 12-02-03 | 02 | 2 | CTRL-03 | unit | `node --test dvhub/test/control-panel-writes.test.js` | Plan Task 1 | ⬜ pending |
| 12-03-01 | 03 | 2 | DATA-06 | unit | `node --test dvhub/test/schedule-panel-compute.test.js` | Plan Task 1 | ⬜ pending |
| 12-03-02 | 03 | 2 | DATA-07 | unit | `node --test dvhub/test/schedule-panel-compute.test.js` | Plan Task 1 | ⬜ pending |
| 12-03-03 | 03 | 2 | CTRL-04 | unit | `node --test dvhub/test/schedule-panel-compute.test.js` | Plan Task 1 | ⬜ pending |
| 12-03-04 | 03 | 2 | CTRL-05 | unit | `node --test dvhub/test/schedule-panel-compute.test.js` | Plan Task 1 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Test files are created by Plan Task 1 in each plan (pure compute function tests):

- [x] `dvhub/test/dashboard-data-cards.test.js` — pure logic tests for DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, DATA-08 (created by Plan 12-01 Task 1)
- [x] `dvhub/test/control-panel-writes.test.js` — pure logic tests for CTRL-01, CTRL-02, CTRL-03 (created by Plan 12-02 Task 1)
- [x] `dvhub/test/schedule-panel-compute.test.js` — pure logic tests for DATA-06, DATA-07, CTRL-04, CTRL-05 (created by Plan 12-03 Task 1)

*Testing strategy: test pure compute functions, not Preact rendering (project convention per RESEARCH.md).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Min SOC slider blink animation | CTRL-01 | CSS animation timing | Adjust slider, observe orange blink, confirm green flash on success |
| Cost card color coding | DATA-03 | Visual color validation | Verify green for profit, red for cost in browser |
| Grid layout span-4 rendering | DATA-04 | CSS grid visual check | Confirm 3-column Row 2 renders correctly across viewport widths |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 5s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-03-15
