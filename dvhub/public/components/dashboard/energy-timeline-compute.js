/**
 * Pure function: compute timeline layout for energy bars + price overlay.
 * Extracted for Node.js testability without Preact import map.
 *
 * @param {Array<{ time: string, pvWh: number, gridImportWh: number, batteryDischargeWh: number }>} energyData
 * @param {Array<{ time: string, price: number }>} pricesData
 * @param {number} width
 * @param {number} height
 * @returns {{ bars: Array<{ x: number, segments: Array<{ y: number, h: number, color: string }> }>, priceLine: Array<{ x: number, y: number }> }}
 */
export function computeTimelineLayout(energyData, pricesData, width, height) {
  if (!energyData || energyData.length === 0) {
    return { bars: [], priceLine: [] };
  }

  const gap = 1;
  const barW = (width / energyData.length) - gap;
  const chartBottom = height - 30; // leave room for x-axis labels
  const chartTop = 20;
  const chartH = chartBottom - chartTop;

  // Find max total energy for scaling
  const maxEnergy = Math.max(
    ...energyData.map(e => (e.pvWh || 0) + (e.gridImportWh || 0) + (e.batteryDischargeWh || 0)),
    0.01
  );

  const bars = energyData.map((entry, i) => {
    const pv = entry.pvWh || 0;
    const gridImp = entry.gridImportWh || 0;
    const batDis = entry.batteryDischargeWh || 0;
    const total = pv + gridImp + batDis;

    const pvH = (pv / maxEnergy) * chartH;
    const gridH = (gridImp / maxEnergy) * chartH;
    const batH = (batDis / maxEnergy) * chartH;

    let y = chartBottom;
    const segments = [];

    // Stack: PV (bottom), grid import (middle), battery discharge (top)
    if (pv > 0) {
      y -= pvH;
      segments.push({ y, h: pvH, color: '#FFD600' }); // yellow - PV
    }
    if (gridImp > 0) {
      y -= gridH;
      segments.push({ y, h: gridH, color: 'var(--dvhub-blue)' }); // blue - grid
    }
    if (batDis > 0) {
      y -= batH;
      segments.push({ y, h: batH, color: 'var(--dvhub-green)' }); // green - battery
    }

    return { x: i * (barW + gap), segments };
  });

  // Price overlay line
  let priceLine = [];
  if (pricesData && pricesData.length > 0) {
    const maxPrice = Math.max(...pricesData.map(p => Math.abs(p.price)), 0.01);
    priceLine = pricesData.map((entry, i) => {
      const x = (i / Math.max(pricesData.length - 1, 1)) * width;
      // Higher price = lower Y (inverted)
      const y = chartBottom - ((entry.price / maxPrice) * chartH);
      return { x, y };
    });
  }

  return { bars, priceLine };
}
