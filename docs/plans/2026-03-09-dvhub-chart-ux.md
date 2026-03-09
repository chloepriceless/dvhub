# DVhub Chart UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Den DVhub-Leitstand und die History-Ansicht so umbauen, dass Zeitplan, Chart-Interaktion, Achsen und responsive Vergleichsbalken konsistent und direkt vergleichbar sind.

**Architecture:** Das Dashboard-HTML wird neu angeordnet, damit der Schedule-Block direkt auf den Boersenchart folgt. Die History-Seite bekommt gemeinsame Hilfsfunktionen fuer SVG-Achsen, Pointer-Tracking und Inspector-Rendering, damit Linien- und Balkencharts dieselbe Interaktionslogik nutzen. Das CSS ersetzt umbrechende `auto-fit`-Bar-Layouts durch bewusst verdichtete Vergleichsraster mit breakpoint-spezifischer Kompression.

**Tech Stack:** Node.js, `node:test`, Vanilla JS, HTML, CSS

---

### Task 1: Dashboard-Reihenfolge testgetrieben absichern

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/dashboard-page.test.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/public/index.html`

**Step 1: Write the failing test**

```js
test('renders the schedule panel directly after the price engine panel', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const priceIndex = html.indexOf('Preis-Engine');
  const scheduleIndex = html.indexOf('Zeitplan');
  const controlCenterIndex = html.indexOf('Manuelle Eingriffe');

  assert.ok(priceIndex >= 0);
  assert.ok(scheduleIndex > priceIndex);
  assert.ok(controlCenterIndex > scheduleIndex);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/dashboard-page.test.js`
Expected: FAIL because `Zeitplan` is still inside the control center section.

**Step 3: Write minimal implementation**

- Move the schedule markup into its own panel directly below the price chart section.
- Keep existing IDs such as `scheduleRowsDash`, `loadScheduleBtn`, and `saveScheduleBtn` unchanged.

**Step 4: Run test to verify it passes**

Run: `node --test test/dashboard-page.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add dvhub/test/dashboard-page.test.js dvhub/public/index.html
git commit -m "feat: move schedule below price chart"
```

### Task 2: History-Achsen per Test vorgeben

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/history-page.test.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/public/history.js`

**Step 1: Write the failing test**

```js
test('renders x and y axes for history line charts', () => {
  renderSummary(sampleDaySummary());

  const energyChart = document.getElementById('historyEnergyChart');
  assert.match(energyChart.innerHTML, /history-axis-x/);
  assert.match(energyChart.innerHTML, /history-axis-y/);
  assert.match(energyChart.innerHTML, /history-x-axis-label/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/history-page.test.js`
Expected: FAIL because the current chart markup only renders partial Y-grid labels and no shared X-axis structure.

**Step 3: Write minimal implementation**

- Add shared axis helpers in `history.js`.
- Render X-axis labels and Y-axis labels for all line and bar charts.

**Step 4: Run test to verify it passes**

Run: `node --test test/history-page.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add dvhub/test/history-page.test.js dvhub/public/history.js
git commit -m "feat: add axes to history charts"
```

### Task 3: Einheitliche Pointer-Interaktion fuer alle History-Charts

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/history-page.test.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/public/history.js`

**Step 1: Write the failing test**

```js
test('updates the inspector when hovering a non-day comparison chart', () => {
  renderSummary(sampleWeekSummary());

  const financialHover = document.querySelector('#historyFinancialChart .history-chart-hover-surface');
  assert.ok(financialHover);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/history-page.test.js`
Expected: FAIL because hover surfaces and cursor state exist only for the detailed day chart.

**Step 3: Write minimal implementation**

- Reuse one pointer binding path for day, week, month, and year charts.
- Preserve inspector output for mouse and touch/pointer input.

**Step 4: Run test to verify it passes**

Run: `node --test test/history-page.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add dvhub/test/history-page.test.js dvhub/public/history.js
git commit -m "feat: unify history chart pointer interaction"
```

### Task 4: Responsive Vergleichsbalken ohne Umbruch

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/history-page.test.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/public/history.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/public/styles.css`

**Step 1: Write the failing test**

```js
test('renders comparison bars in a compressed fixed-column layout', () => {
  renderSummary(sampleWeekSummary());

  const markup = document.getElementById('historyFinancialChart').innerHTML;
  assert.match(markup, /history-bars-compressed/);
  assert.match(markup, /history-bar-track/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/history-page.test.js`
Expected: FAIL because the current bar layout depends on `auto-fit` and card-style blocks that can visually drop below each other.

**Step 3: Write minimal implementation**

- Replace `auto-fit` grids with explicit compressed comparison containers.
- Reduce bar width and spacing across breakpoints.
- Add fixed X-axis labels beneath each comparison group.

**Step 4: Run test to verify it passes**

Run: `node --test test/history-page.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add dvhub/test/history-page.test.js dvhub/public/history.js dvhub/public/styles.css
git commit -m "feat: compress comparison bars for small screens"
```

### Task 5: Dashboard- und History-Regressionen pruefen

**Files:**
- Modify: keine weiteren Dateien geplant

**Step 1: Run targeted verification**

Run: `node --test test/dashboard-page.test.js test/history-page.test.js`
Expected: PASS

**Step 2: Run full relevant suite**

Run: `npm test`
Expected: PASS or clearly isolated unrelated failures

**Step 3: Review output**

- Confirm that schedule creation from chart selection still works.
- Confirm that history charts still render empty states without throwing.
- Confirm that mobile breakpoints do not reintroduce wrapping comparison bars.
