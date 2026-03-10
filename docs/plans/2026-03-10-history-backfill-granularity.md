# History Backfill Granularity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `Verbrauch` KPI card to the history summary, keep all KPI cards in one desktop row, and make VRM full backfill testable across `days`, `hours`, and `15mins` with day-aligned windows.

**Architecture:** Keep the UI change minimal by extending the existing KPI bindings and tightening the desktop grid for seven cards. Fix the full-backfill behavior at the source by aligning full-backfill windows to UTC day boundaries and allowing the configured interval to pass through to VRM fetches instead of forcing `15mins`.

**Tech Stack:** Node.js, vanilla JS, SQLite, node:test, static HTML/CSS

---

### Task 1: Extend History KPI UI

**Files:**
- Modify: `dvhub/public/history.html`
- Modify: `dvhub/public/history.js`
- Modify: `dvhub/public/styles.css`
- Test: `dvhub/test/history-page.test.js`

**Step 1: Write the failing test**
- Assert that `history.html` contains a `historyKpiLoad` mount.
- Assert that `history.js` renders `summary.kpis.loadKwh` into that mount.
- Assert that the desktop KPI grid uses 7 columns and tighter card sizing.

**Step 2: Run test to verify it fails**

Run: `node --test test/history-page.test.js`
Expected: FAIL because `historyKpiLoad` and the 7-card layout do not exist yet.

**Step 3: Write minimal implementation**
- Add the new `Verbrauch` KPI card in `history.html`.
- Bind `summary.kpis.loadKwh` in `history.js`.
- Tighten the desktop KPI grid in `styles.css` so 7 cards fit on one row while preserving the existing mobile collapse.

**Step 4: Run test to verify it passes**

Run: `node --test test/history-page.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add dvhub/public/history.html dvhub/public/history.js dvhub/public/styles.css dvhub/test/history-page.test.js
git commit -m "feat: add history load kpi"
```

### Task 2: Fix Full Backfill Window Boundaries

**Files:**
- Modify: `dvhub/history-import.js`
- Test: `dvhub/test/history-import.test.js`

**Step 1: Write the failing test**
- Add a full-backfill test that starts from a non-midnight `now` and expects requests to be aligned to whole UTC-day windows.

**Step 2: Run test to verify it fails**

Run: `node --test test/history-import.test.js`
Expected: FAIL because the current full backfill uses `now`-anchored windows.

**Step 3: Write minimal implementation**
- Align the full-backfill `requestedTo` and per-window boundaries to UTC day starts.
- Preserve the existing stop condition and chunk walk behavior.

**Step 4: Run test to verify it passes**

Run: `node --test test/history-import.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add dvhub/history-import.js dvhub/test/history-import.test.js
git commit -m "fix: align full backfill windows to day boundaries"
```

### Task 3: Allow Full Backfill Interval Comparison

**Files:**
- Modify: `dvhub/history-import.js`
- Test: `dvhub/test/history-import.test.js`

**Step 1: Write the failing test**
- Add a test that runs full backfill with `interval: 'days'`, `interval: 'hours'`, and `interval: '15mins'` and verifies the VRM fetch requests keep the requested interval instead of being forced to `15mins`.

**Step 2: Run test to verify it fails**

Run: `node --test test/history-import.test.js`
Expected: FAIL because the current fetch path normalizes everything to `15mins`.

**Step 3: Write minimal implementation**
- Accept only supported VRM intervals.
- Pass the chosen interval through `fetchConfiguredVrmRows()` and into the full/gap backfill fetches.

**Step 4: Run test to verify it passes**

Run: `node --test test/history-import.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add dvhub/history-import.js dvhub/test/history-import.test.js
git commit -m "feat: support full backfill interval comparison"
```

### Task 4: Verify Locally and Compare Live

**Files:**
- No code changes required unless verification finds gaps.

**Step 1: Run targeted tests**

Run:
- `node --test test/history-page.test.js`
- `node --test test/history-import.test.js`

Expected: PASS

**Step 2: Run full suite**

Run: `npm test`
Expected: PASS

**Step 3: Compare live backfill intervals**

Run live imports for `2026-03-08` with:
- `interval: 'days'`
- `interval: 'hours'`
- `interval: '15mins'`

For each run, capture:
- `pvKwh`
- `exportKwh`
- `loadKwh`
- `sourceSummary`
- `unresolved`

**Step 4: Choose the production default**
- Prefer the interval that best matches VRM for strong PV days while keeping the import stable.

**Step 5: Commit if verification requires a final tweak**

```bash
git add <changed-files>
git commit -m "fix: finalize history backfill comparison flow"
```
