---
phase: 02
slug: guided-setup-rebuild
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test |
| **Config file** | none - direct `node --test` execution |
| **Quick run command** | `node --test dv-control-webapp/test/setup-wizard.test.js` |
| **Full suite command** | `node --test dv-control-webapp/test/setup-wizard.test.js dv-control-webapp/test/settings-shell.test.js` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `node --test dv-control-webapp/test/setup-wizard.test.js`
- **After every plan wave:** Run `node --test dv-control-webapp/test/setup-wizard.test.js dv-control-webapp/test/settings-shell.test.js`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | SET-01 | unit | `node --test dv-control-webapp/test/setup-wizard.test.js` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | SET-01, SET-02, SET-03 | unit | `node --test dv-control-webapp/test/setup-wizard.test.js` | ❌ W0 | ⬜ pending |
| 02-03-01 | 03 | 3 | SET-03, SET-04 | unit/integration-lite | `node --test dv-control-webapp/test/setup-wizard.test.js dv-control-webapp/test/settings-shell.test.js` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `dv-control-webapp/test/setup-wizard.test.js` - wizard state, validation, and review helper coverage
- [ ] cwd-independent test path loading for setup helpers - avoid the brittle path pattern called out in `02-RESEARCH.md`
- [ ] extracted pure helper surface in `dv-control-webapp/public/setup.js` or a shared helper module so setup logic is testable without DOM-only state

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Stepper flow feels sequential and readable for first-run setup | SET-01 | User guidance and copy quality are visual/interaction-heavy | Load `/setup.html` with `needsSetup` true, move through the wizard, and confirm each step shows a small focused field set with clear next/back actions |
| Review step explains transport-specific consequences before save | SET-04 | Restart/reconnect messaging and summary clarity need visual confirmation | Choose both Modbus and MQTT in separate passes, open the review step, and confirm it summarizes key values plus restart-sensitive consequences clearly |
| Narrow-width fallback remains usable | SET-01 | Responsive collapse cannot be judged well from unit tests alone | Resize to tablet/mobile widths and confirm the wizard keeps a readable single-column flow with accessible step navigation |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
