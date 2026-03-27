// routes-api.js -- HTTP route handlers for ALL API endpoints.
// Extracted from server.js (Phase 5, Plans 01+02).
// Factory pattern: createApiRoutes(ctx) returns { handleRequest }.

import fs from 'node:fs';
import path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { parseBody, MAX_BODY_BYTES, nowIso, fmtTs, resolveLogLimit, u16, s16, roundCtKwh, addDays, gridDirection } from './server-utils.js';
import { effectiveBatteryCostCtKwh, mixedCostCtKwh, slotComparison, resolveImportPriceCtKwhForSlot, configuredModule3Windows } from './user-energy-pricing.js';
import { isSmallMarketAutomationRule } from './market-automation-builder.js';
import { buildWorkerBackedStatusResponse, buildHistoryImportStatusResponse } from './runtime-state.js';
import { buildOptimizerRunPayload } from './telemetry-runtime.js';

const execFileAsync = promisify(execFile);

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://dvhub.de https://*.tile.openstreetmap.org; connect-src 'self' https://api.dvhub.de"
};

export function createApiRoutes(ctx) {
  const { state, getCfg, pushLog, telemetrySafeWrite } = ctx;

  // ── Admin health payload builder ────────────────────────────────────
  async function adminHealthPayload() {
    const service = {
      enabled: ctx.getServiceActionsEnabled(),
      name: ctx.getServiceName(),
      useSudo: ctx.getServiceUseSudo(),
      status: 'disabled',
      detail: 'Service-Aktionen sind per ENV deaktiviert.'
    };

    if (ctx.getServiceActionsEnabled()) {
      const activeCheck = await ctx.runServiceCommand(['is-active', ctx.getServiceName()]);
      const showCheck = await ctx.runServiceCommand(['show', ctx.getServiceName(), '--property=ActiveState,SubState,UnitFileState', '--value']);
      service.status = activeCheck.ok ? (activeCheck.stdout || 'unknown') : 'unavailable';
      service.detail = activeCheck.ok ? 'systemctl erreichbar' : activeCheck.error;
      service.show = showCheck.ok ? showCheck.stdout : showCheck.error;
    }

    return {
      ok: true,
      checkedAt: Date.now(),
      app: ctx.getAppVersion(),
      service,
      runtime: {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        pid: process.pid,
        transport: ctx.getTransportType(),
        uptimeSec: Math.round(process.uptime())
      },
      checks: [
        {
          id: 'config',
          label: 'Config Datei',
          ok: ctx.getLoadedConfig().exists && ctx.getLoadedConfig().valid,
          detail: ctx.getLoadedConfig().exists
            ? (ctx.getLoadedConfig().valid ? `gueltig unter ${ctx.getConfigPath()}` : `ungueltig: ${ctx.getLoadedConfig().parseError}`)
            : `fehlt: ${ctx.getConfigPath()}`
        },
        {
          id: 'setup',
          label: 'Setup Status',
          ok: !ctx.getLoadedConfig().needsSetup,
          detail: ctx.getLoadedConfig().needsSetup ? 'Setup noch nicht abgeschlossen' : 'Setup abgeschlossen'
        },
        {
          id: 'meter',
          label: 'Live Meter Daten',
          ok: state.meter.ok,
          detail: state.meter.ok
            ? `letztes Update ${fmtTs(state.meter.updatedAt)}`
            : (state.meter.error || 'noch keine erfolgreichen Meter-Daten')
        },
        {
          id: 'epex',
          label: 'EPEX Feed',
          ok: !getCfg().epex.enabled || state.epex.ok,
          detail: !getCfg().epex.enabled
            ? 'deaktiviert'
            : state.epex.ok
              ? `letztes Update ${fmtTs(state.epex.updatedAt)}`
              : (state.epex.error || 'noch keine Preisdaten')
        },
        {
          id: 'service_actions',
          label: 'Restart Aktion',
          ok: ctx.getServiceActionsEnabled() && service.status !== 'unavailable',
          detail: ctx.getServiceActionsEnabled()
            ? `Service ${ctx.getServiceName()}: ${service.status}`
            : 'per ENV deaktiviert'
        },
        {
          id: 'telemetry',
          label: 'Interne Historie',
          ok: !getCfg().telemetry?.enabled || state.telemetry.ok,
          detail: !getCfg().telemetry?.enabled
            ? 'deaktiviert'
            : state.telemetry.dbPath
              ? `DB ${state.telemetry.dbPath}, letztes Schreiben ${fmtTs(state.telemetry.lastWriteAt)}`
              : (state.telemetry.lastError || 'noch keine Telemetrie-Initialisierung')
        }
      ]
    };
  }

  // ── Response helpers ─────────────────────────────────────────────────
  function json(res, code, payload) {
    res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  function text(res, code, payload) {
    res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(payload));
  }

  function downloadJson(res, filename, payload) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`
    });
    res.end(JSON.stringify(payload, null, 2));
  }

  // ── Auth / Rate Limiting ─────────────────────────────────────────────
  function isLocalNetworkRequest(req) {
    const raw = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    const addr = raw.replace(/^::ffff:/, '');
    // Localhost
    if (addr === '127.0.0.1' || addr === '::1') return true;
    // Private/LAN ranges (RFC 1918)
    const parts = addr.split('.').map(Number);
    if (parts.length === 4) {
      if (parts[0] === 10) return true;                                    // 10.0.0.0/8
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
      if (parts[0] === 192 && parts[1] === 168) return true;               // 192.168.0.0/16
    }
    // IPv6 link-local
    if (addr.startsWith('fe80:')) return true;
    return false;
  }

  // Read-only endpoints safe for LAN access without auth token.
  // ALL other endpoints require auth, even from LAN. Default-deny.
  const LAN_SAFE_ENDPOINTS = new Set([
    '/api/keepalive/modbus',
    '/api/keepalive/pulse',
    '/api/config',           // GET only (read config)
    '/api/config/export',
    '/api/discovery/systems',
    '/api/status',
    '/api/costs',
    '/api/integration/home-assistant',
    '/api/integration/loxone',
    '/api/integration/eos',
    '/api/integration/emhass',
    '/api/log',
    '/api/log/dv-signals',
    '/api/telemetry/series',
    '/api/forecast',
    '/api/epex/zones',
    '/api/epex/gaps',
    '/api/schedule',
    '/api/history/import/status',
    '/api/history/summary',
    '/api/schedule/automation/config',
    '/api/meter/scan',
    '/dv/control-value',
  ]);

  function isLanSafeRequest(req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Only GET requests to allowlisted endpoints bypass auth from LAN
    if (req.method !== 'GET') return false;
    return LAN_SAFE_ENDPOINTS.has(url.pathname);
  }

  // --- Rate Limiting (in-memory, per IP) ---
  const rateLimitBuckets = new Map();
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX_REQUESTS = 120; // 120 req/min per IP (2/s avg)
  const RATE_LIMIT_ADMIN_MAX = 10;     // stricter for admin/mutation endpoints

  function getRateLimitKey(req) {
    const raw = req.socket?.remoteAddress || '';
    return raw.replace(/^::ffff:/, '');
  }

  function checkRateLimit(req, res) {
    const ip = getRateLimitKey(req);
    const now = Date.now();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const isAdmin = url.pathname.startsWith('/api/admin/');
    const limit = isAdmin ? RATE_LIMIT_ADMIN_MAX : RATE_LIMIT_MAX_REQUESTS;

    let bucket = rateLimitBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      bucket = { windowStart: now, count: 0 };
      rateLimitBuckets.set(ip, bucket);
    }
    bucket.count++;

    if (bucket.count > limit) {
      res.writeHead(429, { ...SECURITY_HEADERS, 'Retry-After': '60', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return false;
    }
    return true;
  }

  // Clean up stale buckets every 5 minutes
  setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
    for (const [ip, bucket] of rateLimitBuckets) {
      if (bucket.windowStart < cutoff) rateLimitBuckets.delete(ip);
    }
  }, 300_000).unref();

  function checkAuth(req, res) {
    const cfg = getCfg();
    if (!cfg.apiToken) return true;
    // LAN requests bypass token check only for allowlisted read-only GET endpoints
    if (isLocalNetworkRequest(req) && isLanSafeRequest(req)) return true;
    const expected = Buffer.from(cfg.apiToken);
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const token = Buffer.from(auth.slice(7));
      if (token.length === expected.length && crypto.timingSafeEqual(token, expected)) return true;
    }
    const urlToken = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
    if (urlToken) {
      const urlBuf = Buffer.from(urlToken);
      if (urlBuf.length === expected.length && crypto.timingSafeEqual(urlBuf, expected)) return true;
    }
    res.writeHead(401, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }

  // ── Validation helpers ───────────────────────────────────────────────
  function validateScheduleRule(rule) {
    if (typeof rule !== 'object' || rule === null) return false;
    if (typeof rule.target !== 'string') return false;
    if (rule.value !== undefined && !Number.isFinite(Number(rule.value))) return false;
    return true;
  }

  // ── Response builders ────────────────────────────────────────────────
  function epexPriceArray() {
    if (!state.epex.ok || !Array.isArray(state.epex.data)) return [];
    return state.epex.data.map((row) => ({
      ts: row.ts,
      ts_iso: new Date(row.ts).toISOString(),
      eur_mwh: Number(row.eur_mwh ?? 0),
      eur_kwh: Number((row.eur_mwh ?? 0) / 1000),
      ct_kwh: Number(row.ct_kwh ?? 0)
    }));
  }

  function userEnergyPricingSummary() {
    const cfg = getCfg();
    const pricing = cfg.userEnergyPricing || {};
    const costs = pricing.costs || {};
    const slots = Array.isArray(state.epex.data) ? state.epex.data.map((row) => slotComparison(row, pricing, cfg.schedule?.timezone)) : [];
    const currentTs = ctx.epexNowNext()?.current?.ts;
    const current = slots.find((row) => row?.ts === currentTs) || null;
    const configured =
      (pricing.mode === 'fixed' && Number.isFinite(Number(pricing.fixedGrossImportCtKwh)))
      || pricing.mode === 'dynamic';

    return {
      configured,
      mode: pricing.mode || 'fixed',
      usesParagraph14aModule3: pricing.usesParagraph14aModule3 === true,
      dynamicComponents: {
        energyMarkupCtKwh: roundCtKwh(Number(pricing?.dynamicComponents?.energyMarkupCtKwh || 0)),
        gridChargesCtKwh: roundCtKwh(Number(pricing?.dynamicComponents?.gridChargesCtKwh || 0)),
        leviesAndFeesCtKwh: roundCtKwh(Number(pricing?.dynamicComponents?.leviesAndFeesCtKwh || 0)),
        vatPct: roundCtKwh(Number(pricing?.dynamicComponents?.vatPct || 0))
      },
      fixedGrossImportCtKwh: Number.isFinite(Number(pricing.fixedGrossImportCtKwh))
        ? roundCtKwh(Number(pricing.fixedGrossImportCtKwh))
        : null,
      module3Windows: configuredModule3Windows(pricing).map((window) => ({
        id: window.id,
        label: window.label,
        start: window.start,
        end: window.end,
        priceCtKwh: window.priceCtKwh
      })),
      costs: {
        pvCtKwh: Number.isFinite(Number(costs.pvCtKwh)) ? roundCtKwh(Number(costs.pvCtKwh)) : null,
        batteryBaseCtKwh: Number.isFinite(Number(costs.batteryBaseCtKwh)) ? roundCtKwh(Number(costs.batteryBaseCtKwh)) : null,
        batteryLossMarkupPct: roundCtKwh(Number(costs.batteryLossMarkupPct || 0)),
        batteryEffectiveCtKwh: effectiveBatteryCostCtKwh(costs),
        mixedCtKwh: mixedCostCtKwh(costs)
      },
      current,
      slots
    };
  }

  function costSummary() {
    return {
      day: state.energy.day,
      importWh: Number(state.energy.importWh.toFixed(3)),
      exportWh: Number(state.energy.exportWh.toFixed(3)),
      importKwh: Number((state.energy.importWh / 1000).toFixed(4)),
      exportKwh: Number((state.energy.exportWh / 1000).toFixed(4)),
      costEur: Number(state.energy.costEur.toFixed(4)),
      revenueEur: Number(state.energy.revenueEur.toFixed(4)),
      netEur: Number((state.energy.revenueEur - state.energy.costEur).toFixed(4)),
      priceNowCtKwh: Number(ctx.epexNowNext()?.current?.ct_kwh ?? 0),
      userImportPriceNowCtKwh: Number(userEnergyPricingSummary()?.current?.importPriceCtKwh ?? 0)
    };
  }

  function keepaliveModbusPayload() {
    return {
      ok: !!state.keepalive.modbusLastQuery,
      lastQuery: state.keepalive.modbusLastQuery,
      now: Date.now()
    };
  }

  function keepalivePulsePayload() {
    const now = Date.now();
    const cfg = getCfg();
    const slot = Math.floor(now / (cfg.keepalivePulseSec * 1000));
    const slotTs = slot * cfg.keepalivePulseSec * 1000;
    return {
      ok: true,
      periodSec: cfg.keepalivePulseSec,
      pulseSlot: slot,
      pulseTimestamp: slotTs,
      now
    };
  }

  function integrationState() {
    const cfg = getCfg();
    return {
      timestamp: Date.now(),
      dvControlValue: ctx.controlValue(),
      forcedOff: state.ctrl.forcedOff,
      gridTotalW: state.meter.grid_total_w,
      gridDirection: gridDirection(state.meter.grid_total_w, cfg.gridPositiveMeans).mode,
      gridSetpointW: state.victron.gridSetpointW,
      minSocPct: state.victron.minSocPct,
      soc: state.victron.soc,
      batteryPowerW: state.victron.batteryPowerW,
      pvTotalW: state.victron.pvTotalW,
      scheduleActive: state.schedule.active,
      costs: costSummary(),
      userEnergyPricing: userEnergyPricingSummary()
    };
  }

  // -- EOS (Akkudoktor) Integration --
  function eosState() {
    const cfg = getCfg();
    const now = new Date();
    const soc = Number(state.victron.soc ?? 0);
    const gridTotal = Number(state.meter.grid_total_w ?? 0);
    const posImport = cfg.gridPositiveMeans === 'grid_import';
    const gridImportW = Math.max(0, posImport ? gridTotal : -gridTotal);
    const gridExportW = Math.max(0, posImport ? -gridTotal : gridTotal);

    return {
      // Messwerte im EOS-Format (PUT /v1/measurement/data)
      measurement: {
        start_datetime: now.toISOString(),
        interval: `${cfg.meterPollMs / 1000} seconds`,
        battery_soc: [soc / 100],
        battery_power: [Number(state.victron.batteryPowerW ?? 0)],
        grid_import_w: [gridImportW],
        grid_export_w: [gridExportW],
        pv_power: [Number(state.victron.pvTotalW ?? 0)],
        load_power: [Number(state.victron.selfConsumptionW ?? 0)],
        power_l1_w: [Number(state.meter.grid_l1_w ?? 0)],
        power_l2_w: [Number(state.meter.grid_l2_w ?? 0)],
        power_l3_w: [Number(state.meter.grid_l3_w ?? 0)]
      },
      // Aktuelle Systeminfo
      system: {
        timestamp: now.toISOString(),
        soc_pct: soc,
        battery_power_w: Number(state.victron.batteryPowerW ?? 0),
        pv_total_w: Number(state.victron.pvTotalW ?? 0),
        grid_total_w: gridTotal,
        grid_import_w: gridImportW,
        grid_export_w: gridExportW,
        grid_setpoint_w: Number(state.victron.gridSetpointW ?? 0),
        min_soc_pct: Number(state.victron.minSocPct ?? 0),
        self_consumption_w: Number(state.victron.selfConsumptionW ?? 0)
      },
      // EPEX-Preise (fuer EOS prediction import)
      prices: epexPriceArray()
    };
  }

  // -- EMHASS Integration --
  function emhassState() {
    const soc = Number(state.victron.soc ?? 0);
    const prices = epexPriceArray();

    return {
      // Aktuelle Werte fuer soc_init
      soc_init: soc / 100,
      battery_power_w: Number(state.victron.batteryPowerW ?? 0),
      pv_power_w: Number(state.victron.pvTotalW ?? 0),
      load_power_w: Number(state.victron.selfConsumptionW ?? 0),
      grid_power_w: Number(state.meter.grid_total_w ?? 0),
      // EPEX-Preise als Array (EUR/kWh) fuer load_cost_forecast
      load_cost_forecast: prices.map((p) => p.eur_kwh),
      // Timestamps dazu
      price_timestamps: prices.map((p) => p.ts_iso),
      // Preise als prod_price_forecast (Einspeiseverguetung, hier identisch)
      prod_price_forecast: prices.map((p) => p.eur_kwh),
      // System-Metadaten
      timestamp: new Date().toISOString(),
      grid_setpoint_w: Number(state.victron.gridSetpointW ?? 0),
      min_soc_pct: Number(state.victron.minSocPct ?? 0)
    };
  }

  // ── Meter Scan ───────────────────────────────────────────────────────
  async function runMeterScan(params = {}) {
    const cfg = getCfg();
    if (state.scan.running) throw new Error('scan already running');
    const p = { ...cfg.scan, ...params };
    p.start = Number(p.start);
    p.end = Number(p.end);
    p.step = Math.max(1, Number(p.step));
    p.quantity = Math.max(1, Math.min(125, Number(p.quantity)));

    state.scan.running = true;
    state.scan.updatedAt = Date.now();
    state.scan.params = p;
    state.scan.rows = [];
    state.scan.error = null;
    pushLog('scan_start', p);

    const rows = [];
    try {
      for (let addr = p.start; addr <= p.end; addr += p.step) {
        try {
          const regs = await ctx.scanTransport.mbRequest({
            host: p.host,
            port: p.port,
            unitId: p.unitId,
            fc: p.fc,
            address: addr,
            quantity: p.quantity,
            timeoutMs: p.timeoutMs
          });
          const hasNonZero = regs.some((x) => Number(x) !== 0);
          if (!p.onlyNonZero || hasNonZero) rows.push({ addr, regs, s16: regs.map((v) => s16(v)) });
        } catch (e) {
          rows.push({ addr, error: e.message });
        }
        if (rows.length >= 1000) break;
      }
      state.scan.rows = rows;
      pushLog('scan_done', { rows: rows.length });
    } catch (e) {
      state.scan.error = e.message;
      pushLog('scan_error', { error: e.message });
    } finally {
      state.scan.running = false;
      state.scan.updatedAt = Date.now();
    }
  }

  // ── Config helpers ───────────────────────────────────────────────────
  const REDACTED_PATHS = ['apiToken', 'telemetry.historyImport.vrmToken', 'telemetry.database.password'];

  function redactConfig(config) {
    const copy = JSON.parse(JSON.stringify(config));
    for (const dotPath of REDACTED_PATHS) {
      const parts = dotPath.split('.');
      let obj = copy;
      for (let i = 0; i < parts.length - 1; i++) { obj = obj?.[parts[i]]; if (!obj) break; }
      if (obj && parts[parts.length - 1] in obj) obj[parts[parts.length - 1]] = '***';
    }
    return copy;
  }

  function configMetaPayload() {
    const loadedConfig = ctx.getLoadedConfig();
    return {
      path: ctx.getConfigPath(),
      exists: loadedConfig.exists,
      valid: loadedConfig.valid,
      parseError: loadedConfig.parseError,
      needsSetup: loadedConfig.needsSetup,
      warnings: loadedConfig.warnings || []
    };
  }

  function configApiPayload() {
    const cfg = getCfg();
    return {
      ok: true,
      meta: configMetaPayload(),
      config: redactConfig(ctx.getRawCfg()),
      effectiveConfig: redactConfig(cfg),
      definition: ctx.getConfigDefinition()
    };
  }

  // ── Status / History builders ────────────────────────────────────────
  function buildApiStatusResponse(now = Date.now()) {
    return buildWorkerBackedStatusResponse({
      cachedStatus: ctx.getCachedRuntimeStatusPayload(),
      fallbackStatus: ctx.buildFallbackStatusPayload(now),
      setup: configMetaPayload(),
      runtime: ctx.buildRuntimeRouteMeta(now)
    });
  }

  function buildApiHistoryImportStatusResponse() {
    const cfg = getCfg();
    return buildHistoryImportStatusResponse({
      cachedStatus: ctx.getCachedRuntimeStatusPayload(),
      fallbackTelemetryEnabled: !!cfg.telemetry?.enabled,
      fallbackHistoryImport: ctx.historyImportManager?.getStatus?.() || null
    });
  }

  // ── Static file serving ──────────────────────────────────────────────
  function servePage(res, filename) {
    const appDir = ctx.getAppDir();
    const publicDir = path.resolve(appDir, 'public');
    const file = path.resolve(publicDir, filename);
    if (!file.startsWith(publicDir + path.sep) && file !== publicDir) return text(res, 400, 'bad path');
    if (!fs.existsSync(file)) return text(res, 404, 'not found');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  }

  function serveStatic(req, res) {
    const appDir = ctx.getAppDir();
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    const reqPath = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
    const publicDir = path.resolve(appDir, 'public');
    const file = path.resolve(publicDir, reqPath.replace(/^\/+/, ''));
    if (!file.startsWith(publicDir + path.sep) && file !== publicDir) return text(res, 400, 'bad path');
    if (!fs.existsSync(file)) return text(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': mime });
    fs.createReadStream(file).pipe(res);
  }

  // ── Main request handler ─────────────────────────────────────────────
  async function handleRequest(req, res, url) {
    if (url.pathname === '/' && req.method === 'GET') {
      return servePage(res, ctx.needsSetup() ? 'setup.html' : 'index.html');
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dv/')) {
      if (!checkRateLimit(req, res)) return;
      if (!checkAuth(req, res)) return;
    }

    if (url.pathname === '/dv/control-value' && req.method === 'GET') return text(res, 200, ctx.controlValue());

    if (url.pathname === '/api/keepalive/modbus' && req.method === 'GET') return json(res, 200, keepaliveModbusPayload());
    if (url.pathname === '/api/keepalive/pulse' && req.method === 'GET') return json(res, 200, keepalivePulsePayload());
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, configApiPayload());

    if (url.pathname === '/api/config/export' && req.method === 'GET') {
      return downloadJson(res, 'dvhub-config.json', ctx.getRawCfg());
    }

    if (url.pathname === '/api/discovery/systems' && req.method === 'GET') {
      const payload = await ctx.buildSystemDiscoveryPayload({
        query: Object.fromEntries(url.searchParams)
      });
      return json(res, payload.ok ? 200 : 400, payload);
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      ctx.expireLeaseIfNeeded();
      return json(res, 200, buildApiStatusResponse(Date.now()));
    }

    if (url.pathname === '/api/costs' && req.method === 'GET') return json(res, 200, costSummary());

    if (url.pathname === '/api/integration/home-assistant' && req.method === 'GET') return json(res, 200, integrationState());

    if (url.pathname === '/api/integration/loxone' && req.method === 'GET') {
      const s = integrationState();
      const lines = Object.entries(s).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
      return text(res, 200, lines.join('\n'));
    }

    // EOS (Akkudoktor) -- Messwerte + Preise abrufen
    if (url.pathname === '/api/integration/eos' && req.method === 'GET') return json(res, 200, eosState());

    // EMHASS -- Messwerte + Preise abrufen
    if (url.pathname === '/api/integration/emhass' && req.method === 'GET') return json(res, 200, emhassState());

    if (url.pathname === '/api/log' && req.method === 'GET') {
      const limit = resolveLogLimit(url.searchParams.get('limit'));
      return json(res, 200, { rows: state.log.slice(-limit) });
    }

    // Persistent DV signal log from database
    if (url.pathname === '/api/log/dv-signals' && req.method === 'GET') {
      if (!ctx.telemetryStore?.listControlEvents) return json(res, 503, { ok: false, error: 'telemetry store not available' });
      const limit = Number(url.searchParams.get('limit')) || 200;
      const eventType = url.searchParams.get('type') || null;
      try {
        const rows = await ctx.telemetryStore.listControlEvents({ limit, eventType });
        return json(res, 200, { ok: true, rows, total: rows.length });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- Telemetry Series Query API ---
    if (url.pathname === '/api/telemetry/series' && req.method === 'GET') {
      if (!ctx.telemetryStore?.querySeries) return json(res, 503, { ok: false, error: 'telemetry store not available' });
      const keys = (url.searchParams.get('keys') || 'battery_soc_pct').split(',').map(k => k.trim()).filter(Boolean);
      const now = new Date();
      const start = url.searchParams.get('start') || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const end = url.searchParams.get('end') || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      const maxRes = Number(url.searchParams.get('maxResolution')) || 900;
      try {
        const rows = await ctx.telemetryStore.querySeries({ seriesKeys: keys, start, end, maxResolution: maxRes });
        return json(res, 200, { ok: true, keys, start, end, total: rows.length, data: rows });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- VRM Forecast API ---
    if (url.pathname === '/api/forecast' && req.method === 'GET') {
      if (!ctx.telemetryStore?.listForecasts) return json(res, 503, { ok: false, error: 'telemetry store not available' });
      const now = new Date();
      const startParam = url.searchParams.get('start');
      const endParam = url.searchParams.get('end');
      const start = startParam || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const end = endParam || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3).toISOString();
      const forecastType = url.searchParams.get('type') || null;
      try {
        const rows = await ctx.telemetryStore.listForecasts({ start, end, forecastType });
        return json(res, 200, {
          ok: true,
          start,
          end,
          solar: rows.filter(r => r.type === 'solar_yield').map(r => ({ ts: r.ts, w: r.valueW })),
          consumption: rows.filter(r => r.type === 'consumption').map(r => ({ ts: r.ts, w: r.valueW })),
          lastFetchAt: state.forecast?.lastFetchAt || null,
          total: rows.length
        });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/forecast/refresh' && req.method === 'POST') {
      ctx.fetchVrmForecast().catch(e => pushLog('vrm_forecast_manual_error', { error: e.message }));
      return json(res, 202, { ok: true, message: 'Forecast refresh started' });
    }

    if (url.pathname === '/api/epex/refresh' && req.method === 'POST') {
      await ctx.fetchEpexDay();
      return json(res, 200, { ok: state.epex.ok, error: state.epex.error });
    }

    if (url.pathname === '/api/epex/zones' && req.method === 'GET') {
      const cfg = getCfg();
      try {
        const baseUrl = cfg.epex.priceApiUrl || 'https://api.dvhub.de';
        const r = await fetch(`${baseUrl}/api/zones`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        return json(res, 200, data);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (url.pathname === '/api/epex/gaps' && req.method === 'GET') {
      const cfg = getCfg();
      try {
        const baseUrl = cfg.epex.priceApiUrl || 'https://api.dvhub.de';
        const zone = url.searchParams.get('zone') || cfg.epex.bzn || 'DE-LU';
        const r = await fetch(`${baseUrl}/api/prices/gaps?zone=${encodeURIComponent(zone)}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        return json(res, 200, data);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (url.pathname === '/api/epex/backfill' && req.method === 'POST') {
      const cfg = getCfg();
      try {
        const baseUrl = cfg.epex.priceApiUrl || 'https://api.dvhub.de';
        const body = await parseBody(req);
        const zone = body?.zone || cfg.epex.bzn || 'DE-LU';
        const start = body?.start || '2020-01-01';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || isNaN(Date.parse(start))) {
          return json(res, 400, { error: 'Invalid start date, expected YYYY-MM-DD' });
        }
        if (!/^[A-Z]{2}(-[A-Z]{2,4})?$/.test(zone)) {
          return json(res, 400, { error: 'Invalid zone format' });
        }
        const r = await fetch(`${baseUrl}/api/backfill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ zone, start }),
          signal: AbortSignal.timeout(10000)
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        return json(res, 200, data);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (url.pathname === '/api/meter/scan' && req.method === 'POST') {
      const body = await parseBody(req);
      runMeterScan(body).catch((e) => {
        state.scan.running = false;
        state.scan.error = e.message;
      });
      return json(res, 200, { ok: true, running: true });
    }

    if (url.pathname === '/api/meter/scan' && req.method === 'GET') return json(res, 200, state.scan);

    if (url.pathname === '/api/schedule' && req.method === 'GET') {
      return json(res, 200, {
        config: state.schedule.config,
        rules: state.schedule.rules,
        active: state.schedule.active,
        lastWrite: state.schedule.lastWrite
      });
    }

    if (url.pathname === '/api/history/import/status' && req.method === 'GET') {
      return json(res, 200, buildApiHistoryImportStatusResponse());
    }

    if (url.pathname === '/api/history/summary' && req.method === 'GET') {
      if (!ctx.historyApi || typeof ctx.historyApi.getSummary !== 'function') {
        return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      }
      const result = await ctx.historyApi.getSummary({
        view: url.searchParams.get('view'),
        date: url.searchParams.get('date')
      });
      return json(res, result.status, result.body);
    }

    // --- Config POST / Import POST ---
    if ((url.pathname === '/api/config' || url.pathname === '/api/config/import') && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
        return json(res, 400, { ok: false, error: 'config object required' });
      }
      const result = ctx.saveAndApplyConfig(body.config);
      pushLog('config_saved', {
        changedPaths: result.changedPaths.length,
        restartRequired: result.restartRequired,
        source: url.pathname.endsWith('/import') ? 'import' : 'settings'
      });
      const freshCfg = getCfg();
      return json(res, 200, {
        ok: true,
        meta: configMetaPayload(),
        config: redactConfig(ctx.getRawCfg()),
        effectiveConfig: redactConfig(freshCfg),
        changedPaths: result.changedPaths,
        restartRequired: result.restartRequired,
        restartRequiredPaths: result.restartRequiredPaths
      });
    }

    // --- Admin Health ---
    if (url.pathname === '/api/admin/health' && req.method === 'GET') {
      return json(res, 200, await adminHealthPayload());
    }

    // --- Admin Service Restart ---
    if (url.pathname === '/api/admin/service/restart' && req.method === 'POST') {
      if (!ctx.getServiceActionsEnabled()) {
        return json(res, 403, { ok: false, error: 'service actions disabled' });
      }
      const check = await ctx.runServiceCommand(['show', ctx.getServiceName(), '--property=Id', '--value']);
      if (!check.ok) {
        return json(res, 500, { ok: false, error: check.error, command: check.command });
      }
      ctx.scheduleServiceRestart();
      pushLog('service_restart_scheduled', { service: ctx.getServiceName() });
      return json(res, 202, {
        ok: true, accepted: true, service: ctx.getServiceName(),
        message: 'Service restart scheduled'
      });
    }

    // --- Software Update Check ---
    if (url.pathname === '/api/admin/update/check' && req.method === 'GET') {
      if (!ctx.getServiceActionsEnabled()) return json(res, 403, { ok: false, error: 'service actions disabled' });
      try {
        const repoRoot = ctx.getRepoRoot();
        const channel = ctx.getRawCfg().updateChannel || 'stable';
        await execFileAsync('git', ['fetch', '--tags', '--quiet', 'origin'], { cwd: repoRoot, timeout: 15000 });
        const localRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();

        if (channel === 'stable') {
          let currentTag = null;
          try {
            currentTag = (await execFileAsync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          } catch { /* not on a tag */ }
          let latestTag = null;
          try {
            latestTag = (await execFileAsync('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout.trim().split('\n')[0] || null;
          } catch { /* no tags */ }
          let changelog = '';
          if (currentTag && latestTag && currentTag !== latestTag) {
            try { changelog = (await execFileAsync('git', ['log', '--oneline', `${currentTag}..${latestTag}`], { cwd: repoRoot, timeout: 5000 })).stdout.trim(); } catch { /* */ }
          } else if (!currentTag && latestTag) {
            try { changelog = (await execFileAsync('git', ['log', '--oneline', `HEAD..${latestTag}`], { cwd: repoRoot, timeout: 5000 })).stdout.trim(); } catch { /* */ }
          }
          const updateAvailable = latestTag != null && latestTag !== currentTag;
          return json(res, 200, {
            ok: true, channel,
            current: { version: ctx.getAppVersion().versionLabel, tag: currentTag, revision: localRev.slice(0, 7) },
            latest: { tag: latestTag, revision: null },
            updateAvailable,
            changelog: changelog ? changelog.split('\n').filter(Boolean) : []
          });
        } else {
          const remoteRev = (await execFileAsync('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          const behind = Number((await execFileAsync('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim());
          const ahead = Number((await execFileAsync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim());
          let changelog = '';
          if (behind > 0) {
            changelog = (await execFileAsync('git', ['log', '--oneline', 'HEAD..origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          }
          return json(res, 200, {
            ok: true, channel,
            current: { version: ctx.getAppVersion().versionLabel, tag: null, revision: localRev.slice(0, 7) },
            latest: { tag: null, revision: remoteRev.slice(0, 7) },
            behind, ahead,
            updateAvailable: behind > 0,
            changelog: changelog ? changelog.split('\n').filter(Boolean) : []
          });
        }
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- Software Update Apply ---
    if (url.pathname === '/api/admin/update/apply' && req.method === 'POST') {
      if (!ctx.getServiceActionsEnabled()) return json(res, 403, { ok: false, error: 'service actions disabled' });
      try {
        const repoRoot = ctx.getRepoRoot();
        const appDir = ctx.getAppDir();
        const channel = ctx.getRawCfg().updateChannel || 'stable';
        let gitOutput = '';
        const rollbackRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
        const stashResult = await execFileAsync('git', ['stash', '--include-untracked'], { cwd: repoRoot, timeout: 10000 }).catch(() => ({ stdout: 'No local changes' }));
        const hasStash = !stashResult.stdout.includes('No local changes');

        if (channel === 'stable') {
          await execFileAsync('git', ['fetch', '--tags', 'origin'], { cwd: repoRoot, timeout: 15000 });
          const latestTag = (await execFileAsync('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout.trim().split('\n')[0];
          if (!latestTag) throw new Error('No release tags found');
          const checkout = await execFileAsync('git', ['checkout', latestTag], { cwd: repoRoot, timeout: 15000 });
          gitOutput = `Checked out ${latestTag}: ${checkout.stderr.trim()}`;
        } else {
          await execFileAsync('git', ['fetch', 'origin'], { cwd: repoRoot, timeout: 15000 });
          await execFileAsync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoRoot, timeout: 15000 });
          const pull = await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: repoRoot, timeout: 30000 });
          gitOutput = pull.stdout.trim();
        }

        try {
          const npmInstall = await execFileAsync('npm', ['install', '--omit=dev'], { cwd: appDir, timeout: 60000 });
          await execFileAsync('node', ['--check', 'server.js'], { cwd: appDir, timeout: 5000 });
          pushLog('update_applied', {
            channel,
            gitOutput: gitOutput.split('\n').slice(0, 5).join('\n'),
            npmOutput: npmInstall.stdout.trim().split('\n').slice(-3).join('\n')
          });
        } catch (installErr) {
          pushLog('update_rollback', { reason: installErr.message, rollbackTo: rollbackRev.slice(0, 7) });
          await execFileAsync('git', ['checkout', rollbackRev], { cwd: repoRoot, timeout: 15000 });
          await execFileAsync('npm', ['install', '--omit=dev'], { cwd: appDir, timeout: 60000 }).catch(() => {});
          if (hasStash) await execFileAsync('git', ['stash', 'pop'], { cwd: repoRoot, timeout: 10000 }).catch(() => {});
          throw new Error(`Update rolled back (npm/syntax failed): ${installErr.message}`);
        }

        if (hasStash) {
          pushLog('update_stash_discarded', { note: 'local changes were stashed before update and not restored' });
        }

        ctx.scheduleServiceRestart();
        pushLog('service_restart_scheduled', { service: ctx.getServiceName(), reason: 'update' });
        return json(res, 200, {
          ok: true, channel,
          gitOutput,
          rolledBackFrom: rollbackRev.slice(0, 7),
          message: 'Update applied, service restart scheduled'
        });
      } catch (e) {
        pushLog('update_error', { error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- Update Channel ---
    if (url.pathname === '/api/admin/update/channel' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const channel = body?.channel;
        if (channel !== 'stable' && channel !== 'dev') {
          return json(res, 400, { ok: false, error: 'channel must be "stable" or "dev"' });
        }
        const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
        next.updateChannel = channel;
        ctx.saveAndApplyConfig(next);

        if (ctx.getServiceActionsEnabled()) {
          const repoRoot = ctx.getRepoRoot();
          const appDir = ctx.getAppDir();
          let gitOutput = '';
          const rollbackRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          const stashResult = await execFileAsync('git', ['stash', '--include-untracked'], { cwd: repoRoot, timeout: 10000 }).catch(() => ({ stdout: 'No local changes' }));
          const hasStash = !stashResult.stdout.includes('No local changes');
          await execFileAsync('git', ['fetch', '--tags', 'origin'], { cwd: repoRoot, timeout: 15000 });

          if (channel === 'stable') {
            const latestTag = (await execFileAsync('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout.trim().split('\n')[0];
            if (!latestTag) throw new Error('No release tags found');
            await execFileAsync('git', ['checkout', latestTag], { cwd: repoRoot, timeout: 15000 });
            gitOutput = `Switched to stable: ${latestTag}`;
          } else {
            await execFileAsync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoRoot, timeout: 15000 });
            gitOutput = 'Switched to dev: origin/main';
          }
          try {
            await execFileAsync('npm', ['install', '--omit=dev'], { cwd: appDir, timeout: 60000 });
            await execFileAsync('node', ['--check', 'server.js'], { cwd: appDir, timeout: 5000 });
          } catch (installErr) {
            pushLog('channel_switch_rollback', { reason: installErr.message, rollbackTo: rollbackRev.slice(0, 7) });
            await execFileAsync('git', ['checkout', rollbackRev], { cwd: repoRoot, timeout: 15000 });
            await execFileAsync('npm', ['install', '--omit=dev'], { cwd: appDir, timeout: 60000 }).catch(() => {});
            if (hasStash) await execFileAsync('git', ['stash', 'pop'], { cwd: repoRoot, timeout: 10000 }).catch(() => {});
            throw new Error(`Channel switch rolled back (npm/syntax failed): ${installErr.message}`);
          }
          if (hasStash) {
            pushLog('channel_switch_stash_discarded', { note: 'local changes were stashed before switch and not restored' });
          }
          pushLog('update_channel_changed', { channel, gitOutput });
          ctx.scheduleServiceRestart();
          pushLog('service_restart_scheduled', { service: ctx.getServiceName(), reason: 'channel_switch' });
          return json(res, 200, {
            ok: true, channel, gitOutput,
            message: `Channel switched to ${channel}, service restart scheduled`
          });
        }

        pushLog('update_channel_changed', { channel, note: 'config-only, service actions disabled' });
        return json(res, 200, {
          ok: true, channel,
          message: `Channel preference saved to ${channel}. Git switch will happen on next update.`
        });
      } catch (e) {
        pushLog('update_channel_error', { error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- EOS Apply ---
    if (url.pathname === '/api/integration/eos/apply' && req.method === 'POST') {
      const body = await parseBody(req);
      const results = [];
      if (body.gridSetpointW !== undefined && Number.isFinite(Number(body.gridSetpointW))) {
        results.push(await ctx.applyControlTarget('gridSetpointW', Number(body.gridSetpointW), 'eos_optimization'));
      }
      if (body.chargeCurrentA !== undefined && Number.isFinite(Number(body.chargeCurrentA))) {
        results.push(await ctx.applyControlTarget('chargeCurrentA', Number(body.chargeCurrentA), 'eos_optimization'));
      }
      if (body.minSocPct !== undefined && Number.isFinite(Number(body.minSocPct))) {
        results.push(await ctx.applyControlTarget('minSocPct', Number(body.minSocPct), 'eos_optimization'));
      }
      pushLog('eos_apply', { targets: results.length, body });
      telemetrySafeWrite(() => ctx.telemetryStore?.writeOptimizerRun(buildOptimizerRunPayload({
        optimizer: 'eos',
        body,
        source: 'eos_apply'
      })));
      return json(res, 200, { ok: true, results });
    }

    // --- EMHASS Apply ---
    if (url.pathname === '/api/integration/emhass/apply' && req.method === 'POST') {
      const body = await parseBody(req);
      const results = [];
      if (body.gridSetpointW !== undefined && Number.isFinite(Number(body.gridSetpointW))) {
        results.push(await ctx.applyControlTarget('gridSetpointW', Number(body.gridSetpointW), 'emhass_optimization'));
      }
      if (body.chargeCurrentA !== undefined && Number.isFinite(Number(body.chargeCurrentA))) {
        results.push(await ctx.applyControlTarget('chargeCurrentA', Number(body.chargeCurrentA), 'emhass_optimization'));
      }
      if (body.minSocPct !== undefined && Number.isFinite(Number(body.minSocPct))) {
        results.push(await ctx.applyControlTarget('minSocPct', Number(body.minSocPct), 'emhass_optimization'));
      }
      pushLog('emhass_apply', { targets: results.length, body });
      telemetrySafeWrite(() => ctx.telemetryStore?.writeOptimizerRun(buildOptimizerRunPayload({
        optimizer: 'emhass',
        body,
        source: 'emhass_apply'
      })));
      return json(res, 200, { ok: true, results });
    }

    // --- History Import ---
    if (url.pathname === '/api/history/import' && req.method === 'POST') {
      if (!ctx.historyImportManager) return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      const body = await parseBody(req);
      if (body.mode === 'backfill') {
        ctx.assertValidRuntimeCommand('history_backfill', { mode: 'gap', requestedBy: 'history_import_endpoint' });
        const result = await ctx.historyImportManager.backfillHistoryFromConfiguredSource({ mode: 'gap' });
        return json(res, result.ok ? 200 : 400, result);
      }
      const provider = String(body.provider || getCfg().telemetry?.historyImport?.provider || 'vrm');
      ctx.assertValidRuntimeCommand('history_import', {
        provider,
        requestedFrom: body.requestedFrom ?? body.start ?? null,
        requestedTo: body.requestedTo ?? body.end ?? null,
        interval: body.interval || '15mins'
      });
      const result = Array.isArray(body.rows) && body.rows.length
        ? ctx.historyImportManager.importSamples({
          provider,
          requestedFrom: body.requestedFrom ?? null,
          requestedTo: body.requestedTo ?? null,
          sourceAccount: body.sourceAccount ?? null,
          rows: body.rows
        })
        : await ctx.historyImportManager.importFromConfiguredSource({
          start: body.requestedFrom ?? body.start,
          end: body.requestedTo ?? body.end,
          interval: body.interval || '15mins'
        });
      return json(res, result.ok ? 200 : 400, result);
    }

    // --- History Backfill VRM ---
    if (url.pathname === '/api/history/backfill/vrm' && req.method === 'POST') {
      if (!ctx.historyImportManager) return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      const body = await parseBody(req);
      const requestedMode = body?.mode === 'full' ? 'full' : 'gap';
      ctx.assertValidRuntimeCommand('history_backfill', {
        mode: requestedMode,
        requestedBy: 'history_backfill_endpoint'
      });
      const result = await ctx.historyImportManager.backfillHistoryFromConfiguredSource({ ...body, mode: requestedMode });
      return json(res, result.ok ? 200 : 400, result);
    }

    // --- History Backfill Prices ---
    if (url.pathname === '/api/history/backfill/prices' && req.method === 'POST') {
      if (!ctx.historyApi || typeof ctx.historyApi.postPriceBackfill !== 'function') {
        return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      }
      const body = await parseBody(req);
      const result = await ctx.historyApi.postPriceBackfill(body || {});
      return json(res, result.status, result.body);
    }

    // --- Schedule Rules POST ---
    if (url.pathname === '/api/schedule/rules' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!Array.isArray(body.rules)) return json(res, 400, { ok: false, error: 'rules array required' });
      const validRules = body.rules.filter((rule) => {
        if (typeof rule !== 'object' || rule === null) return false;
        if (typeof rule.target !== 'string') return false;
        if (rule.value !== undefined && !Number.isFinite(Number(rule.value))) return false;
        return true;
      });
      if (validRules.length !== body.rules.length) return json(res, 400, { ok: false, error: 'invalid rule structure' });
      const incomingManualRules = validRules.filter((r) => !isSmallMarketAutomationRule(r));
      const existingAutomationRules = state.schedule.rules.filter((r) => isSmallMarketAutomationRule(r));
      const existingDcFeedRules = state.schedule.rules.filter((r) => r.target === 'feedExcessDcPv' && !isSmallMarketAutomationRule(r));
      const incomingDcFeedRules = incomingManualRules.filter((r) => r.target === 'feedExcessDcPv');
      const incomingOtherRules = incomingManualRules.filter((r) => r.target !== 'feedExcessDcPv');
      const dcFeedRules = incomingDcFeedRules.length ? incomingDcFeedRules : existingDcFeedRules;
      state.schedule.rules = [...incomingOtherRules, ...dcFeedRules, ...existingAutomationRules];
      pushLog('schedule_rules_updated', { manual: incomingOtherRules.length, dcFeed: dcFeedRules.length, automation: existingAutomationRules.length });
      ctx.persistConfig();
      return json(res, 200, { ok: true, count: state.schedule.rules.length });
    }

    // --- Schedule Config POST ---
    if (url.pathname === '/api/schedule/config' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.defaultGridSetpointW !== undefined) {
        const v = Number(body.defaultGridSetpointW);
        if (!Number.isFinite(v)) return json(res, 400, { ok: false, error: 'defaultGridSetpointW invalid' });
        state.schedule.config.defaultGridSetpointW = v;
      }
      if (body.defaultChargeCurrentA !== undefined) {
        const v = Number(body.defaultChargeCurrentA);
        if (!Number.isFinite(v)) return json(res, 400, { ok: false, error: 'defaultChargeCurrentA invalid' });
        state.schedule.config.defaultChargeCurrentA = v;
      }
      if (body.defaultFeedExcessDcPv !== undefined) {
        const v = Number(body.defaultFeedExcessDcPv);
        if (v !== 0 && v !== 1) return json(res, 400, { ok: false, error: 'defaultFeedExcessDcPv must be 0 or 1' });
        state.schedule.config.defaultFeedExcessDcPv = v;
      }
      pushLog('schedule_config_updated', { config: state.schedule.config });
      ctx.persistConfig();
      return json(res, 200, { ok: true, config: state.schedule.config });
    }

    // --- Schedule Automation Config GET ---
    if (url.pathname === '/api/schedule/automation/config' && req.method === 'GET') {
      return json(res, 200, { ok: true, config: getCfg().schedule?.smallMarketAutomation || {} });
    }

    // --- Schedule Automation Config POST ---
    if (url.pathname === '/api/schedule/automation/config' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json(res, 400, { ok: false, error: 'invalid body' });
      }
      const allowedKeys = new Set([
        'enabled', 'searchWindowStart', 'searchWindowEnd', 'targetSlotCount',
        'maxDischargeW', 'batteryCapacityKwh', 'inverterEfficiencyPct',
        'minSocPct', 'aggressivePremiumPct', 'location', 'stages'
      ]);
      const filteredBody = Object.fromEntries(
        Object.entries(body).filter(([key]) => allowedKeys.has(key))
      );
      const current = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      current.schedule = current.schedule || {};
      current.schedule.smallMarketAutomation = {
        ...current.schedule.smallMarketAutomation,
        ...filteredBody
      };
      ctx.saveAndApplyConfig(current);
      ctx.regenerateSmallMarketAutomationRules().catch(e => pushLog('sma_regen_error', { error: e.message }));
      return json(res, 200, { ok: true, config: getCfg().schedule.smallMarketAutomation });
    }

    // --- Control Write POST ---
    if (url.pathname === '/api/control/write' && req.method === 'POST') {
      const body = await parseBody(req);
      const target = String(body.target || '');
      const value = Number(body.value);
      ctx.assertValidRuntimeCommand('control_write', { target, value });
      state.schedule.manualOverride[target] = { value, at: Date.now() };
      const result = await ctx.applyControlTarget(target, value, 'api_manual_write');
      return json(res, result.ok ? 200 : 500, result);
    }

    // Unmatched route -- return false so orchestrator can fall through to static files
    return false;
  }

  // Expose response builders to orchestrator for buildCurrentStatusPayload
  // (ctx is mutable -- orchestrator reads these after createApiRoutes returns)
  ctx.costSummary = costSummary;
  ctx.userEnergyPricingSummary = userEnergyPricingSummary;

  return { handleRequest, serveStatic };
}
