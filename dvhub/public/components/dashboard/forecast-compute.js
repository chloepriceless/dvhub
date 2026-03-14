/**
 * Pure function: compute SVG path coordinates for forecast chart.
 * Extracted for Node.js testability without Preact import map.
 *
 * @param {Array<{ time: string, power: number }>} pvData
 * @param {Array<{ time: string, power: number }>} loadData
 * @param {number} width
 * @param {number} height
 * @returns {{ pvPath: Array<{ x: number, y: number }>, loadPath: Array<{ x: number, y: number }> }}
 */
export function computeForecastPaths(pvData, loadData, width, height) {
  const chartTop = 20;
  const chartBottom = height - 30;
  const chartH = chartBottom - chartTop;

  function toCoords(data) {
    if (!data || data.length === 0) return [];
    const maxVal = Math.max(...data.map(d => d.power || 0), 0.01);
    return data.map((d, i) => ({
      x: (i / Math.max(data.length - 1, 1)) * width,
      y: chartBottom - (((d.power || 0) / maxVal) * chartH),
    }));
  }

  return {
    pvPath: toCoords(pvData),
    loadPath: toCoords(loadData),
  };
}
