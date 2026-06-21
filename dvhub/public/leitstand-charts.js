(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  // Plan 09.1-04: chart palette is now sourced from Aurora CSS tokens via the
  // window.DVhubCommon.aurChartColor / aurChartColorAlpha helpers (exported
  // from common.js). The legacy CHART_COLORS const-object was resolved once
  // at module load, which meant theme switches (dark ⇄ light) could not
  // repaint charts because Chart.js had already cached the hex strings.
  // getChartColors() runs at chart-construction time and reads live CSS
  // variables, so the existing apply()/refresh() pipeline carries theme
  // switches through to the chart datasets without any extra plumbing.
  function _aur(name, fallback) {
    var c = window.DVhubCommon;
    return (c && c.aurChartColor) ? c.aurChartColor(name, fallback) : fallback;
  }
  function _aurA(name, alpha, fallback) {
    var c = window.DVhubCommon;
    return (c && c.aurChartColorAlpha) ? c.aurChartColorAlpha(name, alpha, fallback) : fallback;
  }
  function getChartColors() {
    // Fall back to legacy palette if common.js failed to load — charts must
    // still paint even if the helper isn't available.
    return {
      pvForecast:       _aur('--yellow',                       '#e3b341'),
      pvActual:         _aurA('--yellow', 0.5,                 'rgba(227, 179, 65, 0.5)'),
      loadForecast:     _aur('--blue',                         '#58a6ff'),
      scheduleInternal: _aur('--schedule-user-cyan',           '#0077FF'),
      scheduleEos:      _aur('--green',                        '#39E06F'),
      scheduleSma:      _aur('--schedule-automation-yellow',   '#f2c94c'),
      savingsPositive:  _aur('--chart-positive',               '#39E06F'),
      savingsNegative:  _aur('--chart-negative',               '#ff7b72'),
      sparkline:        _aur('--text-dim',                     '#5a6a8a')
    };
  }

  const REFRESH_MS = 30000;

  // CHART_DEFAULTS is now a getter — colors must be resolved per chart-build
  // so theme switches re-paint via the existing apply()/refresh() pipeline.
  function getChartDefaults() {
    return {
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
          backgroundColor: _aurA('--bg-elev', 0.95, 'rgba(11, 15, 26, 0.95)'),
          titleColor: _aur('--text', '#e8eaf0'),
          bodyColor: _aur('--text-2', '#c8cdd8'),
          borderColor: _aurA('--glass-brd', 0.3, 'rgba(99, 102, 241, 0.3)'),
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
                // CSP-safe: individual property setters (cssText is blocked
                // by style-src without 'unsafe-inline').
                hint.style.position = 'absolute';
                hint.style.top = '4px';
                hint.style.right = '8px';
                hint.style.fontSize = '9px';
                hint.style.color = _aur('--chart-axis', '#5a6a8a');
                hint.style.opacity = '0.7';
                hint.style.pointerEvents = 'none';
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
          grid: { color: _aur('--chart-grid', 'rgba(90, 106, 138, 0.15)') },
          ticks: { color: _aur('--chart-axis', '#5a6a8a'), font: { family: 'JetBrains Mono', size: 9 } }
        },
        y: {
          grid: { color: _aur('--chart-grid', 'rgba(90, 106, 138, 0.15)') },
          ticks: { color: _aur('--chart-axis', '#5a6a8a'), font: { family: 'JetBrains Mono', size: 9 } }
        }
      }
    };
  }

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

  async function fetchStatusData() {
    try {
      const res = await apiFetch('/api/status');
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // PV-Forecast standalone chart removed (Aurora 09.1-04 follow-up): PV and
  // Last forecast are now shown together in the Forecast-Vergleich chart
  // further below. The previous standalone canvas was never wired into
  // refreshAllCharts and rendered a perpetual loading skeleton.

  // ---------------------------------------------------------------------------
  // 2. Gantt Timeline (D-06 type 2) — horizontal bar chart
  // ---------------------------------------------------------------------------
  // Gantt timeline removed (Aurora 09.1-04 follow-up): the Optimizer Schedule
  // table already shows the schedule chronologically and more legibly than the
  // 3-row gantt visualisation could.

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
  // 4. Savings Card — REMOVED (operator request 2026-06-12): the card duplicated
  //    the "Kosten heute" rail card which renders the same /api/costs data.
  // ---------------------------------------------------------------------------

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
  // Plan 09.1-04: colours resolved per-build via Aurora tokens, not stored in the
  // const. Each call re-reads tokens so theme switches repaint the legend + lines.
  // PV-Forecast provider overlay lines (operator request 2026-06-21): the
  // Forecast-Vergleich chart historically showed only Ist / Prognose-historisch /
  // Basis-Prognose because /api/forecast merges the per-source curves before the
  // response. We now overlay each provider as its own thin line, fed from
  // /api/forecast/inspector/pv-providers (see renderForecastProviders), resampled
  // onto the SAME 15-min grid as the base datasets so peaks line up on the X axis.
  var FORECAST_PROVIDER_SERIES = [
    { key: 'solcast',        label: 'Solcast',        color: '#ff9f1c' },
    { key: 'pvlib',          label: 'pvlib',          color: '#ff6b9d' },
    { key: 'vrm',            label: 'VRM',            color: '#1dd1a1' },
    { key: 'forecast_solar', label: 'Forecast.Solar', color: '#feca57' },
    { key: 'open_meteo',     label: 'Open-Meteo',     color: '#c8d6e5' },
    { key: 'pvnode',         label: 'pvnode',         color: '#54a0ff' }
  ];
  function forecastChartGridTs() {
    var SLOT = 15 * 60 * 1000, now = Date.now();
    var from = Math.floor((now - 12 * 3600000) / SLOT) * SLOT;
    var to = Math.ceil((now + 24 * 3600000) / SLOT) * SLOT;
    var ts = [];
    for (var t = from; t < to; t += SLOT) ts.push(t);
    return ts;
  }
  function forecastResampleToGrid(points, gridTs) {
    if (!points.length) return gridTs.map(function (ts) { return { x: ts, y: null }; });
    points.sort(function (a, b) { return a.x - b.x; });
    var first = points[0].x, last = points[points.length - 1].x, i = 0;
    return gridTs.map(function (ts) {
      if (ts < first || ts > last) return { x: ts, y: null };
      while (i < points.length - 1 && points[i + 1].x < ts) i++;
      if (points[i].x === ts) return { x: ts, y: points[i].y };
      if (i >= points.length - 1) return { x: ts, y: points[i].y };
      var a = points[i], b = points[i + 1], r = (ts - a.x) / (b.x - a.x);
      return { x: ts, y: a.y + r * (b.y - a.y) };
    });
  }

  function getComparisonDatasets() {
    return [
      { key: 'actual', label: 'Ist (gemessen)',        color: _aur('--green', 'rgba(46, 204, 113, 1)'),       dash: [],     width: 2   },
      { key: 'past',   label: 'Prognose (historisch)', color: _aurA('--green', 0.55, 'rgba(46, 204, 113, 0.55)'), dash: [3, 3], width: 1.5 },
      { key: 'ml',     label: 'ML-korrigiert',         color: _aur('--violet', '#A78BFA'),                     dash: [],     width: 2.5 },
      { key: 'merged', label: 'Basis-Prognose',        color: _aur('--cyan', '#22D3EE'),                       dash: [4, 3], width: 1.8 },
      { key: 'load',   label: 'Last-Prognose',         color: _aur('--blue', '#58a6ff'),                       dash: [4, 3], width: 1.5 }
    ];
  }

  function initForecastComparisonChart() {
    var canvas = document.getElementById('forecastComparisonChart');
    if (!canvas || typeof Chart === 'undefined') return;

    var datasets = getComparisonDatasets().map(function (ds) {
      return {
        label: ds.label,
        data: [],
        borderColor: ds.color,
        backgroundColor: 'transparent',
        borderWidth: ds.width,
        borderDash: ds.dash,
        pointRadius: 0,
        // tension:0 — straight segments between data points; tension:0.3 was
        // producing visual peak-position drift because the spline overshoots
        // between sparse (30/60-min) forecast slots vs the dense (15-min)
        // actual slots, making peaks appear shifted relative to the X-axis.
        tension: 0,
        // spanGaps:false — draw a gap rather than connecting across null
        // entries, so the padded historical/null sections (see below) are
        // visually clear, not interpolated through.
        spanGaps: false,
        fill: false
      };
    });

    // Overlay one thin line per PV-forecast provider (data filled each cycle by
    // renderForecastProviders from the inspector endpoint). Tagged dvProvider so
    // the update can find each by key — these live at indices 5+, which the base
    // updateForecastComparisonChart never writes (it only sets datasets[0..4]).
    FORECAST_PROVIDER_SERIES.forEach(function (ps) {
      datasets.push({
        label: ps.label, data: [], dvProvider: ps.key,
        borderColor: ps.color, backgroundColor: 'transparent',
        borderWidth: 1.2, borderDash: [], pointRadius: 0, tension: 0,
        spanGaps: false, fill: false
      });
    });

    var nowMs = Date.now();
    var config = {
      type: 'line',
      data: { datasets: datasets },
      options: JSON.parse(JSON.stringify(getChartDefaults()))
    };
    // Linear X axis with ms timestamps (no date adapter needed) — 12h back + 24h ahead.
    // Operator complaint 2026-05-22 (screenshot): the auto-generated tick labels
    // landed at irregular non-clock-aligned positions ("10:30, 16:30, 19:00,
    // 22:00, ...") because Chart.js' linear scale picks "nice" step sizes in
    // raw ms space (e.g. 9_000_000 ms ≈ 2.5h) that do not snap to wall-clock
    // hours. With irregular labels, a data peak at e.g. 12:15 visually sits
    // far from any clean "12:00" tick — operator perceives it as a
    // horizontal offset between data and X axis.
    // Force ticks onto integer hourly boundaries via afterBuildTicks: every 3h
    // from the first :00 boundary after min — gives the operator a stable,
    // predictable axis that lines up with the actual time labels.
    config.options.scales.x = {
      type: 'linear',
      min: nowMs - 12 * 3600000,
      max: nowMs + 24 * 3600000,
      grid: { color: _aur('--chart-grid', 'rgba(90, 106, 138, 0.15)') },
      afterBuildTicks: function (axis) {
        var xmin = axis.min;
        var xmax = axis.max;
        var d = new Date(xmin);
        d.setMinutes(0, 0, 0);
        if (d.getTime() < xmin) d.setHours(d.getHours() + 1);
        var step = 3 * 3600000;
        var ticks = [];
        for (var t = d.getTime(); t <= xmax; t += step) {
          ticks.push({ value: t });
        }
        axis.ticks = ticks;
      },
      ticks: {
        maxRotation: 0,
        color: _aur('--chart-axis', '#5a6a8a'),
        font: { family: 'JetBrains Mono', size: 10 },
        callback: function (val) {
          return new Date(val).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        }
      }
    };
    config.options.scales.y.title = {
      display: true,
      text: 'Leistung (kW)',
      color: _aur('--chart-axis', '#5a6a8a'),
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
    // Now-marker vertical dashed line (D-B2) — Aurora orange via --chart-now (yellow)
    // or --orange depending on theme. Use --chart-now (= --yellow) for parity with
    // app.js Jetzt-line which also reads --chart-now.
    config.options.plugins.annotation = {
      annotations: {
        nowLine: {
          type: 'line',
          xMin: nowMs,
          xMax: nowMs,
          borderColor: _aurA('--chart-now', 0.8, 'rgba(255, 165, 0, 0.8)'),
          borderWidth: 2,
          borderDash: [6, 3],
          label: {
            display: true,
            content: 'jetzt',
            position: 'start',
            backgroundColor: _aurA('--chart-now', 0.7, 'rgba(255, 165, 0, 0.7)'),
            color: _aur('--text', '#fff'),
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

    getComparisonDatasets().forEach(function (ds, i) {
      var item = document.createElement('span');
      // Tag with the dataset index so updateForecastComparison can find and
      // hide this legend item when its dataset is disabled (e.g. ML off).
      item.dataset.dsIndex = String(i);
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

    // Provider overlay lines (datasets 5+) — same toggle behaviour, offset index.
    var baseCount = getComparisonDatasets().length;
    FORECAST_PROVIDER_SERIES.forEach(function (ps, j) {
      var dsIndex = baseCount + j;
      var item = document.createElement('span');
      item.dataset.dsIndex = String(dsIndex);
      item.style.display = 'inline-flex';
      item.style.alignItems = 'center';
      item.style.gap = '4px';
      item.style.cursor = 'pointer';
      item.style.color = ps.color;
      item.style.fontWeight = '600';
      item.style.userSelect = 'none';

      var swatch = document.createElement('span');
      swatch.style.display = 'inline-block';
      swatch.style.width = '12px';
      swatch.style.height = '3px';
      swatch.style.background = ps.color;
      swatch.style.borderRadius = '2px';

      item.appendChild(swatch);
      item.appendChild(document.createTextNode(ps.label));

      item.addEventListener('click', function () {
        var meta = forecastCompChart.getDatasetMeta(dsIndex);
        if (!meta) return;
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
        skeleton.style.color = _aur('--chart-axis', '#5a6a8a');
        skeleton.style.fontSize = '0.85rem';
        skeleton.style.animation = 'none';
      }
      return;
    }

    // ─── REBUILD 2026-05-22: common 15-min grid ──────────────────────────
    // Operator complaint after 4 iterations: forecast lines still appear
    // visually shifted relative to the Ist line. Root cause: each dataset
    // arrived from /api/forecast at its own native resolution (actual:15min,
    // pastForecast:30min, pv/rawPv:30min, load:60min). Chart.js drew each
    // line through its own stützpunkte, so peaks landed at different X
    // positions depending on which dataset happened to have a slot at the
    // exact peak time.
    //
    // Solution: project ALL datasets onto a shared 15-min grid spanning the
    // chart's locked window (now-12h ... now+24h). Every line then has the
    // SAME 144 x-coordinates; comparisons happen at identical X-pixels.
    var SLOT_MS = 15 * 60 * 1000;
    var nowMsRebuild = Date.now();
    var gridFrom = Math.floor((nowMsRebuild - 12 * 3600000) / SLOT_MS) * SLOT_MS;
    var gridTo   = Math.ceil ((nowMsRebuild + 24 * 3600000) / SLOT_MS) * SLOT_MS;
    var gridTs   = [];
    for (var t = gridFrom; t < gridTo; t += SLOT_MS) gridTs.push(t);

    // Map slot-array -> sorted [{x, y}] in kW.
    function toPoints(slots) {
      if (!Array.isArray(slots)) return [];
      var pts = slots.map(function (s) {
        return { x: new Date(s.start).getTime(), y: (s.powerW || 0) / 1000 };
      }).filter(function (p) { return Number.isFinite(p.x); });
      pts.sort(function (a, b) { return a.x - b.x; });
      return pts;
    }

    // Resample a sorted-points array to the shared 15-min grid using linear
    // interpolation. Returns null outside the source range (so the line
    // doesn't extend beyond where the dataset actually has data).
    function resample(points) {
      if (points.length === 0) return gridTs.map(function (ts) { return { x: ts, y: null }; });
      var firstTs = points[0].x;
      var lastTs = points[points.length - 1].x;
      var i = 0;
      return gridTs.map(function (ts) {
        if (ts < firstTs || ts > lastTs) return { x: ts, y: null };
        while (i < points.length - 1 && points[i + 1].x < ts) i++;
        if (points[i].x === ts) return { x: ts, y: points[i].y };
        if (i >= points.length - 1) return { x: ts, y: points[i].y };
        var a = points[i], b = points[i + 1];
        var ratio = (ts - a.x) / (b.x - a.x);
        return { x: ts, y: a.y + ratio * (b.y - a.y) };
      });
    }

    var actualPoints    = toPoints(forecastData && forecastData.actual);
    var pastFcPoints    = toPoints(forecastData && forecastData.pastForecast);
    var mlRawPoints     = toPoints(pvSlots);
    var mergedRawPoints = toPoints(rawPvSlots);
    var loadRawPoints   = toPoints(forecastData && forecastData.load && forecastData.load.slots);

    // Stitch past+future for the forecast lines so they span the chart.
    var mlAllPoints     = pastFcPoints.concat(mlRawPoints.filter(function (p) {
      return pastFcPoints.length === 0 || p.x > pastFcPoints[pastFcPoints.length - 1].x;
    }));
    var mergedAllPoints = pastFcPoints.concat(mergedRawPoints.filter(function (p) {
      return pastFcPoints.length === 0 || p.x > pastFcPoints[pastFcPoints.length - 1].x;
    }));

    var actualData       = resample(actualPoints);
    var pastForecastData = resample(pastFcPoints);
    var mlData           = resample(mlAllPoints);
    var mergedData       = resample(mergedAllPoints);
    var loadData         = resample(loadRawPoints);

    forecastCompChart.data.datasets[0].data = actualData;        // Ist (gemessen)
    forecastCompChart.data.datasets[1].data = pastForecastData;  // Prognose (historisch)
    forecastCompChart.data.datasets[2].data = mlData;            // ML-korrigiert
    forecastCompChart.data.datasets[3].data = mergedData;        // Basis-Prognose
    forecastCompChart.data.datasets[4].data = loadData;          // Last-Prognose
    // With common 15-min grid + linear interpolation, spanGaps is irrelevant
    // — null values are explicit gaps where the source dataset had no data.
    forecastCompChart.data.datasets.forEach(function (ds) { ds.spanGaps = false; });

    // ML disabled on prod 2026-05-22 (lightgbm v1 squashed daytime peaks to
    // ~10-15% of the ensemble forecast — MAE 2658W vs 550W on the older
    // models). With cfg.ml.mlEnabled=false, the backend returns
    // forecastData.pv = forecastData.rawPv — they're byte-identical. Hiding
    // the ML-korrigiert dataset AND its legend entry prevents two overlapping
    // identical lines and removes the "ML-korrigiert" chip from the legend.
    // When ML is re-enabled (model retrained / squash fixed), meta.mlActive
    // flips back to true and both line + legend chip return automatically.
    var mlActive = !!(forecastData && forecastData.meta && forecastData.meta.mlActive);
    if (!mlActive) {
      // Empty the data so even if the meta.hidden flag is ignored somewhere,
      // there are simply no points to plot.
      forecastCompChart.data.datasets[2].data = [];
    }
    var mlMeta = forecastCompChart.getDatasetMeta(2);
    if (mlMeta) mlMeta.hidden = !mlActive;
    // Hide the ML chip in our custom legend (built via buildComparisonLegend).
    var mlLegendItem = document.querySelector('#forecastCompLegend [data-ds-index="2"]');
    if (mlLegendItem) mlLegendItem.style.display = mlActive ? 'inline-flex' : 'none';

    // Operator complaint 2026-05-22: the forecast chart's X-axis was sliding
    // with data extent (was: min(allTimestamps) - 1h → max(allTimestamps) + 1h)
    // so its left edge wandered every refresh as pastForecast/actual arrived
    // and dropped off. That made it impossible to visually compare against
    // the EPEX price chart sitting directly above it, which uses today's
    // midnight as a stable left edge. Lock the forecast chart to the
    // (now − 12h, now + 24h) window its subtitle already advertises so the
    // coordinate system is deterministic on each refresh.
    var nowMs = Date.now();
    var xScale = forecastCompChart.options.scales.x;
    xScale.min = nowMs - 12 * 3600000;
    xScale.max = nowMs + 24 * 3600000;
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
        borderColor: _aur('--violet', '#A78BFA'),
        backgroundColor: _aurA('--violet', 0.15, 'rgba(167, 139, 250, 0.15)'),
        borderWidth: 2.5,
        pointRadius: 0,
        tension: 0.1,
        fill: true,
        yAxisID: 'y'
      },
      {
        label: 'PV-Prognose',
        data: pvKw,
        borderColor: _aur('--yellow', '#e3b341'),
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
        borderColor: _aur('--blue', '#58a6ff'),
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
        borderColor: _aur('--green', '#39E06F'),
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
      options: JSON.parse(JSON.stringify(getChartDefaults()))
    };
    // Dual-axis setup: y = kW (battery/PV/load), y1 = ct/kWh (price)
    config.options.scales = {
      x: {
        grid: { color: _aur('--chart-grid', 'rgba(90, 106, 138, 0.15)') },
        ticks: { color: _aur('--chart-axis', '#5a6a8a'), font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 12, maxRotation: 45 }
      },
      y: {
        position: 'left',
        grid: { color: _aur('--chart-grid', 'rgba(90, 106, 138, 0.15)') },
        ticks: { color: _aur('--chart-axis', '#5a6a8a'), font: { family: 'JetBrains Mono', size: 9 } },
        title: { display: true, text: 'kW', color: _aur('--chart-axis', '#5a6a8a'), font: { size: 10 } }
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: _aur('--green', '#39E06F'), font: { family: 'JetBrains Mono', size: 9 } },
        title: { display: true, text: 'ct/kWh', color: _aur('--green', '#39E06F'), font: { size: 10 } }
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
        item.innerHTML = '<span class="leitstand-legend-swatch"></span>' + ds.label;
        item.querySelector('.leitstand-legend-swatch').style.background = ds.borderColor;
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
    var minSoc = statusData?.config?.optimizer?.hardFloorSocPct ?? statusData?.config?.optimizer?.minSocPct ?? 5;
    var battKwh = soc != null ? (soc / 100) * battCapWh / 1000 : null;
    var usableKwh = soc != null ? Math.max(0, ((soc - minSoc) / 100) * battCapWh / 1000) : null;

    // Surplus includes usable battery energy
    var surplus = pvKwh - loadKwh;
    var totalAvailable = surplus + (usableKwh || 0);

    pvEl.textContent = pvKwh.toFixed(1) + ' kWh';
    loadEl.textContent = loadKwh.toFixed(1) + ' kWh';

    // Surplus: green if positive, red if negative — via Aurora chart tokens
    // so the same hue maps the EPEX chart in both light and dark themes.
    var sign = surplus >= 0 ? '+' : '';
    surplusEl.textContent = sign + surplus.toFixed(1) + ' kWh';
    surplusEl.style.color = surplus >= 0
      ? _aur('--chart-positive', '#39E06F')
      : _aur('--chart-negative', '#ff7b72');

    // Aurora text-dim / danger hues shared across all detail spans below
    var _dimColor = _aur('--chart-axis', '#5a6a8a');
    var _dangerColor = _aur('--chart-negative', '#ff7b72');

    // Detail lines
    if (detailEl) {
      var pvParts = ['Rest heute: ' + pvKwhRest.toFixed(1) + ' kWh'];
      if (Math.abs(pvKwhRest - rawKwhRest) > 0.5) {
        pvParts.push('ML/Basis: ' + pvKwhRest.toFixed(1) + '/' + rawKwhRest.toFixed(1));
      }
      if (pvKwhTomorrow > 0) pvParts.push('Morgen: ' + pvKwhTomorrow.toFixed(1) + ' kWh');
      detailEl.innerHTML = '<span class="leitstand-forecast-detail">' + pvParts.join(' · ') + '</span>';
      detailEl.firstChild.style.color = _dimColor;
    }

    // Load detail: warn if flat baseload
    if (loadDetailEl) {
      var hasTotalsLoad = !!(totals && totals.today && totals.today.loadKwh > 0);
      var allSame = loadSlots.length > 1 && loadSlots.every(function (s) { return s.powerW === loadSlots[0].powerW; });
      if (allSame) {
        loadDetailEl.innerHTML = '<span class="leitstand-forecast-detail">\u26a0 Flat ' + (loadSlots[0]?.powerW || 0) + 'W (kein echtes Forecast)</span>';
        loadDetailEl.firstChild.style.color = _dangerColor;
      } else if (!loadSlots.length && !hasTotalsLoad) {
        loadDetailEl.innerHTML = '<span class="leitstand-forecast-detail">⚠ Kein Load-Forecast für heute</span>';
        loadDetailEl.firstChild.style.color = _dangerColor;
      } else {
        var loadParts = ['Rest heute: ' + loadKwhRest.toFixed(1) + ' kWh'];
        if (loadKwhTomorrow > 0) loadParts.push('Morgen: ' + loadKwhTomorrow.toFixed(1) + ' kWh');
        loadDetailEl.innerHTML = '<span class="leitstand-forecast-detail">' + loadParts.join(' · ') + '</span>';
        loadDetailEl.firstChild.style.color = _dimColor;
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
      surplusDetailEl.innerHTML = '<span class="leitstand-forecast-detail">' + parts.join(' · ') + '</span>';
      surplusDetailEl.firstChild.style.color = _dimColor;
    }
  }

  // PV-Forecast-Provider card (operator request 2026-06-21) — surfaces the
  // Settings Forecast-Inspector provider breakdown in the Leitstand: which PV
  // forecast providers feed (incl. pvlib), each one's day-peak (kW), how fresh it
  // is, and whether the inverse-MAE ensemble is active. Self-contained: own fetch
  // of /api/forecast/inspector/pv-providers (the merged /api/forecast does NOT
  // expose per-source series), own render, errors swallowed so it can never abort
  // the chart refresh cycle. Provider keys are server-defined (no user input).
  var FORECAST_PROVIDER_LABELS = {
    solcast: 'Solcast', pvlib: 'pvlib', pvnode: 'pvnode', vrm: 'VRM',
    forecast_solar: 'Forecast.Solar', open_meteo: 'Open-Meteo',
    'eos-akkudoktor': 'EOS', combined: 'Ensemble'
  };
  function forecastProviderAgeLabel(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return '';
    var min = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (min < 1) return 'gerade eben';
    if (min < 60) return 'vor ' + min + ' min';
    var h = Math.floor(min / 60);
    return 'vor ' + h + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
  }
  async function renderForecastProviders() {
    var body = document.getElementById('forecastProvidersBody');
    var ensEl = document.getElementById('forecastProvidersEnsemble');
    if (!body) return;
    try {
      var now = new Date();
      var to = new Date(now.getTime() + 24 * 3600 * 1000);
      var qs = '?from=' + encodeURIComponent(now.toISOString()) + '&to=' + encodeURIComponent(to.toISOString());
      var res = await apiFetch('/api/forecast/inspector/pv-providers' + qs);
      var j = (res && res.ok) ? await res.json() : null;
      if (!j || !j.ok || !j.providers) {
        body.innerHTML = '<div class="forecast-providers-empty">Keine Provider-Daten verf&uuml;gbar.</div>';
        if (ensEl) { ensEl.textContent = ''; ensEl.classList.remove('is-active'); }
        return;
      }
      var fetched = j.oldestFetchedAt || {};
      var rows = Object.keys(j.providers).map(function (key) {
        var slots = j.providers[key] || [];
        var peakW = 0;
        for (var i = 0; i < slots.length; i++) {
          var w = Number(slots[i] && slots[i].power_w);
          if (isFinite(w) && w > peakW) peakW = w;
        }
        var ageMin = null;
        if (fetched[key]) {
          var t = new Date(fetched[key]).getTime();
          if (isFinite(t)) ageMin = Math.max(0, (Date.now() - t) / 60000);
        }
        return {
          label: FORECAST_PROVIDER_LABELS[key] || key,
          peakKw: peakW / 1000,
          age: fetched[key],
          stale: ageMin != null && ageMin > 180,
          has: slots.length > 0
        };
      });
      // Active providers first, then by day-peak descending.
      rows.sort(function (a, b) { return (b.has - a.has) || (b.peakKw - a.peakKw); });
      body.innerHTML = rows.map(function (r) {
        var dotCls = !r.has ? 'is-off' : r.stale ? 'is-stale' : 'is-live';
        return '<div class="fp-row">' +
          '<span class="fp-dot ' + dotCls + '"></span>' +
          '<span class="fp-name">' + r.label + '</span>' +
          '<span class="fp-peak">' + (r.has ? r.peakKw.toFixed(1).replace('.', ',') + ' kW' : '—') + '</span>' +
          '<span class="fp-age">' + forecastProviderAgeLabel(r.age) + '</span>' +
          '</div>';
      }).join('');
      if (ensEl) {
        var n = (j.meta && j.meta.modelCount) || rows.filter(function (r) { return r.has; }).length;
        ensEl.textContent = 'Ensemble: ' + (j.ensembleActive ? 'aktiv' : 'inaktiv') + ' · ' + n + ' Modelle';
        ensEl.classList.toggle('is-active', !!j.ensembleActive);
      }

      // Overlay the provider curves on the Forecast-Vergleich chart (operator
      // request 2026-06-21) — resampled onto the same 15-min grid as the base
      // datasets so the peaks line up on the X axis.
      if (forecastCompChart && forecastCompChart.data && forecastCompChart.data.datasets) {
        var gridTs = forecastChartGridTs();
        var dss = forecastCompChart.data.datasets;
        FORECAST_PROVIDER_SERIES.forEach(function (ps) {
          var idx = -1;
          for (var di = 0; di < dss.length; di++) { if (dss[di].dvProvider === ps.key) { idx = di; break; } }
          if (idx < 0) return;
          var slots = j.providers[ps.key] || [];
          var pts = slots.map(function (s) {
            return { x: new Date(s.ts_utc).getTime(), y: (Number(s.power_w) || 0) / 1000 };
          }).filter(function (pt) { return isFinite(pt.x); });
          dss[idx].data = forecastResampleToGrid(pts, gridTs);
          // Hide the legend chip for a provider with no data (e.g. pvnode while
          // deactivated) so there's no dangling toggle. Only the chip — NOT
          // meta.hidden — so a user's manual show/hide toggle is never overridden.
          var legItem = document.querySelector('#forecastCompLegend [data-ds-index="' + idx + '"]');
          if (legItem) legItem.style.display = pts.length ? 'inline-flex' : 'none';
        });
        forecastCompChart.update('none');
      }
    } catch (e) {
      body.innerHTML = '<div class="forecast-providers-empty">Forecast-Provider nicht erreichbar.</div>';
    }
  }

  async function refreshAllCharts() {
    var results = await Promise.allSettled([
      fetchForecastData(),
      fetchOptimizerData(),
      fetchMlStatus(),
      fetchOptimizerPlan(),
      fetchStatusData()
    ]);

    var forecastData = results[0].status === 'fulfilled' ? results[0].value : null;
    var optimizerData = results[1].status === 'fulfilled' ? results[1].value : null;
    var mlStatus = results[2].status === 'fulfilled' ? results[2].value : null;
    var optimizerPlan = results[3].status === 'fulfilled' ? results[3].value : null;
    var statusData = results[4].status === 'fulfilled' ? results[4].value : null;

    // Plan 09-04: each chart render is wrapped in DVhubCommon.safeRender so a
    // throw in ONE chart does NOT abort the sibling charts in the same refresh
    // cycle. safeRender is a defensive sibling-isolation layer — Promise.allSettled
    // above already isolates the FETCHES; this isolates the RENDERS.
    var sr = (window.DVhubCommon && window.DVhubCommon.safeRender) || function (_, fn) { try { fn(); } catch (e) { console.error('[leitstand-chart-fallback]', _, e); } };

    sr('leitstand.forecast-summary', function () { updateForecastSummary(forecastData, statusData); });
    sr('leitstand.forecast-providers', function () { renderForecastProviders(); });
    // PV-Prognose vs. Ist Chart: merged into the Forecast-Vergleich chart below
    // (Ist + Last-Prognose are now both there) — keeping the call would draw
    // duplicate datasets in a removed canvas anyway.
    // Gantt timeline removed in Aurora 09.1-04 follow-up — the Optimizer Schedule
    // table already shows the schedule by time, more legibly than a 3-row gantt.
    // Savings card removed 2026-06-12 (duplicate of the "Kosten heute" rail card).
    sr('leitstand.badges', function () { updateBadges(); });

    // ML additions
    sr('leitstand.ml-badge', function () { updateMlBadge(mlStatus); });
    if (forecastData) sr('leitstand.forecast-comparison', function () { updateForecastComparisonChart(forecastData); });

    // Optimizer-Plan chart (Phase 05 follow-up)
    sr('leitstand.optimizer-plan', function () { renderOptimizerPlanChart(optimizerPlan); });
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
