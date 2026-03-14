import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { scaleLinear } from '../shared/svg-utils.js';

const CHART_W = 1000;
const CHART_H = 400;
const PAD = { top: 40, right: 20, bottom: 40, left: 60 };
const PLOT_W = CHART_W - PAD.left - PAD.right;
const PLOT_H = CHART_H - PAD.top - PAD.bottom;

const SERIES = [
  { key: 'pvPower', label: 'PV', color: 'var(--dvhub-lime, #facc15)' },
  { key: 'gridPower', label: 'Netz', color: 'var(--dvhub-blue, #60a5fa)' },
  { key: 'batteryPower', label: 'Batterie', color: 'var(--dvhub-green, #4ade80)' },
  { key: 'loadPower', label: 'Last', color: '#e2e8f0' },
];

const hoverIndex = signal(-1);

function buildPath(points) {
  if (!points.length) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
}

function timeLabel(ts, resolution) {
  const d = new Date(ts);
  if (resolution === '1d' || resolution === '1 Tag') {
    return `${d.getDate()}.${d.getMonth() + 1}`;
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Multi-line SVG chart for energy history data.
 * @param {object} props
 * @param {Array} props.data - Array of { ts, pvPower, gridPower, batteryPower, loadPower }
 * @param {string} props.dateRange - Label for current date range
 * @param {string} props.resolution - Resolution label for x-axis formatting
 */
export function HistoryChart({ data, dateRange, resolution }) {
  if (!data || data.length === 0) {
    return html`
      <div class="panel" style="padding: 2rem; text-align: center;">
        <p class="meta">Keine Daten fuer diesen Zeitraum</p>
      </div>
    `;
  }

  // Compute value range across all series
  let minVal = Infinity, maxVal = -Infinity;
  for (const d of data) {
    for (const s of SERIES) {
      const v = Number(d[s.key] || 0);
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
  }
  if (minVal === maxVal) { minVal -= 1; maxVal += 1; }

  const xScale = scaleLinear([0, data.length - 1], [PAD.left, PAD.left + PLOT_W]);
  const yScale = scaleLinear([minVal, maxVal], [PAD.top + PLOT_H, PAD.top]);

  // Y-axis grid lines (5 lines)
  const yTicks = [];
  for (let i = 0; i <= 4; i++) {
    const val = minVal + (maxVal - minVal) * (i / 4);
    yTicks.push({ val, y: yScale(val) });
  }

  // X-axis labels (max 10)
  const step = Math.max(1, Math.floor(data.length / 10));
  const xTicks = [];
  for (let i = 0; i < data.length; i += step) {
    xTicks.push({ i, x: xScale(i), label: timeLabel(data[i].ts, resolution) });
  }

  // Build polylines
  const paths = SERIES.map(s => ({
    ...s,
    points: data.map((d, i) => ({ x: xScale(i), y: yScale(Number(d[s.key] || 0)) })),
  }));

  const hovIdx = hoverIndex.value;
  const hovData = hovIdx >= 0 && hovIdx < data.length ? data[hovIdx] : null;

  return html`
    <div style="position: relative;">
      <!-- Legend -->
      <div style="display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.5rem;">
        ${SERIES.map(s => html`
          <span style="display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.8rem;">
            <span style="width: 12px; height: 3px; background: ${s.color}; display: inline-block;"></span>
            ${s.label}
          </span>
        `)}
      </div>

      <svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: auto;"
        onMouseMove=${(e) => {
          const svg = e.currentTarget;
          const rect = svg.getBoundingClientRect();
          const mx = ((e.clientX - rect.left) / rect.width) * CHART_W;
          const idx = Math.round(((mx - PAD.left) / PLOT_W) * (data.length - 1));
          hoverIndex.value = Math.max(0, Math.min(data.length - 1, idx));
        }}
        onMouseLeave=${() => { hoverIndex.value = -1; }}
      >
        <!-- Y grid lines -->
        ${yTicks.map(t => html`
          <line x1=${PAD.left} x2=${PAD.left + PLOT_W} y1=${t.y} y2=${t.y} stroke="#333" stroke-width="0.5" />
          <text x=${PAD.left - 8} y=${t.y + 4} text-anchor="end" fill="#888" font-size="11">
            ${Math.abs(t.val) >= 1000 ? `${(t.val / 1000).toFixed(1)}kW` : `${Math.round(t.val)}W`}
          </text>
        `)}

        <!-- X axis labels -->
        ${xTicks.map(t => html`
          <text x=${t.x} y=${CHART_H - 8} text-anchor="middle" fill="#888" font-size="11">${t.label}</text>
        `)}

        <!-- Data lines -->
        ${paths.map(p => html`
          <path d=${buildPath(p.points)} fill="none" stroke=${p.color} stroke-width="2" />
        `)}

        <!-- Hover line -->
        ${hovIdx >= 0 && html`
          <line x1=${xScale(hovIdx)} x2=${xScale(hovIdx)} y1=${PAD.top} y2=${PAD.top + PLOT_H} stroke="#fff" stroke-width="1" opacity="0.5" />
        `}
      </svg>

      <!-- Tooltip -->
      ${hovData && html`
        <div style="position: absolute; top: 0.5rem; right: 0.5rem; background: rgba(0,0,0,0.85); padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.8rem; pointer-events: none;">
          <div style="margin-bottom: 0.25rem; color: #aaa;">${timeLabel(hovData.ts, resolution)}</div>
          ${SERIES.map(s => html`
            <div style="color: ${s.color};">${s.label}: ${Math.round(Number(hovData[s.key] || 0))} W</div>
          `)}
        </div>
      `}
    </div>
  `;
}
