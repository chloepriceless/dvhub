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
      },
      zoom: {
        pan: {
          enabled: true,
          mode: 'x',
          modifierKey: null
        },
        zoom: {
          wheel: { enabled: true, modifierKey: null },
          pinch: { enabled: true },
          mode: 'x',
          onZoomComplete: function (ctx) {
            // Show reset hint on first zoom
            var card = ctx.chart.canvas.closest('.chart-span-card, .metric-card');
            if (card && !card.querySelector('.zoom-reset-hint')) {
              var hint = document.createElement('div');
              hint.className = 'zoom-reset-hint';
              hint.textContent = 'Doppelklick = Reset';
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
    { key: 'actual', label: 'Ist (gemessen)',  color: '#e8eaf0', dash: [],     width: 2   },
    { key: 'ml',     label: 'ML-korrigiert',    color: '#A78BFA', dash: [],     width: 2.5 },
    { key: 'merged', label: 'Basis-Prognose',   color: '#22D3EE', dash: [4, 3], width: 1.8 }
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

    var config = {
      type: 'line',
      data: { labels: [], datasets: datasets },
      options: JSON.parse(JSON.stringify(CHART_DEFAULTS))
    };
    config.options.scales.x.ticks = {
      maxTicksLimit: 12,
      maxRotation: 0,
      color: '#5a6a8a',
      font: { family: 'JetBrains Mono', size: 10 }
    };
    config.options.scales.y.title = {
      display: true,
      text: 'Leistung (W)',
      color: '#5a6a8a',
      font: { size: 10 }
    };
    config.options.scales.y.beginAtZero = true;
    config.options.plugins.tooltip.callbacks = {
      label: function (ctx) {
        return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(0) + ' W';
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

    // Use whichever slot array is longer for labels
    var refSlots = pvSlots.length >= rawPvSlots.length ? pvSlots : rawPvSlots;
    var labels = refSlots.map(function (s) {
      var d = new Date(s.start);
      var h = d.getHours().toString().padStart(2, '0');
      var m = d.getMinutes().toString().padStart(2, '0');
      return h + ':' + m;
    });

    // Build data arrays: [actual, ml, merged]
    var mlData = pvSlots.map(function (s) { return s.powerW || 0; });
    var mergedData = rawPvSlots.map(function (s) { return s.powerW || 0; });
    // "Actual" measured PV from optional historical samples attached by the
    // API under forecastData.actual (not yet wired; empty for now).
    var actualData = Array.isArray(forecastData && forecastData.actual)
      ? forecastData.actual.map(function (s) { return s.powerW || 0; })
      : [];

    forecastCompChart.data.labels = labels;
    forecastCompChart.data.datasets[0].data = actualData;  // Ist (gemessen) — empty until wired
    forecastCompChart.data.datasets[1].data = mlData;       // ML-korrigiert
    forecastCompChart.data.datasets[2].data = mergedData;   // Basis-Prognose
    forecastCompChart.update('none');

    // Show card, hide skeleton
    if (card) card.style.display = '';
    if (skeleton) skeleton.style.display = 'none';
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
        borderColor: '#3fb950',
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
        ticks: { color: '#3fb950', font: { family: 'JetBrains Mono', size: 9 } },
        title: { display: true, text: 'ct/kWh', color: '#3fb950', font: { size: 10 } }
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

    var pvSlots = forecastData.pv?.slots || [];
    var rawSlots = forecastData.rawPv?.slots || [];
    var loadSlots = forecastData.load?.slots || [];
    var pvRes = forecastData.pv?.resolution || '1h';
    var loadRes = forecastData.load?.resolution || '1h';
    var pvH = pvRes === '15min' ? 0.25 : 1;
    var loadH = loadRes === '15min' ? 0.25 : 1;

    var pvKwh = 0; pvSlots.forEach(function (s) { pvKwh += (s.powerW || 0) / 1000 * pvH; });
    var rawKwh = 0; rawSlots.forEach(function (s) { rawKwh += (s.powerW || 0) / 1000 * pvH; });
    var loadKwh = 0; loadSlots.forEach(function (s) { loadKwh += (s.powerW || 0) / 1000 * loadH; });

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
    surplusEl.style.color = surplus >= 0 ? '#3fb950' : '#ff7b72';

    // Detail lines
    if (detailEl) {
      if (Math.abs(pvKwh - rawKwh) > 0.5) {
        detailEl.innerHTML = '<span style="font-size:10px;color:#5a6a8a;">ML: ' + pvKwh.toFixed(1) + ' · Basis: ' + rawKwh.toFixed(1) + ' kWh</span>';
      } else {
        detailEl.innerHTML = '<span style="font-size:10px;color:#5a6a8a;">' + pvSlots.length + ' Slots (' + pvRes + ')</span>';
      }
    }

    // Load detail: warn if flat baseload
    if (loadDetailEl) {
      var allSame = loadSlots.length > 1 && loadSlots.every(function (s) { return s.powerW === loadSlots[0].powerW; });
      if (allSame) {
        loadDetailEl.innerHTML = '<span style="font-size:10px;color:#ff7b72;">\u26a0 Flat ' + (loadSlots[0]?.powerW || 0) + 'W (kein echtes Forecast)</span>';
      } else {
        loadDetailEl.innerHTML = '<span style="font-size:10px;color:#5a6a8a;">' + loadSlots.length + ' Slots (' + loadRes + ')</span>';
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
    renderPvForecastChart(forecastData);
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
