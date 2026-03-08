---
phase: 01
slug: settings-shell-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` for extracted helpers + manual browser smoke |
| **Config file** | none |
| **Quick run command** | `node --test dv-control-webapp/test/settings-shell.test.js` |
| **Full suite command** | `node --test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `node --test dv-control-webapp/test/settings-shell.test.js`
- **After every plan wave:** Run `node --test`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | NAV-01 | unit | `node --test dv-control-webapp/test/settings-shell.test.js` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | NAV-02 | unit | `node --test dv-control-webapp/test/settings-shell.test.js` | ❌ W0 | ⬜ pending |
| 01-02-01 | 02 | 1 | NAV-03 | unit | `node --test dv-control-webapp/test/settings-shell.test.js` | ❌ W0 | ⬜ pending |
| 01-02-02 | 02 | 1 | UX-02 | unit | `node --test dv-control-webapp/test/settings-shell.test.js` | ❌ W0 | ⬜ pending |
| 01-03-01 | 03 | 2 | UX-01 | manual + smoke | `node --test` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `dv-control-webapp/test/settings-shell.test.js` — helper coverage for section grouping and active-section state
- [ ] extract testable helper functions from `public/settings.js` into reusable units
- [ ] define one manual smoke checklist for desktop/mobile layout verification

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Sidebar and save bar feel stable during long-page scrolling | NAV-01, UX-01 | Sticky behavior and visual overlap are layout-sensitive | Open Settings, scroll through a long section on desktop and confirm sidebar plus action bar remain usable without covering key fields |
| Overview-first entry feels clearer than the current direct-form start | NAV-02, UX-02 | Requires human judgment about orientation and readability | Load Settings with a clean session and confirm the overview helps users pick the right destination before editing fields |
| Two-column layout stays readable on desktop and collapses sensibly on smaller widths | UX-01 | Responsive density is hard to validate meaningfully with a pure unit test | Check desktop and narrow-width browser sizes and confirm field alignment stays readable and unsurprising |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
