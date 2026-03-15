import { html } from 'htm/preact';
import { signal, useComputed } from '@preact/signals';
import {
  computeBarLayout,
  normalizeSelectionIndices,
  buildScheduleWindows,
  buildSelectionRange,
  computeImportOverlayPoints,
  resolveComparisonForSlot,
  buildRulesFromWindows,
} from './price-chart-compute.js';
import {
  collectScheduleRulesFromRowState,
  isSmallMarketAutomationRule,
  groupScheduleRulesForDashboard,
} from './schedule-compute.js';
import { apiFetch } from '../shared/use-api.js';

// Re-export for convenience
export { computeBarLayout };

/* ── Module-level signals (selection + tooltip state) ─────────────── */

const selectedIndices = signal(new Set());
const anchorIndex = signal(null);
const pointerDown = signal(false);
const didDrag = signal(false);
const hoveredIndex = signal(null);
const tooltipPos = signal({ x: 0, y: 0, visible: false });
const chartMsg = signal('');

/* ── Selection helpers ────────────────────────────────────────────── */

function isSelected(idx) { return selectedIndices.value.has(idx); }

function setSelection(dataLength, indices) {
  const normalized = normalizeSelectionIndices(dataLength, indices);
  selectedIndices.value = new Set(normalized);
}

function clearSelection() {
  selectedIndices.value = new Set();
  anchorIndex.value = null;
  pointerDown.value = false;
  didDrag.value = false;
}

/* ── Rule creation ────────────────────────────────────────────────── */

async function createRulesFromSelection(pricesArray, refreshTrigger) {
  const indices = [...selectedIndices.value].sort((a, b) => a - b);
  if (indices.length === 0) return;

  const windows = buildScheduleWindows(pricesArray, indices);
  if (windows.length === 0) return;

  try {
    // 1. GET existing rules and config (defaults come from here)
    const existingRes = await apiFetch('/api/schedule');
    const existingData = await existingRes.json();
    const existingRules = (existingData.rules || []).filter(r => !isSmallMarketAutomationRule(r));
    const existingGrouped = groupScheduleRulesForDashboard(existingRules);

    // 2. Build new rules from windows with defaults from schedule config
    const defaults = existingData.config || {};
    const newRules = buildRulesFromWindows(windows, defaults);

    // 3. Convert new rules to grouped row format for collectScheduleRulesFromRowState
    const newGrouped = newRules.map(r => ({
      start: r.start,
      end: r.end,
      grid: r.value,
      charge: null,
      gridEnabled: true,
      chargeEnabled: false,
      stopSocEnabled: false,
      gridVal: r.value,
      chargeVal: null,
      stopSocVal: null,
    }));

    // 4. Merge and POST
    const allGrouped = [
      ...existingGrouped.map(r => ({
        ...r,
        gridEnabled: r.grid != null,
        chargeEnabled: r.charge != null,
        stopSocEnabled: r.stopSocPct != null,
        gridVal: r.grid,
        chargeVal: r.charge,
        stopSocVal: r.stopSocPct,
      })),
      ...newGrouped,
    ];
    const flatRules = collectScheduleRulesFromRowState(allGrouped);
    const res = await apiFetch('/api/schedule/rules', {
      method: 'POST',
      body: JSON.stringify({ rules: flatRules }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // 5. Feedback + clear
    chartMsg.value = `${windows.length} Regel${windows.length > 1 ? 'n' : ''} erstellt`;
    setTimeout(() => { chartMsg.value = ''; }, 3000);
    clearSelection();

    // 6. Trigger schedule panel refresh
    if (refreshTrigger) refreshTrigger.value = (refreshTrigger.value || 0) + 1;
  } catch (err) {
    chartMsg.value = 'Fehler: ' + (err.message || 'Speichern fehlgeschlagen');
    setTimeout(() => { chartMsg.value = ''; }, 3000);
  }
}

/* ── Tooltip helpers ──────────────────────────────────────────────── */

function updateTooltip(event) {
  let x = event.clientX + 12;
  let y = event.clientY + 12;
  if (x + 280 > window.innerWidth) x = event.clientX - 292;
  if (y + 200 > window.innerHeight) y = event.clientY - 212;
  tooltipPos.value = { x, y, visible: true };
}

function hideTooltip() {
  tooltipPos.value = { ...tooltipPos.value, visible: false };
  hoveredIndex.value = null;
}

/* ── Formatting helpers ───────────────────────────────────────────── */

function fmtCt(v) {
  if (v == null || !Number.isFinite(v)) return '-';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}`;
}

function signClass(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return v >= 0 ? 'margin-positive' : 'margin-negative';
}

function bestSourceClass(bs) {
  if (!bs) return 'best-source-netz';
  const lower = bs.toLowerCase();
  if (lower === 'pv') return 'best-source-pv';
  if (lower === 'akku' || lower === 'battery') return 'best-source-akku';
  if (lower === 'gemischt' || lower === 'mixed') return 'best-source-gemischt';
  return 'best-source-netz';
}

/* ── Slot time helper ─────────────────────────────────────────────── */

function getCurrentSlotIndex(pricesArray) {
  if (!pricesArray || pricesArray.length === 0) return -1;
  const now = Date.now();
  for (let i = pricesArray.length - 1; i >= 0; i--) {
    const t = new Date(pricesArray[i].time).getTime();
    if (t <= now) return i;
  }
  return -1;
}

/* ── Constants ────────────────────────────────────────────────────── */

const CHART_W = 1000;
const CHART_H = 300;
const TIME_LABELS = ['0:00', '6:00', '12:00', '18:00', '24:00'];

/* ── Component ────────────────────────────────────────────────────── */

/**
 * Interactive EPEX 96-slot bar chart component.
 * @param {{ prices: Signal, userEnergyPricing: Signal, scheduleRefreshTrigger: Signal }} props
 */
export function PriceChart({ prices, userEnergyPricing, scheduleRefreshTrigger }) {
  const bars = useComputed(() => computeBarLayout(prices.value || [], CHART_W, CHART_H));
  const currentIdx = useComputed(() => getCurrentSlotIndex(prices.value));

  const maxPrice = useComputed(() => {
    const arr = prices.value || [];
    if (arr.length === 0) return 10;
    return Math.max(...arr.map(p => Math.abs(p.price)), 0.01);
  });

  const pricesArray = prices.value || [];
  const midY = CHART_H / 2;
  const maxAbs = maxPrice.value;

  // yScale: map ct value to SVG y coordinate (positive up from midline)
  const yScale = (ct) => midY - (ct / maxAbs) * midY;
  const zeroY = midY;

  // Build comparison lookup map
  const pricingData = userEnergyPricing?.value;
  const pricingConfigured = pricingData?.configured === true;
  const comparisonByTs = new Map();
  if (pricingData?.slots) {
    for (const slot of pricingData.slots) {
      comparisonByTs.set(Number(slot.ts), slot);
    }
  }

  // Import overlay polyline
  const importPoints = computeImportOverlayPoints(bars.value, comparisonByTs, yScale);
  const pointsStr = importPoints.map(p => `${p.x},${p.y}`).join(' ');

  // Margin summary display slot
  const hIdx = hoveredIndex.value;
  let displaySlot = null;
  if (hIdx != null && bars.value[hIdx]) {
    displaySlot = resolveComparisonForSlot(bars.value[hIdx]._ts, comparisonByTs);
  }
  if (!displaySlot && pricingData?.current) {
    displaySlot = pricingData.current;
  }

  // Selection callout data
  const selCount = selectedIndices.value.size;
  let windowSummary = '';
  if (selCount > 0) {
    const windows = buildScheduleWindows(pricesArray, [...selectedIndices.value].sort((a, b) => a - b));
    windowSummary = windows.map(w => `${w.start}-${w.end}`).join(' | ');
  }

  // Hovered bar data for tooltip
  const hoveredBar = hIdx != null ? bars.value[hIdx] : null;
  const hoveredComparison = hoveredBar ? resolveComparisonForSlot(hoveredBar._ts, comparisonByTs) : null;

  return html`
    <section class="panel span-12 reveal">
      <p class="card-title">EPEX Strompreise</p>

      ${''/* 1. Margin Summary (above SVG) */}
      ${pricingConfigured && displaySlot && html`
        <div class="chart-summary">
          <div class="chart-summary-line">
            <span class="chart-summary-label">Jetzt:</span>
            <span>Boerse ${fmtCt(displaySlot.spreadToImportCtKwh != null ? (displaySlot.importPriceCtKwh - displaySlot.spreadToImportCtKwh) : null)} ct</span>
            <span> | Bezug ${fmtCt(displaySlot.importPriceCtKwh)} ct</span>
          </div>
          <div class="chart-summary-line">
            <span>Spread ${fmtCt(displaySlot.spreadToImportCtKwh)} ct</span>
            <span> | PV ${fmtCt(displaySlot.pvMarginCtKwh)} ct</span>
            <span> | Akku ${fmtCt(displaySlot.batteryMarginCtKwh)} ct</span>
            <span> | Gemischt ${fmtCt(displaySlot.mixedMarginCtKwh)} ct</span>
            <span> | Beste Quelle: <strong class="${bestSourceClass(displaySlot.bestSource)}">${displaySlot.bestSource || '-'}</strong></span>
          </div>
        </div>
      `}

      ${''/* 2. SVG chart */}
      <svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="xMidYMid meet"
        style="width:100%;height:auto;user-select:none"
        onMouseUp=${() => { pointerDown.value = false; }}
        onMouseLeave=${() => { hideTooltip(); pointerDown.value = false; }}>

        <!-- Center axis -->
        <line x1="0" y1="${midY}" x2="${CHART_W}" y2="${midY}"
          stroke="var(--chart-axis)" stroke-width="1" opacity="0.5" />

        <!-- Zero baseline -->
        <line x1="0" x2="${CHART_W}" y1="${zeroY}" y2="${zeroY}"
          stroke="var(--chart-negative)" stroke-width="1.5" />

        <!-- Price scale labels -->
        <text x="4" y="18" fill="var(--chart-label)" font-size="10">${maxAbs.toFixed(1)} ct</text>
        <text x="4" y="${midY - 4}" fill="var(--chart-label)" font-size="10">0 ct</text>
        <text x="4" y="${CHART_H - 4}" fill="var(--chart-label)" font-size="10">-${maxAbs.toFixed(1)} ct</text>

        <!-- Bars -->
        ${bars.value.map((bar, i) => {
          const isNow = i === currentIdx.value;
          const fill = isNow
            ? (bar.y < midY ? 'var(--chart-positive-highlight)' : 'var(--chart-negative-highlight)')
            : bar.color;
          const selected = isSelected(i);
          const hovered = i === hoveredIndex.value;
          return html`
            <rect x=${bar.x} y=${bar.y} width=${bar.w} height=${bar.h}
              fill=${fill} rx="1"
              class="price-bar ${selected ? 'is-selected' : ''} ${hovered ? 'is-hovered' : ''}"
              onMouseDown=${(e) => {
                e.preventDefault();
                pointerDown.value = true;
                anchorIndex.value = i;
                didDrag.value = false;
                setSelection(pricesArray.length, [i]);
              }}
              onMouseEnter=${(e) => {
                hoveredIndex.value = i;
                if (pointerDown.value && anchorIndex.value != null) {
                  if (i !== anchorIndex.value) didDrag.value = true;
                  setSelection(pricesArray.length, buildSelectionRange(anchorIndex.value, i));
                }
                updateTooltip(e);
              }}
              onMouseMove=${(e) => { updateTooltip(e); }}
            >
              <title>${bar.label}</title>
            </rect>
          `;
        })}

        <!-- Import overlay polyline -->
        ${importPoints.length > 1 && html`
          <polyline fill="none" stroke="var(--chart-import)" stroke-width="2.5"
            stroke-dasharray="6 3" stroke-linejoin="round" stroke-linecap="round"
            points=${pointsStr} />
        `}

        <!-- Current time indicator -->
        ${currentIdx.value >= 0 && html`
          <line x1=${bars.value[currentIdx.value]?.x || 0} y1="0"
            x2=${bars.value[currentIdx.value]?.x || 0} y2="${CHART_H}"
            stroke="var(--chart-now)" stroke-width="2" stroke-dasharray="4 2" />
        `}

        <!-- Time labels -->
        ${TIME_LABELS.map((lbl, i) => html`
          <text x=${(i / (TIME_LABELS.length - 1)) * CHART_W} y="${CHART_H - 2}"
            fill="var(--chart-label)" font-size="10" text-anchor="middle">${lbl}</text>
        `)}
      </svg>

      ${''/* 3. Selection callout (below SVG) */}
      ${selCount > 0 && html`
        <div class="chart-selection-callout is-visible">
          <div class="chart-selection-copy">
            <strong>${selCount} Balken markiert</strong>
            <span>${windowSummary}</span>
          </div>
          <button class="btn btn-primary"
            onClick=${() => createRulesFromSelection(pricesArray, scheduleRefreshTrigger)}>Schedule erstellen</button>
        </div>
      `}

      ${''/* 4. Tooltip (position: fixed) */}
      ${tooltipPos.value.visible && hoveredBar && html`
        <div class="chart-tooltip" style="left:${tooltipPos.value.x}px;top:${tooltipPos.value.y}px">
          <div class="chart-tooltip-row">
            <span class="chart-tooltip-label">Zeitslot</span>
            <span>${hoveredBar.label.split(':')[0]}:${(hoveredBar.label.split(':')[1] || '').split(' ')[0]}</span>
          </div>
          <div class="chart-tooltip-row">
            <span class="chart-tooltip-label">Boerse</span>
            <span>${pricesArray[hIdx] ? pricesArray[hIdx].price.toFixed(2) : '-'} ct</span>
          </div>
          ${hoveredComparison && html`
            <div class="chart-tooltip-row">
              <span class="chart-tooltip-label">Bezug</span>
              <span>${fmtCt(hoveredComparison.importPriceCtKwh)} ct</span>
            </div>
            <div class="chart-tooltip-row">
              <span class="chart-tooltip-label">PV</span>
              <span class="${signClass(hoveredComparison.pvMarginCtKwh)}">${fmtCt(hoveredComparison.pvMarginCtKwh)} ct</span>
            </div>
            <div class="chart-tooltip-row">
              <span class="chart-tooltip-label">Akku</span>
              <span class="${signClass(hoveredComparison.batteryMarginCtKwh)}">${fmtCt(hoveredComparison.batteryMarginCtKwh)} ct</span>
            </div>
            <div class="chart-tooltip-row">
              <span class="chart-tooltip-label">Gemischt</span>
              <span class="${signClass(hoveredComparison.mixedMarginCtKwh)}">${fmtCt(hoveredComparison.mixedMarginCtKwh)} ct</span>
            </div>
          `}
        </div>
      `}

      ${''/* 5. Feedback message */}
      ${chartMsg.value && html`
        <p class="meta" style="color:var(--dvhub-green)">${chartMsg.value}</p>
      `}
    </section>
  `;
}
