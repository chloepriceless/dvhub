import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import {
  collectChangedPaths,
  detectRestartRequired,
  getConfigDefinition,
  saveConfigFile
} from '../../../config-model.js';
import { discoverSystems as discoverConfiguredSystems } from '../../../system-discovery.js';

const execFileAsync = promisify(execFile);
const CONFIG_DEFINITION = getConfigDefinition();
const REDACTED_PATHS = ['apiToken', 'influx.token', 'telemetry.historyImport.vrmToken'];
const SERVICE_ACTIONS_ENABLED = process.env.DV_ENABLE_SERVICE_ACTIONS === '1';
const SERVICE_NAME = process.env.DV_SERVICE_NAME || 'dvhub.service';
const SERVICE_USE_SUDO = process.env.DV_SERVICE_USE_SUDO !== '0';

function resolveMaybeFn(value) {
  return typeof value === 'function' ? value() : value;
}

function safeExists(path) {
  try {
    return !!path && fs.existsSync(path);
  } catch {
    return false;
  }
}

function deepClone(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
}

function replaceObjectContents(target, source) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function resolveConfigBundle(config) {
  const resolved = resolveMaybeFn(config) || {};
  const meta = resolved && typeof resolved === 'object' && resolved.meta && typeof resolved.meta === 'object'
    ? resolved.meta
    : resolved;
  const effectiveConfig = resolved && typeof resolved === 'object' && resolved.effectiveConfig && typeof resolved.effectiveConfig === 'object'
    ? resolved.effectiveConfig
    : resolved;

  return {
    meta,
    effectiveConfig: effectiveConfig || {}
  };
}

function resolveRawConfig(rawConfig) {
  const resolved = resolveMaybeFn(rawConfig);
  if (resolved && typeof resolved === 'object' && resolved.rawConfig && typeof resolved.rawConfig === 'object') {
    return resolved.rawConfig;
  }
  return resolved || {};
}

function fmtTs(ts) {
  return ts ? new Date(ts).toISOString() : '-';
}

function redactConfig(config) {
  const copy = deepClone(config);
  for (const dotPath of REDACTED_PATHS) {
    const parts = dotPath.split('.');
    let obj = copy;
    for (let index = 0; index < parts.length - 1; index += 1) {
      obj = obj?.[parts[index]];
      if (!obj) break;
    }
    if (obj && parts[parts.length - 1] in obj) obj[parts[parts.length - 1]] = '***';
  }
  return copy;
}

function configMetaPayload({ configPath, config }) {
  const bundle = resolveConfigBundle(config);
  const meta = bundle.meta || {};

  const exists = typeof meta.exists === 'boolean' ? meta.exists : safeExists(configPath);
  const valid = typeof meta.valid === 'boolean' ? meta.valid : true;
  const parseError = meta.parseError ?? null;
  const needsSetup = typeof meta.needsSetup === 'boolean' ? meta.needsSetup : (!exists || !valid);
  const warnings = Array.isArray(meta.warnings) ? meta.warnings : [];

  return {
    path: configPath,
    exists,
    valid,
    parseError,
    needsSetup,
    warnings
  };
}

function configApiPayload(deps) {
  const bundle = resolveConfigBundle(deps.config);
  return {
    ok: true,
    meta: configMetaPayload(deps),
    config: redactConfig(resolveRawConfig(deps.rawConfig)),
    effectiveConfig: redactConfig(bundle.effectiveConfig),
    definition: CONFIG_DEFINITION
  };
}

function keepaliveModbusPayload(getState) {
  const state = resolveMaybeFn(getState) || {};
  return {
    ok: !!state?.keepalive?.modbusLastQuery,
    lastQuery: state?.keepalive?.modbusLastQuery ?? null,
    now: Date.now()
  };
}

function keepalivePulsePayload({ getState, config }) {
  const state = resolveMaybeFn(getState) || {};
  const bundle = resolveConfigBundle(config);
  const rawPeriod = Number(bundle.effectiveConfig?.keepalivePulseSec);
  const periodSec = Number.isFinite(rawPeriod) && rawPeriod > 0 ? rawPeriod : 60;
  const now = Date.now();
  const slot = Math.floor(now / (periodSec * 1000));
  const slotTs = slot * periodSec * 1000;

  if (!state.keepalive) {
    state.keepalive = {
      modbusLastQuery: null,
      appPulse: { periodSec }
    };
  }

  return {
    ok: true,
    periodSec,
    pulseSlot: slot,
    pulseTimestamp: slotTs,
    now
  };
}

function resolveLogRows({ getState, logBuffer }) {
  if (Array.isArray(logBuffer)) return logBuffer;
  if (logBuffer && typeof logBuffer === 'object') {
    if (Array.isArray(logBuffer.rows)) return logBuffer.rows;
    if (typeof logBuffer.toArray === 'function') {
      const rows = logBuffer.toArray();
      if (Array.isArray(rows)) return rows;
    }
  }

  const state = resolveMaybeFn(getState) || {};
  return Array.isArray(state.log) ? state.log : [];
}

function pushLog({ getState, logBuffer }, event, details = {}) {
  const rows = resolveLogRows({ getState, logBuffer });
  if (!Array.isArray(rows)) return;

  rows.push({
    ts: new Date().toISOString(),
    event,
    ...details
  });

  while (rows.length > 1000) rows.shift();
}

function resolveLogLimit(rawLimit, defaultLimit = 20, maxLimit = 200) {
  const limit = Number(rawLimit);
  if (!Number.isFinite(limit) || limit <= 0) return defaultLimit;
  return Math.min(Math.floor(limit), maxLimit);
}

function buildVersionPayload(appVersion) {
  return {
    ok: true,
    version: appVersion?.version,
    revision: appVersion?.revision,
    versionLabel: appVersion?.versionLabel,
    app: appVersion || null
  };
}

function serviceCommandParts(args) {
  if (SERVICE_USE_SUDO) return { command: 'sudo', args: ['-n', 'systemctl', ...args] };
  return { command: 'systemctl', args };
}

async function runServiceCommand(args) {
  const parts = serviceCommandParts(args);
  try {
    const result = await execFileAsync(parts.command, parts.args, { timeout: 8000 });
    return {
      ok: true,
      command: `${parts.command} ${parts.args.join(' ')}`,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim()
    };
  } catch (error) {
    return {
      ok: false,
      command: `${parts.command} ${parts.args.join(' ')}`,
      error: String(error?.stderr || error?.stdout || error?.message || 'command failed').trim()
    };
  }
}

function scheduleServiceRestart() {
  const parts = serviceCommandParts(['restart', SERVICE_NAME]);
  const helperScript = `
    const { spawn } = require('node:child_process');
    setTimeout(() => {
      const child = spawn(${JSON.stringify(parts.command)}, ${JSON.stringify(parts.args)}, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    }, 1200);
  `;
  const helper = spawn(process.execPath, ['-e', helperScript], {
    detached: true,
    stdio: 'ignore'
  });
  helper.unref();
}

async function buildSystemDiscoveryPayload({
  query = {},
  discoverSystems = discoverConfiguredSystems,
  now = () => Date.now()
} = {}) {
  const manufacturer = String(query?.manufacturer || '').trim().toLowerCase();
  const startedAt = now();

  if (!manufacturer) {
    return {
      ok: false,
      manufacturer: '',
      systems: [],
      error: 'manufacturer query required',
      meta: {
        durationMs: Math.max(0, now() - startedAt),
        cached: false
      }
    };
  }

  try {
    const systems = await discoverSystems({ manufacturer });
    return {
      ok: true,
      manufacturer,
      systems,
      meta: {
        durationMs: Math.max(0, now() - startedAt),
        cached: false
      }
    };
  } catch (error) {
    return {
      ok: false,
      manufacturer,
      systems: [],
      error: error?.message || 'system discovery failed',
      meta: {
        durationMs: Math.max(0, now() - startedAt),
        cached: false
      }
    };
  }
}

async function adminHealthPayload(deps) {
  const state = resolveMaybeFn(deps.getState) || {};
  const bundle = resolveConfigBundle(deps.config);
  const cfg = bundle.effectiveConfig || {};
  const meta = configMetaPayload(deps);

  const service = {
    enabled: SERVICE_ACTIONS_ENABLED,
    name: SERVICE_NAME,
    useSudo: SERVICE_USE_SUDO,
    status: 'disabled',
    detail: 'Service-Aktionen sind per ENV deaktiviert.'
  };

  if (SERVICE_ACTIONS_ENABLED) {
    const activeCheck = await runServiceCommand(['is-active', SERVICE_NAME]);
    const showCheck = await runServiceCommand(['show', SERVICE_NAME, '--property=ActiveState,SubState,UnitFileState', '--value']);
    service.status = activeCheck.ok ? (activeCheck.stdout || 'unknown') : 'unavailable';
    service.detail = activeCheck.ok ? 'systemctl erreichbar' : activeCheck.error;
    service.show = showCheck.ok ? showCheck.stdout : showCheck.error;
  }

  return {
    ok: true,
    checkedAt: Date.now(),
    app: deps.appVersion || null,
    service,
    runtime: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      pid: process.pid,
      transport: state?.transport?.type || state?.transportType || 'unknown',
      uptimeSec: Math.round(process.uptime())
    },
    checks: [
      {
        id: 'config',
        label: 'Config Datei',
        ok: meta.exists && meta.valid,
        detail: meta.exists
          ? (meta.valid ? `gueltig unter ${deps.configPath}` : `ungueltig: ${meta.parseError}`)
          : `fehlt: ${deps.configPath}`
      },
      {
        id: 'setup',
        label: 'Setup Status',
        ok: !meta.needsSetup,
        detail: meta.needsSetup ? 'Setup noch nicht abgeschlossen' : 'Setup abgeschlossen'
      },
      {
        id: 'meter',
        label: 'Live Meter Daten',
        ok: !!state?.meter?.ok,
        detail: state?.meter?.ok
          ? `letztes Update ${fmtTs(state?.meter?.updatedAt)}`
          : (state?.meter?.error || 'noch keine erfolgreichen Meter-Daten')
      },
      {
        id: 'epex',
        label: 'EPEX Feed',
        ok: !cfg?.epex?.enabled || !!state?.epex?.ok,
        detail: !cfg?.epex?.enabled
          ? 'deaktiviert'
          : state?.epex?.ok
            ? `letztes Update ${fmtTs(state?.epex?.updatedAt)}`
            : (state?.epex?.error || 'noch keine Preisdaten')
      },
      {
        id: 'service_actions',
        label: 'Restart Aktion',
        ok: SERVICE_ACTIONS_ENABLED && service.status !== 'unavailable',
        detail: SERVICE_ACTIONS_ENABLED
          ? `Service ${SERVICE_NAME}: ${service.status}`
          : 'per ENV deaktiviert'
      },
      {
        id: 'telemetry',
        label: 'Interne Historie',
        ok: !cfg?.telemetry?.enabled || !!state?.telemetry?.ok,
        detail: !cfg?.telemetry?.enabled
          ? 'deaktiviert'
          : state?.telemetry?.dbPath
            ? `DB ${state.telemetry.dbPath}, letztes Schreiben ${fmtTs(state.telemetry.lastWriteAt)}`
            : (state?.telemetry?.lastError || 'noch keine Telemetrie-Initialisierung')
      }
    ]
  };
}

function costSummary({ getState, getSnapshot }) {
  const state = resolveMaybeFn(getState) || {};
  const snapshot = resolveMaybeFn(getSnapshot) || {};

  if (snapshot && typeof snapshot === 'object' && snapshot.costs && typeof snapshot.costs === 'object') {
    return snapshot.costs;
  }

  const energy = state.energy || {};
  const importWh = Number(energy.importWh || 0);
  const exportWh = Number(energy.exportWh || 0);
  const costEur = Number(energy.costEur || 0);
  const revenueEur = Number(energy.revenueEur || 0);

  return {
    day: energy.day ?? null,
    importWh: Number(importWh.toFixed(3)),
    exportWh: Number(exportWh.toFixed(3)),
    importKwh: Number((importWh / 1000).toFixed(4)),
    exportKwh: Number((exportWh / 1000).toFixed(4)),
    costEur: Number(costEur.toFixed(4)),
    revenueEur: Number(revenueEur.toFixed(4)),
    netEur: Number((revenueEur - costEur).toFixed(4)),
    priceNowCtKwh: Number(snapshot?.epex?.summary?.current?.ct_kwh ?? state?.epex?.summary?.current?.ct_kwh ?? 0),
    userImportPriceNowCtKwh: Number(snapshot?.userEnergyPricing?.current?.importPriceCtKwh ?? 0)
  };
}

function saveConfigAndBuildResponse(deps, body, source) {
  if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
    return { status: 400, body: { ok: false, error: 'config object required' } };
  }

  const previousRaw = deepClone(resolveRawConfig(deps.rawConfig));
  const saved = saveConfigFile(deps.configPath, body.config);

  const changedPaths = collectChangedPaths(previousRaw, saved.rawConfig);
  const restartRequiredPaths = detectRestartRequired(changedPaths);
  const restartRequired = restartRequiredPaths.length > 0;

  const nextRaw = deepClone(saved.rawConfig);
  const nextEffective = deepClone(saved.effectiveConfig);

  const resolvedRawConfig = resolveMaybeFn(deps.rawConfig);
  if (resolvedRawConfig && typeof resolvedRawConfig === 'object' && !Array.isArray(resolvedRawConfig)) {
    replaceObjectContents(resolvedRawConfig, nextRaw);
  }

  const resolvedConfig = resolveMaybeFn(deps.config);
  if (resolvedConfig && typeof resolvedConfig === 'object' && !Array.isArray(resolvedConfig)) {
    if (resolvedConfig.effectiveConfig && typeof resolvedConfig.effectiveConfig === 'object') {
      replaceObjectContents(resolvedConfig.effectiveConfig, nextEffective);
      resolvedConfig.exists = saved.exists;
      resolvedConfig.valid = saved.valid;
      resolvedConfig.parseError = saved.parseError;
      resolvedConfig.needsSetup = saved.needsSetup;
      resolvedConfig.warnings = saved.warnings || [];
    } else {
      replaceObjectContents(resolvedConfig, nextEffective);
    }
  }

  // Notify gateway to sync runtime state with updated config
  if (typeof deps.onConfigSaved === 'function') {
    deps.onConfigSaved();
  }

  pushLog(deps, 'config_saved', {
    changedPaths: changedPaths.length,
    restartRequired,
    source
  });

  return {
    status: 200,
    body: {
      ok: true,
      meta: {
        path: deps.configPath,
        exists: saved.exists,
        valid: saved.valid,
        parseError: saved.parseError,
        needsSetup: saved.needsSetup,
        warnings: saved.warnings || []
      },
      config: nextRaw,
      effectiveConfig: nextEffective,
      changedPaths,
      restartRequired,
      restartRequiredPaths
    }
  };
}

function sendRouteResult(reply, result) {
  if (result && typeof result === 'object' && Number.isInteger(result.status) && 'body' in result) {
    return reply.code(result.status).send(result.body);
  }
  return reply.send(result);
}

export function registerStatusRoutes(fastify, deps) {
  const {
    getSnapshot,
    config,
    rawConfig,
    getState,
    configPath,
    logBuffer,
    appVersion
  } = deps;

  fastify.get('/api/status', async () => resolveMaybeFn(getSnapshot) || {});

  fastify.get('/api/config', async () => configApiPayload({
    config,
    rawConfig,
    configPath
  }));

  fastify.post('/api/config', async (request, reply) => {
    const result = saveConfigAndBuildResponse(
      { config, rawConfig, configPath, getState, logBuffer },
      request.body,
      'settings'
    );
    return sendRouteResult(reply, result);
  });

  fastify.post('/api/config/import', async (request, reply) => {
    const result = saveConfigAndBuildResponse(
      { config, rawConfig, configPath, getState, logBuffer },
      request.body,
      'import'
    );
    return sendRouteResult(reply, result);
  });

  fastify.get('/api/config/export', async (request, reply) => {
    reply.header('content-disposition', 'attachment; filename="dvhub-config.json"');
    reply.type('application/json; charset=utf-8');
    return JSON.stringify(resolveRawConfig(rawConfig), null, 2);
  });

  fastify.get('/api/discovery/systems', async (request, reply) => {
    const payload = await buildSystemDiscoveryPayload({ query: request.query || {} });
    return reply.code(payload.ok ? 200 : 400).send(payload);
  });

  fastify.get('/api/admin/health', async () => adminHealthPayload({
    config,
    getState,
    configPath,
    appVersion
  }));

  fastify.post('/api/admin/service/restart', async (request, reply) => {
    if (!SERVICE_ACTIONS_ENABLED) {
      return reply.code(403).send({ ok: false, error: 'service actions disabled' });
    }

    const check = await runServiceCommand(['show', SERVICE_NAME, '--property=Id', '--value']);
    if (!check.ok) {
      return reply.code(500).send({ ok: false, error: check.error, command: check.command });
    }

    scheduleServiceRestart();
    pushLog({ getState, logBuffer }, 'service_restart_scheduled', { service: SERVICE_NAME });
    return reply.code(202).send({
      ok: true,
      accepted: true,
      service: SERVICE_NAME,
      message: 'Service restart scheduled'
    });
  });

  fastify.get('/api/keepalive/modbus', async () => keepaliveModbusPayload(getState));

  fastify.get('/api/keepalive/pulse', async () => keepalivePulsePayload({ getState, config }));

  fastify.get('/api/log', async (request) => {
    const limit = resolveLogLimit(request?.query?.limit);
    const rows = resolveLogRows({ getState, logBuffer });
    return { rows: rows.slice(-limit) };
  });

  fastify.get('/api/version', async () => buildVersionPayload(appVersion));

  fastify.get('/api/costs', async () => costSummary({ getState, getSnapshot }));
}
