---
phase: 12
slug: dashboard-data-controls
status: draft
nyquist_compliant: false
wave_0_complete: false
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
| 12-01-01 | 01 | 1 | DATA-01 | unit | `node --test dvhub/test/status-card.test.js` | Wave 0 | ⬜ pending |
| 12-01-02 | 01 | 1 | DATA-02 | unit | `node --test dvhub/test/status-card.test.js` | Wave 0 | ⬜ pending |
| 12-01-03 | 01 | 1 | DATA-03 | unit | `node --test dvhub/test/cost-card.test.js` | Wave 0 | ⬜ pending |
| 12-01-04 | 01 | 1 | DATA-04 | unit | `node --test dvhub/test/epex-card.test.js` | Wave 0 | ⬜ pending |
| 12-01-05 | 01 | 1 | DATA-05 | unit | `node --test dvhub/test/status-card.test.js` | Wave 0 | ⬜ pending |
| 12-01-06 | 01 | 1 | DATA-08 | unit | `node --test dvhub/test/status-card.test.js` | Wave 0 | ⬜ pending |
| 12-02-01 | 02 | 2 | DATA-06 | unit | `node --test dvhub/test/schedule-panel-active.test.js` | Wave 0 | ⬜ pending |
| 12-02-02 | 02 | 2 | DATA-07 | unit | `node --test dvhub/test/schedule-panel-active.test.js` | Wave 0 | ⬜ pending |
| 12-02-03 | 02 | 2 | CTRL-01 | unit | `node --test dvhub/test/control-panel-writes.test.js` | Wave 0 | ⬜ pending |
| 12-02-04 | 02 | 2 | CTRL-02 | unit | `node --test dvhub/test/control-panel-writes.test.js` | Wave 0 | ⬜ pending |
| 12-02-05 | 02 | 2 | CTRL-03 | unit | `node --test dvhub/test/control-panel-writes.test.js` | Wave 0 | ⬜ pending |
| 12-02-06 | 02 | 2 | CTRL-04 | unit | `node --test dvhub/test/schedule-panel-inline.test.js` | Wave 0 | ⬜ pending |
| 12-02-07 | 02 | 2 | CTRL-05 | unit | `node --test dvhub/test/schedule-panel-defaults.test.js` | Wave 0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `dvhub/test/status-card.test.js` — stubs for DATA-01, DATA-02, DATA-05, DATA-08
- [ ] `dvhub/test/cost-card.test.js` — stubs for DATA-03
- [ ] `dvhub/test/epex-card.test.js` — stubs for DATA-04
- [ ] `dvhub/test/schedule-panel-active.test.js` — stubs for DATA-06, DATA-07
- [ ] `dvhub/test/control-panel-writes.test.js` — stubs for CTRL-01, CTRL-02, CTRL-03
- [ ] `dvhub/test/schedule-panel-inline.test.js` — stubs for CTRL-04
- [ ] `dvhub/test/schedule-panel-defaults.test.js` — stubs for CTRL-05

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Min SOC slider blink animation | CTRL-01 | CSS animation timing | Adjust slider, observe orange blink, confirm green flash on success |
| Cost card color coding | DATA-03 | Visual color validation | Verify green for profit, red for cost in browser |
| Grid layout span-4 rendering | DATA-04 | CSS grid visual check | Confirm 3-column Row 2 renders correctly across viewport widths |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
