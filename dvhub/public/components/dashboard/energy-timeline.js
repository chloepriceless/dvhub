import { html } from 'htm/preact';
import { useComputed } from '@preact/signals';
import { computeTimelineLayout } from './energy-timeline-compute.js';

// Re-export for convenience
export { computeTimelineLayout };

const CHART_W = 1000;
const CHART_H = 350;

/**
 * Energy timeline: stacked energy bars (PV, grid, battery) with price overlay line.
 * @param {{ energyData: import('@preact/signals').Signal, prices: import('@preact/signals').Signal }} props
 */
export function EnergyTimeline({ energyData, prices }) {
  const layout = useComputed(() =>
    computeTimelineLayout(energyData.value || [], prices.value || [], CHART_W, CHART_H)
  );

  const gap = 1;
  const barW = useComputed(() => {
    const len = (energyData.value || []).length;
    return len > 0 ? (CHART_W / len) - gap : 10;
  });

  return html`
    <section class="panel span-12 reveal">
      <p class="card-title">Energie-Verlauf</p>
      <svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto">
        <!-- Energy scale label (left Y-axis) -->
        <text x="4" y="16" fill="var(--chart-label)" font-size="10">kWh</text>

        <!-- Price scale label (right Y-axis) -->
        <text x="${CHART_W - 4}" y="16" fill="var(--dvhub-orange)" font-size="10" text-anchor="end">ct/kWh</text>

        <!-- Stacked energy bars -->
        ${layout.value.bars.map((bar) =>
          bar.segments.map((seg) => html`
            <rect x=${bar.x} y=${seg.y} width=${barW.value} height=${seg.h}
              fill=${seg.color} opacity="0.8" rx="1" />
          `)
        )}

        <!-- Price overlay polyline -->
        ${layout.value.priceLine.length > 1 && html`
          <polyline
            points=${layout.value.priceLine.map(p => `${p.x},${p.y}`).join(' ')}
            fill="none" stroke="var(--dvhub-orange)" stroke-width="2" opacity="0.9" />
        `}

        <!-- Time labels -->
        ${['0:00', '6:00', '12:00', '18:00', '24:00'].map((lbl, i) => html`
          <text x=${(i / 4) * CHART_W} y="${CHART_H - 4}"
            fill="var(--chart-label)" font-size="10" text-anchor="middle">${lbl}</text>
        `)}

        <!-- Legend -->
        <rect x="60" y="4" width="10" height="10" fill="#FFD600" rx="2" />
        <text x="74" y="13" fill="var(--chart-label)" font-size="9">PV</text>
        <rect x="100" y="4" width="10" height="10" fill="var(--dvhub-blue)" rx="2" />
        <text x="114" y="13" fill="var(--chart-label)" font-size="9">Netz</text>
        <rect x="150" y="4" width="10" height="10" fill="var(--dvhub-green)" rx="2" />
        <text x="164" y="13" fill="var(--chart-label)" font-size="9">Batterie</text>
      </svg>
    </section>
  `;
}
