(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  // Brand-aligned palette (DVhub design system, Phase 8 Plan 10)
  const CHART_COLORS = {
    pvForecast: '#e3b341',
    pvActual: 'rgba(227, 179, 65, 0.5)',
    loadForecast: '#58a6ff',
    scheduleInternal: '#0077FF', // brand blue (was #6366F1 indigo)
    scheduleEos: '#39E06F',      // brand green (was #3fb950 GitHub green)
    scheduleSma: '#f2c94c',
    savingsPositive: '#39E06F',  // brand green (was #3fb950)
    savingsNegative: '#ff7b72',
    sparkline: '#5a6a8a'
  };

  const REFRESH_MS = 30000;

  const CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false
    },
    hover: {
      mode: 'index',
      intersect: false
    },
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
      },
      zoom: {
        pan: {
          enabled: true,
          mode: 'x'
        },
        zoom: {
          wheel: { enabled: true, modifierKey: 'ctrl' },
          pinch: { enabled: true },
          mode: 'x',
          onZoomComplete: function (ctx) {
            // Show reset hint on first zoom
            var card = ctx.chart.canvas.closest('.chart-span-card, .metric-card');
            if (card && !card.querySelector('.zoom-reset-hint')) {
              var hint = document.createElement('div');
              hint.className = 'zoom-reset-hint';
              hint.textContent = 'Ctrl+Scroll = Zoom, Doppelklick = Reset';
              hint.style.cssText = 'position:absolute;top:4px;right:8px;font-size:9px;color:#5a6a8a;opacity:0.7;pointer-events:none;';
              card.style.position = 'relative';
              card.appendChild(hint);
              setTimeout(function () { hint.remove(); }, 3000);
            }
          }
        }
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
  // Zoom reset: double-click on canvas resets zoom/pan to original view
  // ---------------------------------------------------------------------------
  function enableZoomReset(chart) {
    if (!chart || !chart.canvas) return;
    if (chart.canvas._zoomResetBound) return; // don't double-bind
    chart.canvas.addEventListener('dblclick', function () { chart.resetZoom(); });
    chart.canvas._zoomResetBound = true;
  }

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
    // The Gantt chart used to read optimizer.lastSchedule, but that path is
    // empty when the optimizer is disabled (the typical case for SMA-only
    // setups) and even when active the slot shape ({ts, endTs, powerW})
    // doesn't match what the renderer expects (rule.start/end/source). Pull
    // the live schedule rules directly — they cover all sources (manual,
    // small-market-automation, forecast_optimizer) and have the right shape.
    try {
      const res = await apiFetch('/api/schedule');
      if (!res.ok) return null;
      const body = await res.json();
      const rules = Array.isArray(body?.rules) ? body.rules : [];
      // Adapt to the shape the gantt renderer expects: surface a numeric
      // start/end via slotTs / slotEndTs when present (SMA rules carry them).
      // For manual rules only HH:MM is available — those are skipped because
      // they recur daily and a Gantt timeline expects absolute timestamps.
      const ganttRules = rules
        .filter((r) => Number.isFinite(Number(r?.slotTs)) && Number.isFinite(Number(r?.slotEndTs)))
        .map((r) => ({
          ...r,
          start: new Date(Number(r.slotTs)).toISOString(),
          end: new Date(Number(r.slotEndTs)).toISOString()
        }));
      return { lastSchedule: ganttRules };
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

  async function fetchStatusData() {
    try {
      const res = await apiFetch('/api/status');
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
      enableZoomReset(pvForecastChart);
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

    function isForecastLabel(label) {
      if (!label) return false;
      var l = label.toLowerCase();
      return (
        l.indexOf('solar') !== -1 ||
        l.indexOf('forecast') !== -1 ||
        l.indexOf('prognose') !== -1 ||
        l.indexOf('pv') !== -1 ||
        l.indexOf('consumption') !== -1 ||
        l.indexOf('load') !== -1 ||
        l.indexOf('last') !== -1
      );
    }

    toggle.addEventListener('change', function () {
      var hidden = !toggle.checked;

      // 1) EPEX/Börsenchart overlay (pricing chart — D-06 type 3 original target)
      var priceChart = Chart.getChart('priceChartCanvas');
      if (priceChart) {
        priceChart.data.datasets.forEach(function (ds) {
          if (isForecastLabel(ds.label)) ds.hidden = hidden;
        });
        priceChart.update('none');
      }

      // 2) PV-Prognose-vs-Ist chart — toggle between PV-only and PV+Load view
      //    This is the chart the checkbox physically sits next to; users expect
      //    clicking it to affect THIS chart in addition to the EPEX overlay.
      var pvChart = Chart.getChart('pv-forecast-chart');
      if (pvChart) {
        pvChart.data.datasets.forEach(function (ds) {
          if (ds.label && ds.label.toLowerCase().indexOf('last') !== -1) {
            // Toggle flag is "Overlay: PV / Last" — when ON, show Last overlay
            ds.hidden = hidden;
          }
        });
        pvChart.update('none');
      }
    });

    // Initial sync: default checkbox state is unchecked → hide "Last" dataset
    // on pv-forecast-chart so it starts as PV-only (matches the kicker label
    // "PV-PROGNOSE VS. IST" — load is an opt-in overlay).
    setTimeout(function () {
      var pvChart = Chart.getChart('pv-forecast-chart');
      if (!pvChart) return;
      pvChart.data.datasets.forEach(function (ds) {
        if (ds.label && ds.label.toLowerCase().indexOf('last') !== -1) {
          ds.hidden = !toggle.checked;
        }
      });
      pvChart.update('none');
    }, 500);
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
  // 6. Forecast Comparison Chart (D-21, D-22, D-23) — 6 overlaid forecast lines
  // ---------------------------------------------------------------------------
  var forecastCompChart = null;

  // Forecast-Vergleich: only show what /api/forecast actually exposes today.
  // Individual source curves (pvlib/solcast/vrm) aren't broken out by the API —
  // they're merged internally in pv-forecast.js before the response.
  // To re-add them, extend buildForecastResponse() to expose per-source slot arrays.
  var COMPARISON_DATASETS = [
    { key: 'actual', label: 'Ist (gemessen)',          color: 'rgba(46, 204, 113, 1)', dash: [],     width: 2   },
    { key: 'past',   label: 'Prognose (historisch)',   color: 'rgba(46, 204, 113, 0.55)', dash: [3, 3], width: 1.5 },
    { key: 'ml',     label: 'ML-korrigiert',           color: '#A78BFA', dash: [],     width: 2.5 },
    { key: 'merged', label: 'Basis-Prognose',          color: '#22D3EE', dash: [4, 3], width: 1.8 },
    { key: 'load',   label: 'Last-Prognose',           color: '#58a6ff', dash: [4, 3], width: 1.5 }
  ];

  function initForecastComparisonChart() {
    var canvas = document.getElementById('forecastComparisonChart');
    if (!canvas || typeof Chart === 'undefined') return;

    var datasets = COMPARISON_DATASETS.map(function (ds) {
      return {
        label: ds.label,
        data: [],
        borderColor: ds.color,
        backgroundColor: 'transparent',
        borderWidth: ds.width,
        borderDash: ds.dash,
        pointRadius: 0,
        tension: 0.3,
        fill: false
      };
    });

    var nowMs = Date.now();
    var config = {
      type: 'line',
      data: { datasets: datasets },
      options: JSON.parse(JSON.stringify(CHART_DEFAULTS))
    };
    // Linear X axis with ms timestamps (no date adapter needed) — 12h back + 24h ahead
    config.options.scales.x = {
      type: 'linear',
      min: nowMs - 12 * 3600000,
      max: nowMs + 24 * 3600000,
      grid: { color: 'rgba(90, 106, 138, 0.15)' },
      ticks: {
        maxTicksLimit: 12,
        maxRotation: 0,
        color: '#5a6a8a',
        font: { family: 'JetBrains Mono', size: 10 },
        callback: function (val) {
          return new Date(val).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        }
      }
    };
    config.options.scales.y.title = {
      display: true,
      text: 'Leistung (kW)',
      color: '#5a6a8a',
      font: { size: 10 }
    };
    config.options.scales.y.beginAtZero = true;
    config.options.plugins.tooltip.callbacks = {
      label: function (ctx) {
        return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + ' kW';
      },
      title: function (items) {
        if (!items.length) return '';
        return new Date(items[0].parsed.x).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      }
    };
    // Now-marker vertical dashed line (D-B2)
    config.options.plugins.annotation = {
      annotations: {
        nowLine: {
          type: 'line',
          xMin: nowMs,
          xMax: nowMs,
          borderColor: 'rgba(255, 165, 0, 0.8)',
          borderWidth: 2,
          borderDash: [6, 3],
          label: {
            display: true,
            content: 'jetzt',
            position: 'start',
            backgroundColor: 'rgba(255, 165, 0, 0.7)',
            color: '#fff',
            font: { size: 11 }
          }
        }
      }
    };

    forecastCompChart = new Chart(canvas, config);
    enableZoomReset(forecastCompChart);
    buildComparisonLegend();
  }

  function buildComparisonLegend() {
    var container = document.getElementById('forecastCompLegend');
    if (!container || !forecastCompChart) return;
    container.innerHTML = '';
    container.style.display = 'flex';
    container.style.gap = '10px';
    container.style.flexWrap = 'wrap';
    container.style.padding = '8px 0 0';
    container.style.fontSize = '10px';

    COMPARISON_DATASETS.forEach(function (ds, i) {
      var item = document.createElement('span');
      item.style.display = 'inline-flex';
      item.style.alignItems = 'center';
      item.style.gap = '4px';
      item.style.cursor = 'pointer';
      item.style.color = ds.color;
      item.style.fontWeight = '600';
      item.style.userSelect = 'none';

      var swatch = document.createElement('span');
      swatch.style.display = 'inline-block';
      swatch.style.width = '12px';
      swatch.style.height = '3px';
      swatch.style.background = ds.color;
      swatch.style.borderRadius = '2px';

      item.appendChild(swatch);
      item.appendChild(document.createTextNode(ds.label));

      item.addEventListener('click', function () {
        var meta = forecastCompChart.getDatasetMeta(i);
        meta.hidden = !meta.hidden;
        item.style.opacity = meta.hidden ? '0.3' : '1';
        forecastCompChart.update('none');
      });

      container.appendChild(item);
    });
  }

  function updateForecastComparisonChart(forecastData) {
    var card = document.getElementById('forecastComparisonCard');
    var skeleton = document.getElementById('forecastCompSkeleton');

    if (!forecastCompChart) initForecastComparisonChart();
    if (!forecastCompChart) return;

    // Extract ML-corrected PV slots (final merged forecast)
    var pvSlots = forecastData && forecastData.pv && forecastData.pv.slots ? forecastData.pv.slots : [];
    // Extract raw PV (pre-ML merged) slots
    var rawPvSlots = forecastData && forecastData.rawPv && forecastData.rawPv.slots ? forecastData.rawPv.slots : [];

    if (pvSlots.length === 0 && rawPvSlots.length === 0) {
      // Show empty state
      if (card) card.style.display = '';
      if (skeleton) {
        skeleton.style.display = '';
        skeleton.textContent = 'Noch keine Vergleichsdaten vorhanden';
        skeleton.style.lineHeight = '200px';
        skeleton.style.textAlign = 'center';
        skeleton.style.color = '#5a6a8a';
        skeleton.style.fontSize = '0.85rem';
        skeleton.style.animation = 'none';
      }
      return;
    }

    // Build time-based {x, y} data arrays (W -> kW, x = ms timestamp): [actual, ml, merged]
    var mlData = pvSlots.map(function (s) {
      return { x: new Date(s.start).getTime(), y: (s.powerW || 0) / 1000 };
    });
    var mergedData = rawPvSlots.map(function (s) {
      return { x: new Date(s.start).getTime(), y: (s.powerW || 0) / 1000 };
    });
    // "Actual" measured PV from /api/forecast response.actual[] (Plan 01 wiring)
    var actualData = Array.isArray(forecastData && forecastData.actual)
      ? forecastData.actual.map(function (s) {
          return { x: new Date(s.start).getTime(), y: (s.powerW || 0) / 1000 };
        })
      : [];
    // Historic forecast for the same 12h window — lets users see Prognose vs Ist
    // overlapping on the time axis (without this, Ist and Prognose are time-disjoint).
    var pastForecastData = Array.isArray(forecastData && forecastData.pastForecast)
      ? forecastData.pastForecast.map(function (s) {
          return { x: new Date(s.start).getTime(), y: (s.powerW || 0) / 1000 };
        })
      : [];

    // Last-Prognose: future load slots from the same /api/forecast response.
    // Folded in here so we don't need a second "PV vs Ist" chart that duplicated the same data.
    var loadSlots = forecastData && forecastData.load && forecastData.load.slots ? forecastData.load.slots : [];
    var loadData = loadSlots.map(function (s) {
      return { x: new Date(s.start).getTime(), y: (s.powerW || 0) / 1000 };
    });

    forecastCompChart.data.datasets[0].data = actualData;        // Ist (gemessen)
    forecastCompChart.data.datasets[1].data = pastForecastData;  // Prognose (historisch)
    forecastCompChart.data.datasets[2].data = mlData;            // ML-korrigiert
    forecastCompChart.data.datasets[3].data = mergedData;        // Basis-Prognose
    forecastCompChart.data.datasets[4].data = loadData;          // Last-Prognose

    // Compute X-axis range: span from earliest data point to latest, padded 1h each side
    var nowMs = Date.now();
    var allTimestamps = []
      .concat(actualData.map(function (d) { return d.x; }))
      .concat(pastForecastData.map(function (d) { return d.x; }))
      .concat(mlData.map(function (d) { return d.x; }))
      .concat(mergedData.map(function (d) { return d.x; }))
      .concat(loadData.map(function (d) { return d.x; }))
      .filter(function (t) { return t > 0; });
    var dataMin = allTimestamps.length ? Math.min.apply(null, allTimestamps) : nowMs - 12 * 3600000;
    var dataMax = allTimestamps.length ? Math.max.apply(null, allTimestamps) : nowMs + 24 * 3600000;
    var xScale = forecastCompChart.options.scales.x;
    xScale.min = dataMin - 3600000;
    xScale.max = dataMax + 3600000;
    var ann = forecastCompChart.options.plugins.annotation;
    if (ann && ann.annotations && ann.annotations.nowLine) {
      ann.annotations.nowLine.xMin = nowMs;
      ann.annotations.nowLine.xMax = nowMs;
    }

    forecastCompChart.update('none');

    // Show card, hide skeleton
    if (card) card.style.display = '';
    if (skeleton) skeleton.style.display = 'none';

    // Update per-day forecast summary cards (#17)
    updateForecastSummaryCards(forecastData);
  }

  // ---------------------------------------------------------------------------
  // 6b. Forecast Summary Cards per day (#17: Heute/Morgen/Uebermorgen)
  // ---------------------------------------------------------------------------
  function updateForecastSummaryCards(forecastData) {
    var container = document.getElementById('forecastDaySummary');
    if (!container) return;

    var pvSlots = forecastData && forecastData.pv && forecastData.pv.slots ? forecastData.pv.slots : [];
    if (pvSlots.length === 0) {
      container.textContent = '';
      return;
    }

    // Group PV slots by LOCAL day and sum energy (kWh)
    var dayBuckets = {};
    var res = forecastData.pv && forecastData.pv.resolution === '1h' ? 1 : 0.25;
    pvSlots.forEach(function (s) {
      var d = new Date(s.start);
      if (isNaN(d.getTime())) return;
      var dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (!dayBuckets[dayKey]) dayBuckets[dayKey] = 0;
      var durationH = res;
      if (s.end && s.start) {
        var diff = (new Date(s.end) - new Date(s.start)) / 3600000;
        if (Number.isFinite(diff) && diff > 0) durationH = diff;
      }
      dayBuckets[dayKey] += ((s.powerW || 0) / 1000) * durationH; // kWh
    });

    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var tomorrow = new Date(today.getTime() + 86400000);
    var dayAfter = new Date(today.getTime() + 2 * 86400000);

    function fmtDate(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    var labels = [
      { key: fmtDate(today), name: 'Heute' },
      { key: fmtDate(tomorrow), name: 'Morgen' },
      { key: fmtDate(dayAfter), name: 'Ueberm.' }
    ];

    // After sunset (hour >= 18 or today PV is 0), show Morgen first
    var currentHour = now.getHours();
    var todayKwh = dayBuckets[labels[0].key] || 0;
    if (currentHour >= 18 || todayKwh === 0) {
      // Swap Heute and Morgen order — Morgen first
      var tmp = labels[0];
      labels[0] = labels[1];
      labels[1] = tmp;
    }

    var parts = [];
    labels.forEach(function (l) {
      var kwh = dayBuckets[l.key];
      if (kwh != null) {
        parts.push(l.name + ': ' + kwh.toFixed(1) + ' kWh');
      }
    });

    // If no forecast data bucketed into named days, show raw bucket keys
    if (parts.length === 0) {
      Object.keys(dayBuckets).sort().forEach(function (k) {
        var d = new Date(k + 'T12:00:00');
        var label = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        parts.push(label + ': ' + dayBuckets[k].toFixed(1) + ' kWh');
      });
    }

    container.textContent = parts.length > 0 ? parts.join(' | ') : '';
  }

  // ---------------------------------------------------------------------------
  // 7. ML Badge (D-26) — active/collecting/error state indicator
  // ---------------------------------------------------------------------------
  function updateMlBadge(mlStatus) {
    var badge = document.getElementById('badge-ml');
    if (!badge) return;

    if (!mlStatus || mlStatus.tier < 2 || !mlStatus.mlEnabled) {
      badge.style.display = 'none';
      return;
    }

    var dot = badge.querySelector('.dot');
    if (!dot) return;

    // Reset dot classes
    dot.classList.remove('dot-ok', 'dot-warn', 'dot-danger');

    var dataStatus = mlStatus.dataStatus || '';
    if (dataStatus === 'active') {
      dot.classList.add('dot-ok');
      var modelType = mlStatus.modelType || 'Linear';
      var version = mlStatus.modelVersion || 0;
      var mae = mlStatus.mae || '?';
      badge.title = 'ML aktiv -- ' + modelType + ' v' + version + ', MAE ' + mae + 'W';
    } else if (dataStatus === 'collecting') {
      dot.classList.add('dot-warn');
      var days = mlStatus.datadays || '?';
      badge.title = 'ML sammelt Daten (' + days + '/30 Tage)';
    } else if (dataStatus === 'error') {
      dot.classList.add('dot-danger');
      badge.title = 'ML Fehler -- letztes Training fehlgeschlagen';
    } else {
      dot.classList.add('dot-warn');
      badge.title = 'ML Status unbekannt';
    }

    badge.style.display = '';

    // Click navigates to ML settings
    if (!badge._mlClickBound) {
      badge.addEventListener('click', function () {
        window.location.href = '/settings.html#ml';
      });
      badge._mlClickBound = true;
    }
  }

  // ---------------------------------------------------------------------------
  // ML status fetch helper
  // ---------------------------------------------------------------------------
  async function fetchMlStatus() {
    try {
      var res = await apiFetch('/api/ml/status');
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Optimizer-Plan chart (Phase 05 follow-up) — shows latest optimizer run
  // as 48h curves: battery plan (charge/discharge), PV forecast, load forecast,
  // and price curve on a secondary axis.
  // ---------------------------------------------------------------------------
  var optimizerPlanChart = null;

  async function fetchOptimizerPlan() {
    try {
      var res = await apiFetch('/api/optimizer/runs/latest');
      if (!res.ok) return null;
      var data = await res.json();
      return data && data.ok ? data.run : null;
    } catch (e) {
      return null;
    }
  }

  function renderOptimizerPlanChart(run) {
    var card = document.getElementById('optimizerPlanCard');
    var canvas = document.getElementById('optimizerPlanChart');
    var skeleton = document.getElementById('optimizerPlanSkeleton');
    var subtitle = document.getElementById('optimizerPlanSubtitle');
    if (!canvas || !card || typeof Chart === 'undefined') return;

    if (!run || !run.seriesByKey) {
      card.style.display = 'none';
      return;
    }

    card.style.display = '';
    if (skeleton) skeleton.style.display = 'none';

    var batterySeries = run.seriesByKey.battery_power_w || [];
    var pvSeries = run.seriesByKey.pv_power_w || [];
    var loadSeries = run.seriesByKey.load_power_w || [];
    var priceSeries = run.seriesByKey.price_import_ct_kwh || [];

    if (batterySeries.length === 0) {
      card.style.display = 'none';
      return;
    }

    var labels = batterySeries.map(function (s) {
      var d = new Date(s.ts);
      return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    });

    function alignToBattery(series) {
      var map = {};
      for (var i = 0; i < series.length; i++) map[series[i].ts] = series[i].value;
      return batterySeries.map(function (b) { return map[b.ts] != null ? map[b.ts] : null; });
    }

    var batteryKw = batterySeries.map(function (s) { return (s.value || 0) / 1000; });
    var pvKw = alignToBattery(pvSeries).map(function (v) { return v != null ? v / 1000 : null; });
    var loadKw = alignToBattery(loadSeries).map(function (v) { return v != null ? v / 1000 : null; });
    var priceCt = alignToBattery(priceSeries);

    var datasets = [
      {
        label: 'Batterie-Plan (+lade/-entlade)',
        data: batteryKw,
        borderColor: '#A78BFA',
        backgroundColor: 'rgba(167, 139, 250, 0.15)',
        borderWidth: 2.5,
        pointRadius: 0,
        tension: 0.1,
        fill: true,
        yAxisID: 'y'
      },
      {
        label: 'PV-Prognose',
        data: pvKw,
        borderColor: '#e3b341',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        tension: 0.3,
        yAxisID: 'y'
      },
      {
        label: 'Last-Prognose',
        data: loadKw,
        borderColor: '#58a6ff',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        tension: 0.3,
        yAxisID: 'y'
      },
      {
        label: 'Preis (ct/kWh)',
        data: priceCt,
        borderColor: '#39E06F',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
        yAxisID: 'y1'
      }
    ];

    var config = {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: JSON.parse(JSON.stringify(CHART_DEFAULTS))
    };
    // Dual-axis setup: y = kW (battery/PV/load), y1 = ct/kWh (price)
    config.options.scales = {
      x: {
        grid: { color: 'rgba(90, 106, 138, 0.15)' },
        ticks: { color: '#5a6a8a', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 12, maxRotation: 45 }
      },
      y: {
        position: 'left',
        grid: { color: 'rgba(90, 106, 138, 0.15)' },
        ticks: { color: '#5a6a8a', font: { family: 'JetBrains Mono', size: 9 } },
        title: { display: true, text: 'kW', color: '#5a6a8a', font: { size: 10 } }
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: '#39E06F', font: { family: 'JetBrains Mono', size: 9 } },
        title: { display: true, text: 'ct/kWh', color: '#39E06F', font: { size: 10 } }
      }
    };
    config.options.plugins.tooltip.callbacks = {
      label: function (ctx) {
        var unit = ctx.dataset.yAxisID === 'y1' ? ' ct/kWh' : ' kW';
        return ctx.dataset.label + ': ' + (ctx.parsed.y != null ? ctx.parsed.y.toFixed(2) : '--') + unit;
      }
    };

    if (optimizerPlanChart) {
      optimizerPlanChart.data = config.data;
      optimizerPlanChart.options = config.options;
      optimizerPlanChart.update('none');
    } else {
      optimizerPlanChart = new Chart(canvas, config);
      enableZoomReset(optimizerPlanChart);
    }

    // Subtitle: optimizer source + runtime
    if (subtitle) {
      var ts = new Date(run.runStartedAt);
      var tsLabel = ts.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      subtitle.textContent = (run.optimizer || '--') + ' @ ' + tsLabel;
    }

    // Custom legend with click-to-toggle
    var legendEl = document.getElementById('optimizerPlanLegend');
    if (legendEl) {
      legendEl.innerHTML = '';
      datasets.forEach(function (ds, idx) {
        var item = document.createElement('span');
        item.className = 'chart-legend-item';
        item.style.cursor = 'pointer';
        item.style.marginRight = '10px';
        item.style.fontSize = '0.75rem';
        item.innerHTML = '<span style="display:inline-block;width:10px;height:2px;background:' + ds.borderColor + ';margin-right:4px;vertical-align:middle;"></span>' + ds.label;
        item.addEventListener('click', function () {
          var meta = optimizerPlanChart.getDatasetMeta(idx);
          meta.hidden = meta.hidden === null ? !optimizerPlanChart.data.datasets[idx].hidden : !meta.hidden;
          item.style.opacity = meta.hidden ? '0.4' : '1';
          optimizerPlanChart.update();
        });
        legendEl.appendChild(item);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Refresh orchestrator
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Forecast Summary Cards (PV-Tagesprognose, Verbrauch, Überschuss)
  // ---------------------------------------------------------------------------
  function updateForecastSummary(forecastData, statusData) {
    var pvEl = document.getElementById('pv-daily-kwh');
    var detailEl = document.getElementById('pv-daily-detail');
    var loadEl = document.getElementById('load-daily-kwh');
    var loadDetailEl = document.getElementById('load-daily-detail');
    var surplusEl = document.getElementById('surplus-daily-kwh');
    var surplusDetailEl = document.getElementById('surplus-daily-detail');
    if (!pvEl || !loadEl || !surplusEl) return;

    if (!forecastData) {
      pvEl.textContent = '--';
      loadEl.textContent = '--';
      surplusEl.textContent = '--';
      if (detailEl) detailEl.textContent = '';
      return;
    }

    var pvSlotsAll = forecastData.pv?.slots || [];
    var rawSlotsAll = forecastData.rawPv?.slots || [];
    var loadSlotsAll = forecastData.load?.slots || [];
    var pvRes = forecastData.pv?.resolution || '1h';
    var loadRes = forecastData.load?.resolution || '1h';
    var pvH = pvRes === '15min' ? 0.25 : 1;
    var loadH = loadRes === '15min' ? 0.25 : 1;

    // "Tagesprognose" must be a single calendar day (Berlin local), not the
    // whole 36–72h forecast horizon. Pick today's local YYYY-MM-DD and bucket
    // slots by their local date — surplus card also reports "morgen".
    var berlinTodayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    var berlinTomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    var berlinTomorrowKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(berlinTomorrow);
    function localDateKey(isoStart) {
      if (!isoStart) return '';
      try {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date(isoStart));
      } catch (e) { return ''; }
    }
    function filterToday(slots) {
      return slots.filter(function (s) { return localDateKey(s.start) === berlinTodayKey; });
    }
    function filterTomorrow(slots) {
      return slots.filter(function (s) { return localDateKey(s.start) === berlinTomorrowKey; });
    }
    var pvSlots = filterToday(pvSlotsAll);
    var rawSlots = filterToday(rawSlotsAll);
    var loadSlots = filterToday(loadSlotsAll);
    var pvSlotsTomorrow = filterTomorrow(pvSlotsAll);
    var loadSlotsTomorrow = filterTomorrow(loadSlotsAll);

    // "Rest" = future-only (slots with ts_utc >= NOW, already filtered server-side).
    var pvKwhRest = 0; pvSlots.forEach(function (s) { pvKwhRest += (s.powerW || 0) / 1000 * pvH; });
    var rawKwhRest = 0; rawSlots.forEach(function (s) { rawKwhRest += (s.powerW || 0) / 1000 * pvH; });
    var loadKwhRest = 0; loadSlots.forEach(function (s) { loadKwhRest += (s.powerW || 0) / 1000 * loadH; });
    var pvKwhTomorrow = 0; pvSlotsTomorrow.forEach(function (s) { pvKwhTomorrow += (s.powerW || 0) / 1000 * pvH; });
    var loadKwhTomorrow = 0; loadSlotsTomorrow.forEach(function (s) { loadKwhTomorrow += (s.powerW || 0) / 1000 * loadH; });

    // Tagesgesamt: prefer backend-computed VRM full-day totals (past+future)
    // when available. Fallback to "Rest" when no VRM forecast exists yet.
    var totals = forecastData.dailyTotals || null;
    var pvKwh = totals?.today?.pvKwh != null ? totals.today.pvKwh : pvKwhRest;
    var loadKwh = totals?.today?.loadKwh != null ? totals.today.loadKwh : loadKwhRest;
    var rawKwh = rawKwhRest; // ML-vs-raw delta still relates to the future portion
    if (totals?.tomorrow?.pvKwh != null && totals.tomorrow.pvKwh > 0) pvKwhTomorrow = totals.tomorrow.pvKwh;
    if (totals?.tomorrow?.loadKwh != null && totals.tomorrow.loadKwh > 0) loadKwhTomorrow = totals.tomorrow.loadKwh;

    // Battery state from /api/status
    var soc = statusData?.victron?.soc;
    var battCapWh = statusData?.config?.optimizer?.batteryCapacityWh || 43000;
    var minSoc = statusData?.config?.optimizer?.minSocPct || 10;
    var battKwh = soc != null ? (soc / 100) * battCapWh / 1000 : null;
    var usableKwh = soc != null ? Math.max(0, ((soc - minSoc) / 100) * battCapWh / 1000) : null;

    // Surplus includes usable battery energy
    var surplus = pvKwh - loadKwh;
    var totalAvailable = surplus + (usableKwh || 0);

    pvEl.textContent = pvKwh.toFixed(1) + ' kWh';
    loadEl.textContent = loadKwh.toFixed(1) + ' kWh';

    // Surplus: green if positive, red if negative
    var sign = surplus >= 0 ? '+' : '';
    surplusEl.textContent = sign + surplus.toFixed(1) + ' kWh';
    surplusEl.style.color = surplus >= 0 ? '#39E06F' : '#ff7b72';

    // Detail lines
    if (detailEl) {
      var pvParts = ['Rest heute: ' + pvKwhRest.toFixed(1) + ' kWh'];
      if (Math.abs(pvKwhRest - rawKwhRest) > 0.5) {
        pvParts.push('ML/Basis: ' + pvKwhRest.toFixed(1) + '/' + rawKwhRest.toFixed(1));
      }
      if (pvKwhTomorrow > 0) pvParts.push('Morgen: ' + pvKwhTomorrow.toFixed(1) + ' kWh');
      detailEl.innerHTML = '<span style="font-size:10px;color:#5a6a8a;">' + pvParts.join(' · ') + '</span>';
    }

    // Load detail: warn if flat baseload
    if (loadDetailEl) {
      var hasTotalsLoad = !!(totals && totals.today && totals.today.loadKwh > 0);
      var allSame = loadSlots.length > 1 && loadSlots.every(function (s) { return s.powerW === loadSlots[0].powerW; });
      if (allSame) {
        loadDetailEl.innerHTML = '<span style="font-size:10px;color:#ff7b72;">\u26a0 Flat ' + (loadSlots[0]?.powerW || 0) + 'W (kein echtes Forecast)</span>';
      } else if (!loadSlots.length && !hasTotalsLoad) {
        loadDetailEl.innerHTML = '<span style="font-size:10px;color:#ff7b72;">⚠ Kein Load-Forecast für heute</span>';
      } else {
        var loadParts = ['Rest heute: ' + loadKwhRest.toFixed(1) + ' kWh'];
        if (loadKwhTomorrow > 0) loadParts.push('Morgen: ' + loadKwhTomorrow.toFixed(1) + ' kWh');
        loadDetailEl.innerHTML = '<span style="font-size:10px;color:#5a6a8a;">' + loadParts.join(' · ') + '</span>';
      }
    }

    // Surplus detail: battery + total
    if (surplusDetailEl) {
      var parts = [];
      if (battKwh != null) parts.push('\ud83d\udd0b ' + soc + '% = ' + battKwh.toFixed(1) + ' kWh (' + usableKwh.toFixed(1) + ' nutzbar)');
      if (usableKwh != null) {
        var totalSign = totalAvailable >= 0 ? '+' : '';
        parts.push('Verf\u00fcgbar: ' + totalSign + totalAvailable.toFixed(1) + ' kWh');
      }
      surplusDetailEl.innerHTML = '<span style="font-size:10px;color:#5a6a8a;">' + parts.join(' · ') + '</span>';
    }
  }

  async function refreshAllCharts() {
    var results = await Promise.allSettled([
      fetchForecastData(),
      fetchOptimizerData(),
      fetchCostData(),
      fetchMlStatus(),
      fetchOptimizerPlan(),
      fetchStatusData()
    ]);

    var forecastData = results[0].status === 'fulfilled' ? results[0].value : null;
    var optimizerData = results[1].status === 'fulfilled' ? results[1].value : null;
    var costData = results[2].status === 'fulfilled' ? results[2].value : null;
    var mlStatus = results[3].status === 'fulfilled' ? results[3].value : null;
    var optimizerPlan = results[4].status === 'fulfilled' ? results[4].value : null;
    var statusData = results[5].status === 'fulfilled' ? results[5].value : null;

    updateForecastSummary(forecastData, statusData);
    // PV-Prognose vs. Ist Chart: merged into the Forecast-Vergleich chart below
    // (Ist + Last-Prognose are now both there) — keeping the call would draw
    // duplicate datasets in a removed canvas anyway.
    renderGanttChart(optimizerData);
    renderSavingsCard(costData);
    updateBadges();

    // ML additions
    updateMlBadge(mlStatus);
    if (forecastData) updateForecastComparisonChart(forecastData);

    // Optimizer-Plan chart (Phase 05 follow-up)
    renderOptimizerPlanChart(optimizerPlan);
  }

  // ---------------------------------------------------------------------------
  // Init on DOMContentLoaded
  // ---------------------------------------------------------------------------
  function init() {
    initOverlayToggle();
    initForecastComparisonChart();
    refreshAllCharts();
    refreshTimer = setInterval(refreshAllCharts, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
