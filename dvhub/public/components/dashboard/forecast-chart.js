import { html } from 'htm/preact';
import { useComputed } from '@preact/signals';
import { computeForecastPaths } from './forecast-compute.js';

// Re-export for convenience
export { computeForecastPaths };

const CHART_W = 1000;
const CHART_H = 250;

function pointsToSvgPath(points) {
  if (!points || points.length === 0) return '';
  return points.map(p => `${p.x},${p.y}`).join(' ');
}

function pointsToAreaPath(points, baseline) {
  if (!points || points.length < 2) return '';
  const first = points[0];
  const last = points[points.length - 1];
  let d = `M ${first.x},${baseline} `;
  d += points.map(p => `L ${p.x},${p.y}`).join(' ');
  d += ` L ${last.x},${baseline} Z`;
  return d;
}

/**
 * Forecast chart: PV and load prediction areas.
 * @param {{ forecast: import('@preact/signals').Signal }} props
 */
export function ForecastChart({ forecast }) {
  const paths = useComputed(() => {
    const f = forecast.value || {};
    return computeForecastPaths(f.pv || [], f.load || [], CHART_W, CHART_H);
  });

  const hasData = useComputed(() => {
    const f = forecast.value || {};
    return (f.pv && f.pv.length > 0) || (f.load && f.load.length > 0);
  });

  const baseline = CHART_H - 30;

  return html`
    <section class="panel span-6 reveal">
      <p class="card-title">Prognose</p>
      ${!hasData.value && html`
        <p class="meta" style="text-align:center;padding:2em 0;color:var(--text-muted)">Keine Prognose verfuegbar</p>
      `}
      ${hasData.value && html`
        <svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto">
          <!-- Y-axis label -->
          <text x="4" y="16" fill="var(--chart-label)" font-size="10">kW</text>

          <!-- PV forecast area -->
          ${paths.value.pvPath.length > 1 && html`
            <path d=${pointsToAreaPath(paths.value.pvPath, baseline)}
              fill="#FFD600" opacity="0.3" />
            <polyline points=${pointsToSvgPath(paths.value.pvPath)}
              fill="none" stroke="#FFD600" stroke-width="2" />
          `}

          <!-- Load forecast area -->
          ${paths.value.loadPath.length > 1 && html`
            <path d=${pointsToAreaPath(paths.value.loadPath, baseline)}
              fill="var(--dvhub-blue)" opacity="0.3" />
            <polyline points=${pointsToSvgPath(paths.value.loadPath)}
              fill="none" stroke="var(--dvhub-blue)" stroke-width="2" />
          `}

          <!-- X-axis labels (hours) -->
          ${[0, 12, 24, 36, 48].map((h) => html`
            <text x=${(h / 48) * CHART_W} y="${CHART_H - 4}"
              fill="var(--chart-label)" font-size="10" text-anchor="middle">${h}h</text>
          `)}

          <!-- Legend -->
          <rect x="${CHART_W - 240}" y="4" width="10" height="10" fill="#FFD600" rx="2" />
          <text x="${CHART_W - 226}" y="13" fill="var(--chart-label)" font-size="9">PV Prognose</text>
          <rect x="${CHART_W - 140}" y="4" width="10" height="10" fill="var(--dvhub-blue)" rx="2" />
          <text x="${CHART_W - 126}" y="13" fill="var(--chart-label)" font-size="9">Last Prognose</text>
        </svg>
      `}
    </section>
  `;
}
