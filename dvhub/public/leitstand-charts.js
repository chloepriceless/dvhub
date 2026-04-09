(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const CHART_COLORS = {
    pvForecast: '#e3b341',
    pvActual: 'rgba(227, 179, 65, 0.5)',
    loadForecast: '#58a6ff',
    scheduleInternal: '#6366F1',
    scheduleEos: '#3fb950',
    scheduleSma: '#f2c94c',
    savingsPositive: '#3fb950',
    savingsNegative: '#ff7b72',
    sparkline: '#5a6a8a'
  };

  const REFRESH_MS = 30000;

  const CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(11, 15, 26, 0.95)',
        titleColor: '#e8eaf0',
        bodyColor: '#c8cdd8',
        borderColor: 'rgba(99, 102, 241, 0.3)',
        borderWidth: 1,
        padding: 8,
        cornerRadius: 6,
        titleFont: { family: 'Inter', size: 11 },
        bodyFont: { family: 'JetBrains Mono', size: 10 }
      }
    },
    scales: {
      x: {
        grid: { color: 'rgba(90, 106, 138, 0.15)' },
        ticks: { color: '#5a6a8a', font: { family: 'JetBrains Mono', size: 9 } }
      },
      y: {
        grid: { color: 'rgba(90, 106, 138, 0.15)' },
        ticks: { color: '#5a6a8a', font: { family: 'JetBrains Mono', size: 9 } }
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Chart instances (module scope — reuse on refresh, never recreate)
  // ---------------------------------------------------------------------------
  let pvForecastChart = null;
  let ganttChart = null;
  let refreshTimer = null;

  // ---------------------------------------------------------------------------
  // Data fetching helpers
  // ---------------------------------------------------------------------------
  function apiFetch(path, opts) {
    var common = window.DVhubCommon;
    if (common && typeof common.apiFetch === 'function') return common.apiFetch(path, opts);
    return fetch(path, opts);
  }
  async function fetchForecastData() {
    try {
      const res = await apiFetch('/api/forecast');
      if (!res.ok) return null;
      const data = await res.json();
      return data.ok ? data : null;
    } catch (e) {
      return null;
    }
  }

  async function fetchOptimizerData() {
    try {
      const res = await apiFetch('/api/optimizer/status');
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function fetchCostData() {
    try {
      const res = await apiFetch('/api/costs');
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. PV-Forecast Chart (D-06 type 1) — standalone chart
  // ---------------------------------------------------------------------------
  function renderPvForecastChart(forecastData) {
    const canvas = document.getElementById('pv-forecast-chart');
    const skeleton = document.getElementById('pv-forecast-skeleton');
    if (!canvas || typeof Chart === 'undefined') return;

    // Hide skeleton, show canvas
    if (skeleton) skeleton.style.display = 'none';
    canvas.style.display = '';

    // Extract PV forecast slots (VERIFIED: response.pv.slots)
    const pvSlots = forecastData?.pv?.slots || [];
    if (pvSlots.length === 0) {
      canvas.style.display = 'none';
      if (skeleton) {
        skeleton.style.display = '';
        skeleton.textContent = 'Keine PV-Prognosedaten verfügbar';
        skeleton.style.lineHeight = '200px';
        skeleton.style.textAlign = 'center';
        skeleton.style.color = '#5a6a8a';
        skeleton.style.fontSize = '0.85rem';
        skeleton.style.animation = 'none';
      }
      return;
    }

    const labels = pvSlots.map(function (s) {
      var d = new Date(s.start);
      return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    });
    const forecastKw = pvSlots.map(function (s) { return s.powerW / 1000; });

    const datasets = [
      {
        label: 'PV-Prognose',
        data: forecastKw,
        borderColor: CHART_COLORS.pvForecast,
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3
      }
    ];

    // Load forecast data (from pv.slots — actual data would come from history)
    // PV Actual: if load slots have actual data, overlay them
    var loadSlots = forecastData?.load?.slots || [];
    if (loadSlots.length > 0) {
      datasets.push({
        label: 'Last-Prognose',
        data: loadSlots.map(function (s) { return s.powerW / 1000; }),
        borderColor: CHART_COLORS.loadForecast,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        tension: 0.3
      });
    }

    var config = {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: JSON.parse(JSON.stringify(CHART_DEFAULTS))
    };
    config.options.scales.x.ticks = { maxTicksLimit: 12, maxRotation: 45, font: { size: 10 } };
    config.options.scales.y.title = { display: true, text: 'kW', color: '#5a6a8a', font: { size: 10 } };
    config.options.scales.y.beginAtZero = true;
    config.options.plugins.tooltip.callbacks = {
      label: function (ctx) {
        return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + ' kW';
      }
    };

    if (pvForecastChart) {
      pvForecastChart.data = config.data;
      pvForecastChart.options = config.options;
      pvForecastChart.update('none');
    } else {
      pvForecastChart = new Chart(canvas, config);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Gantt Timeline (D-06 type 2) — horizontal bar chart
  // ---------------------------------------------------------------------------
  function getSourceCategory(source) {
    if (!source) return { label: 'Intern', color: CHART_COLORS.scheduleInternal };
    var s = source.toLowerCase();
    if (s.indexOf('eos') !== -1) return { label: 'EOS', color: CHART_COLORS.scheduleEos };
    if (s.indexOf('sma') !== -1) return { label: 'SMA', color: CHART_COLORS.scheduleSma };
    return { label: 'Intern', color: CHART_COLORS.scheduleInternal };
  }

  function renderGanttChart(optimizerData) {
    var canvas = document.getElementById('gantt-chart');
    var skeleton = document.getElementById('gantt-skeleton');
    if (!canvas || typeof Chart === 'undefined') return;

    if (skeleton) skeleton.style.display = 'none';
    canvas.style.display = '';

    // VERIFIED: lastSchedule is the rules array directly, NOT nested under schedule.rules
    var rules = optimizerData?.lastSchedule;
    if (!Array.isArray(rules) || rules.length === 0) {
      canvas.style.display = 'none';
      if (skeleton) {
        skeleton.style.display = '';
        skeleton.textContent = 'Kein Optimizer-Schedule vorhanden';
        skeleton.style.lineHeight = '200px';
        skeleton.style.textAlign = 'center';
        skeleton.style.color = '#5a6a8a';
        skeleton.style.fontSize = '0.85rem';
        skeleton.style.animation = 'none';
      }
      return;
    }

    // Build Gantt-style horizontal bars grouped by source category
    var categories = ['Intern', 'EOS', 'SMA'];
    var barData = [];
    var barColors = [];
    var barLabels = [];

    rules.forEach(function (rule) {
      var cat = getSourceCategory(rule.source);
      var startMs = new Date(rule.start).getTime();
      var endMs = new Date(rule.end).getTime();
      barData.push({
        x: [startMs, endMs],
        y: cat.label,
        rule: rule
      });
      barColors.push(cat.color);
      barLabels.push(cat.label);
    });

    var config = {
      type: 'bar',
      data: {
        labels: categories,
        datasets: [{
          data: barData.map(function (b) { return [b.x[0], b.x[1]]; }),
          backgroundColor: barColors,
          borderRadius: 3,
          borderSkipped: false,
          barPercentage: 0.6
        }]
      },
      options: JSON.parse(JSON.stringify(CHART_DEFAULTS))
    };

    config.options.indexAxis = 'y';
    // Use linear scale with ms timestamps (no date adapter needed)
    var allMs = barData.flatMap(function (b) { return b.x; });
    var minMs = Math.min.apply(null, allMs) || Date.now();
    var maxMs = Math.max.apply(null, allMs) || (Date.now() + 86400000);
    config.options.scales.x = {
      type: 'linear',
      min: minMs,
      max: maxMs,
      grid: { color: 'rgba(90, 106, 138, 0.15)' },
      ticks: {
        color: '#5a6a8a',
        font: { family: 'JetBrains Mono', size: 9 },
        callback: function (val) { return new Date(val).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); },
        maxTicksLimit: 12
      }
    };
    config.options.scales.y = {
      type: 'category',
      labels: categories,
      grid: { display: false },
      ticks: { color: '#5a6a8a', font: { family: 'Inter', size: 10 } }
    };
    config.options.plugins.tooltip.callbacks = {
      label: function (ctx) {
        var bar = barData[ctx.dataIndex];
        if (!bar) return '';
        var startStr = new Date(bar.x[0]).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        var endStr = new Date(bar.x[1]).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        var powerW = bar.rule.gridSetpointW;
        return bar.rule.source + ': ' + startStr + '-' + endStr + ' (' + powerW + ' W)';
      }
    };

    if (ganttChart) {
      ganttChart.data = config.data;
      ganttChart.options = config.options;
      ganttChart.update('none');
    } else {
      ganttChart = new Chart(canvas, config);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. EPEX Overlay Toggle (D-06 type 3) — reuse existing price chart
  // ---------------------------------------------------------------------------
  function initOverlayToggle() {
    var toggle = document.getElementById('overlay-toggle');
    if (!toggle) return;

    toggle.addEventListener('change', function () {
      // Find the existing price chart instance via Chart.getChart
      var priceChart = Chart.getChart('priceChartCanvas');
      if (!priceChart) return;

      var hidden = !toggle.checked;
      priceChart.data.datasets.forEach(function (ds) {
        // Toggle forecast-related datasets (solar/PV and consumption/load lines)
        if (ds.label && (
          ds.label.toLowerCase().indexOf('solar') !== -1 ||
          ds.label.toLowerCase().indexOf('forecast') !== -1 ||
          ds.label.toLowerCase().indexOf('prognose') !== -1 ||
          ds.label.toLowerCase().indexOf('pv') !== -1 ||
          ds.label.toLowerCase().indexOf('consumption') !== -1 ||
          ds.label.toLowerCase().indexOf('load') !== -1 ||
          ds.label.toLowerCase().indexOf('last') !== -1
        )) {
          ds.hidden = hidden;
        }
      });
      priceChart.update('none');
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Savings Card (D-06 type 4) — HTML card, not canvas
  // ---------------------------------------------------------------------------
  function renderSavingsCard(costData) {
    var totalEl = document.getElementById('savings-total');
    var breakdownEl = document.getElementById('savings-breakdown');
    if (!totalEl || !breakdownEl) return;

    if (!costData) {
      totalEl.textContent = '--';
      totalEl.className = 'savings-value card-value';
      breakdownEl.innerHTML = '';
      return;
    }

    // VERIFIED: actual field names from /api/costs
    var netEur = costData.netEur || 0;
    var costEur = costData.costEur || 0;
    var revenueEur = costData.revenueEur || 0;

    var isPositive = netEur >= 0;
    var sign = isPositive ? '+' : '';
    totalEl.textContent = sign + netEur.toFixed(2) + ' EUR';
    totalEl.className = 'savings-value card-value ' + (isPositive ? 'positive' : 'negative');

    // Breakdown rows using metric-row pattern
    breakdownEl.innerHTML =
      '<div class="metric-row"><span>Bezugskosten</span><strong>' + costEur.toFixed(2) + ' EUR</strong></div>' +
      '<div class="metric-row"><span>Einspeiseertrag</span><strong>' + revenueEur.toFixed(2) + ' EUR</strong></div>' +
      '<div class="metric-row"><span>Gesamt</span><strong>' + sign + netEur.toFixed(2) + ' EUR</strong></div>';
  }

  // ---------------------------------------------------------------------------
  // 5. Badge updates (moved from Plan 07 to avoid modifying this file twice)
  // ---------------------------------------------------------------------------
  function setBadgeState(id, active) {
    var badge = document.getElementById(id);
    if (!badge) return;
    if (active) {
      badge.removeAttribute('hidden');
      var dot = badge.querySelector('.dot');
      if (dot) {
        dot.classList.remove('dot-danger');
        dot.classList.add('dot-ok');
      }
    } else {
      badge.setAttribute('hidden', '');
    }
  }

  async function updateBadges() {
    try {
      var res = await apiFetch('/api/integrations/status');
      if (!res.ok) return;
      var data = await res.json();
      setBadgeState('badge-mqtt', data.mqtt?.connected);
      setBadgeState('badge-tesla', data.tesla?.enabled && data.tesla?.state);
      setBadgeState('badge-ha', data.homeAssistant?.haDiscovery);
      setBadgeState('badge-loxone', data.loxone?.configured);
    } catch (e) {
      // /api/integrations/status not yet available — badges stay hidden
    }
  }

  // ---------------------------------------------------------------------------
  // Refresh orchestrator
  // ---------------------------------------------------------------------------
  async function refreshAllCharts() {
    var results = await Promise.allSettled([
      fetchForecastData(),
      fetchOptimizerData(),
      fetchCostData()
    ]);

    var forecastData = results[0].status === 'fulfilled' ? results[0].value : null;
    var optimizerData = results[1].status === 'fulfilled' ? results[1].value : null;
    var costData = results[2].status === 'fulfilled' ? results[2].value : null;

    renderPvForecastChart(forecastData);
    renderGanttChart(optimizerData);
    renderSavingsCard(costData);
    updateBadges();
  }

  // ---------------------------------------------------------------------------
  // Init on DOMContentLoaded
  // ---------------------------------------------------------------------------
  function init() {
    initOverlayToggle();
    refreshAllCharts();
    refreshTimer = setInterval(refreshAllCharts, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
