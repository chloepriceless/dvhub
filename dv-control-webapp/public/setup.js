const common = typeof window !== 'undefined' ? window.PlexLiteCommon || {} : {};
const { apiFetch, setStoredApiToken } = common;

const SETUP_STEP_DEFINITIONS = [
  {
    id: 'basics',
    index: 0,
    label: 'Schritt 1',
    title: 'Webserver & Sicherheit',
    description: 'Grundlegende Einstellungen fuer Webzugriff und API-Schutz.',
    fields: ['httpPort', 'apiToken']
  },
  {
    id: 'transport',
    index: 1,
    label: 'Schritt 2',
    title: 'Victron Verbindung',
    description: 'Transport, GX-Verbindung und MQTT-Basisdaten.',
    fields: [
      'victron.transport',
      'victron.host',
      'victron.port',
      'victron.unitId',
      'victron.timeoutMs',
      'victron.mqtt.broker',
      'victron.mqtt.portalId',
      'victron.mqtt.keepaliveIntervalMs'
    ]
  },
  {
    id: 'dv',
    index: 2,
    label: 'Schritt 3',
    title: 'DV & Meter',
    description: 'Proxy-Port, Meterblock und Vorzeichenlogik fuer Netzwerte.',
    fields: [
      'modbusListenHost',
      'modbusListenPort',
      'gridPositiveMeans',
      'meter.fc',
      'meter.address',
      'meter.quantity',
      'dvControl.enabled'
    ]
  },
  {
    id: 'services',
    index: 3,
    label: 'Schritt 4',
    title: 'Preise & Zusatzdienste',
    description: 'Zeitzone sowie optionale Preis- und Logging-Dienste.',
    fields: [
      'schedule.timezone',
      'epex.enabled',
      'epex.bzn',
      'influx.enabled',
      'influx.url',
      'influx.db'
    ]
  }
];

let currentConfig = {};
let currentEffectiveConfig = {};
let currentMeta = {};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getParts(path) {
  return String(path).split('.').filter(Boolean);
}

function hasPath(obj, path) {
  let current = obj;
  for (const part of getParts(path)) {
    if (!current || typeof current !== 'object' || !(part in current)) return false;
    current = current[part];
  }
  return true;
}

function getPath(obj, path, fallback = undefined) {
  let current = obj;
  for (const part of getParts(path)) {
    if (!current || typeof current !== 'object' || !(part in current)) return fallback;
    current = current[part];
  }
  return current;
}

function setPath(obj, path, value) {
  const parts = getParts(path);
  let current = obj;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts[0]] = value;
}

function resolveSetupStepId(stepId) {
  const ids = new Set(SETUP_STEP_DEFINITIONS.map((step) => step.id));
  return ids.has(stepId) ? stepId : SETUP_STEP_DEFINITIONS[0].id;
}

function buildSetupSteps() {
  return SETUP_STEP_DEFINITIONS.map((step) => ({
    ...step,
    fields: Array.from(step.fields)
  }));
}

function resolveWizardValue(state, path, fallback = undefined) {
  if (hasPath(state?.draftConfig, path)) return getPath(state.draftConfig, path);
  if (hasPath(state?.effectiveConfig, path)) return getPath(state.effectiveConfig, path);
  return fallback;
}

function getSetupTransportMode(state) {
  return resolveWizardValue(state, 'victron.transport', 'modbus') === 'mqtt' ? 'mqtt' : 'modbus';
}

function buildValidationResult(summary) {
  const byField = {};
  const byStep = {};

  for (const step of SETUP_STEP_DEFINITIONS) {
    byStep[step.id] = { valid: true, errors: [] };
  }

  for (const entry of summary) {
    byStep[entry.stepId].valid = false;
    byStep[entry.stepId].errors.push(entry.message);
    if (!byField[entry.path]) byField[entry.path] = [];
    byField[entry.path].push(entry.message);
  }

  return {
    fields: byField,
    steps: byStep,
    summary,
    isBlocking: summary.length > 0
  };
}

function pushValidationError(summary, stepId, path, message) {
  summary.push({ stepId, path, message });
}

function validateIntegerInRange(value, min, max) {
  return Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
}

function validateSetupWizardState(state) {
  const summary = [];
  const transport = getSetupTransportMode(state);
  const requireText = (stepId, path, message) => {
    if (String(resolveWizardValue(state, path, '') || '').trim()) return;
    pushValidationError(summary, stepId, path, message);
  };
  const requireInteger = (stepId, path, min, max, message) => {
    if (validateIntegerInRange(resolveWizardValue(state, path), min, max)) return;
    pushValidationError(summary, stepId, path, message);
  };
  const requireOption = (stepId, path, options, message) => {
    if (options.includes(resolveWizardValue(state, path))) return;
    pushValidationError(summary, stepId, path, message);
  };

  requireInteger('basics', 'httpPort', 1, 65535, 'Bitte einen gueltigen Port zwischen 1 und 65535 eingeben.');

  requireOption('transport', 'victron.transport', ['modbus', 'mqtt'], 'Bitte einen gueltigen Victron-Transport waehlen.');
  requireText('transport', 'victron.host', 'Bitte den GX-Host oder DNS-Namen angeben.');
  if (transport === 'modbus') {
    requireInteger('transport', 'victron.port', 1, 65535, 'Bitte einen gueltigen GX-Port zwischen 1 und 65535 eingeben.');
    requireInteger('transport', 'victron.unitId', 0, 255, 'Bitte eine gueltige Unit ID zwischen 0 und 255 eingeben.');
    requireInteger('transport', 'victron.timeoutMs', 100, 60000, 'Bitte einen gueltigen Timeout zwischen 100 und 60000 ms eingeben.');
  } else {
    requireText('transport', 'victron.mqtt.portalId', 'Bitte die Victron Portal ID fuer MQTT angeben.');
    requireInteger('transport', 'victron.mqtt.keepaliveIntervalMs', 1000, 600000, 'Bitte ein gueltiges Keepalive zwischen 1000 und 600000 ms eingeben.');
  }

  requireText('dv', 'modbusListenHost', 'Bitte den Modbus-Listen-Host angeben.');
  requireInteger('dv', 'modbusListenPort', 1, 65535, 'Bitte einen gueltigen Port zwischen 1 und 65535 eingeben.');
  requireOption('dv', 'gridPositiveMeans', ['feed_in', 'grid_import'], 'Bitte eine gueltige Vorzeichenlogik waehlen.');
  requireOption('dv', 'meter.fc', [3, 4], 'Bitte einen gueltigen Meter Function Code waehlen.');
  requireInteger('dv', 'meter.address', 0, 65535, 'Bitte eine gueltige Meter-Startadresse zwischen 0 und 65535 eingeben.');
  requireInteger('dv', 'meter.quantity', 1, 125, 'Bitte eine gueltige Registeranzahl zwischen 1 und 125 eingeben.');

  requireText('services', 'schedule.timezone', 'Bitte eine Zeitzone fuer den Zeitplan angeben.');
  if (resolveWizardValue(state, 'epex.enabled', false)) {
    requireText('services', 'epex.bzn', 'Bitte die BZN fuer den EPEX-Dienst angeben.');
  }
  if (resolveWizardValue(state, 'influx.enabled', false)) {
    requireText('services', 'influx.url', 'Bitte die Influx-URL angeben.');
    requireText('services', 'influx.db', 'Bitte die Influx-Datenbank angeben.');
  }

  return {
    ...state,
    transportMode: transport,
    validation: buildValidationResult(summary)
  };
}

function createSetupWizardState(payload = {}) {
  const steps = buildSetupSteps();
  const state = {
    draftConfig: clone(payload.config || {}),
    effectiveConfig: clone(payload.effectiveConfig || {}),
    meta: clone(payload.meta || {}),
    steps,
    stepOrder: steps.map((step) => step.id),
    activeStepId: resolveSetupStepId(payload.activeStepId),
    visitedStepIds: Array.from(new Set([resolveSetupStepId(payload.activeStepId)])),
    completedStepIds: [],
    transportMode: 'modbus',
    validation: buildValidationResult([])
  };
  return validateSetupWizardState(state);
}

function updateSetupDraftValue(state, path, value) {
  const nextDraft = clone(state?.draftConfig || {});
  setPath(nextDraft, path, value);
  if (path === 'schedule.timezone') {
    setPath(nextDraft, 'epex.timezone', value);
  }
  return validateSetupWizardState({
    ...state,
    draftConfig: nextDraft
  });
}

function setActiveSetupStep(state, requestedStepId) {
  const activeStepId = resolveSetupStepId(requestedStepId);
  return {
    ...state,
    activeStepId,
    visitedStepIds: Array.from(new Set([...(state?.visitedStepIds || []), activeStepId]))
  };
}

function getCurrentStepIndex(state) {
  return Math.max(0, (state?.stepOrder || []).indexOf(state?.activeStepId));
}

function goToNextSetupStep(state) {
  const validatedState = validateSetupWizardState(state);
  const currentStepId = validatedState.activeStepId;
  if (!validatedState.validation.steps[currentStepId]?.valid) return validatedState;
  const currentIndex = getCurrentStepIndex(validatedState);
  const nextStepId = validatedState.stepOrder[currentIndex + 1] || currentStepId;
  return {
    ...setActiveSetupStep(validatedState, nextStepId),
    completedStepIds: Array.from(new Set([...(validatedState.completedStepIds || []), currentStepId]))
  };
}

function goToPreviousSetupStep(state) {
  const currentIndex = getCurrentStepIndex(state);
  const previousStepId = state?.stepOrder?.[currentIndex - 1] || state?.activeStepId;
  return setActiveSetupStep(state, previousStepId);
}

const setupWizardHelpers = {
  SETUP_STEP_DEFINITIONS,
  createSetupWizardState,
  getSetupTransportMode,
  goToNextSetupStep,
  goToPreviousSetupStep,
  setActiveSetupStep,
  updateSetupDraftValue,
  validateSetupWizardState
};

if (typeof globalThis !== 'undefined') {
  globalThis.PlexLiteSetupWizard = setupWizardHelpers;
}

function setBanner(message, kind = 'info') {
  const element = document.getElementById('setupBanner');
  if (!element) return;
  element.textContent = message;
  element.className = `status-banner ${kind}`;
}

function setValue(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  if (element.type === 'checkbox') element.checked = Boolean(value);
  else element.value = value ?? '';
}

function getValue(id) {
  const element = document.getElementById(id);
  if (!element) return '';
  if (element.type === 'checkbox') return element.checked;
  return element.value;
}

function updateMeta() {
  const element = document.getElementById('setupMeta');
  if (!element) return;
  const parts = [
    `Datei: ${currentMeta.path || '-'}`,
    `Vorhanden: ${currentMeta.exists ? 'Ja' : 'Nein'}`,
    `Gueltig: ${currentMeta.valid ? 'Ja' : 'Nein'}`
  ];
  if (currentMeta.parseError) parts.push(`Parse Fehler: ${currentMeta.parseError}`);
  if (Array.isArray(currentMeta.warnings) && currentMeta.warnings.length) parts.push(`Warnungen: ${currentMeta.warnings.length}`);
  element.textContent = parts.join(' | ');
}

function updateTransportVisibility() {
  const transport = getValue('victronTransport');
  const mqttFields = document.getElementById('mqttFields');
  if (mqttFields) mqttFields.style.display = transport === 'mqtt' ? 'grid' : 'none';
}

function applyConfigToForm(config, payload) {
  currentConfig = config || {};
  currentEffectiveConfig = payload?.effectiveConfig || {};
  currentMeta = payload?.meta || {};

  setValue('httpPort', currentEffectiveConfig.httpPort);
  setValue('apiToken', currentEffectiveConfig.apiToken);
  setValue('victronTransport', currentEffectiveConfig.victron?.transport || 'modbus');
  setValue('victronHost', currentEffectiveConfig.victron?.host);
  setValue('victronPort', currentEffectiveConfig.victron?.port);
  setValue('victronUnitId', currentEffectiveConfig.victron?.unitId);
  setValue('victronTimeoutMs', currentEffectiveConfig.victron?.timeoutMs);
  setValue('mqttBroker', currentEffectiveConfig.victron?.mqtt?.broker);
  setValue('mqttPortalId', currentEffectiveConfig.victron?.mqtt?.portalId);
  setValue('mqttKeepalive', currentEffectiveConfig.victron?.mqtt?.keepaliveIntervalMs);
  setValue('modbusListenHost', currentEffectiveConfig.modbusListenHost);
  setValue('modbusListenPort', currentEffectiveConfig.modbusListenPort);
  setValue('gridPositiveMeans', currentEffectiveConfig.gridPositiveMeans);
  setValue('meterFc', currentEffectiveConfig.meter?.fc);
  setValue('meterAddress', currentEffectiveConfig.meter?.address);
  setValue('meterQuantity', currentEffectiveConfig.meter?.quantity);
  setValue('dvControlEnabled', currentEffectiveConfig.dvControl?.enabled);
  setValue('scheduleTimezone', currentEffectiveConfig.schedule?.timezone);
  setValue('epexEnabled', currentEffectiveConfig.epex?.enabled);
  setValue('epexBzn', currentEffectiveConfig.epex?.bzn);
  setValue('influxEnabled', currentEffectiveConfig.influx?.enabled);
  setValue('influxUrl', currentEffectiveConfig.influx?.url);
  setValue('influxDb', currentEffectiveConfig.influx?.db);

  updateTransportVisibility();
  updateMeta();
}

function collectConfig() {
  const next = clone(currentConfig || {});
  next.httpPort = Number(getValue('httpPort'));
  next.apiToken = String(getValue('apiToken') || '');
  next.modbusListenHost = String(getValue('modbusListenHost') || '0.0.0.0');
  next.modbusListenPort = Number(getValue('modbusListenPort'));
  next.gridPositiveMeans = String(getValue('gridPositiveMeans') || 'feed_in');
  next.schedule = next.schedule || {};
  next.schedule.timezone = String(getValue('scheduleTimezone') || 'Europe/Berlin');

  next.victron = next.victron || {};
  next.victron.transport = String(getValue('victronTransport') || 'modbus');
  next.victron.host = String(getValue('victronHost') || '');
  next.victron.port = Number(getValue('victronPort'));
  next.victron.unitId = Number(getValue('victronUnitId'));
  next.victron.timeoutMs = Number(getValue('victronTimeoutMs'));
  next.victron.mqtt = next.victron.mqtt || {};
  next.victron.mqtt.broker = String(getValue('mqttBroker') || '');
  next.victron.mqtt.portalId = String(getValue('mqttPortalId') || '');
  next.victron.mqtt.keepaliveIntervalMs = Number(getValue('mqttKeepalive'));

  next.meter = next.meter || {};
  next.meter.fc = Number(getValue('meterFc'));
  next.meter.address = Number(getValue('meterAddress'));
  next.meter.quantity = Number(getValue('meterQuantity'));

  next.dvControl = next.dvControl || {};
  next.dvControl.enabled = Boolean(getValue('dvControlEnabled'));

  next.epex = next.epex || {};
  next.epex.enabled = Boolean(getValue('epexEnabled'));
  next.epex.bzn = String(getValue('epexBzn') || 'DE-LU');
  next.epex.timezone = String(getValue('scheduleTimezone') || 'Europe/Berlin');

  next.influx = next.influx || {};
  next.influx.enabled = Boolean(getValue('influxEnabled'));
  next.influx.url = String(getValue('influxUrl') || '');
  next.influx.db = String(getValue('influxDb') || '');

  return next;
}

async function saveSetup(config, source = 'setup') {
  const response = await apiFetch(source === 'import' ? '/api/config/import' : '/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config })
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    setBanner(`Setup konnte nicht gespeichert werden: ${payload.error || response.status}`, 'error');
    return false;
  }

  setStoredApiToken(payload.effectiveConfig?.apiToken || '');
  applyConfigToForm(payload.config, { meta: payload.meta, effectiveConfig: payload.effectiveConfig });
  const restartNote = payload.restartRequired ? ' Einige Einstellungen werden erst nach einem Dienst-Neustart aktiv.' : '';
  setBanner(`Setup gespeichert.${restartNote} Weiterleitung zu den Einstellungen...`, payload.restartRequired ? 'warn' : 'success');
  window.setTimeout(() => {
    window.location.href = '/settings.html?setup=done';
  }, 1200);
  return true;
}

async function loadSetup() {
  const response = await apiFetch('/api/config');
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    setBanner(`Setup konnte nicht geladen werden: ${payload.error || response.status}`, 'error');
    return;
  }
  applyConfigToForm(payload.config, payload);
  if (payload.meta.needsSetup) setBanner('Noch keine gueltige Config gefunden. Bitte die Basisdaten eintragen oder eine vorhandene Config importieren.', 'warn');
  else setBanner('Es existiert bereits eine gueltige Config. Der Assistent kann trotzdem zum schnellen Ueberschreiben genutzt werden.', 'success');
}

async function importSetupFile(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    await saveSetup(parsed, 'import');
  } catch (error) {
    setBanner(`Import fehlgeschlagen: ${error.message}`, 'error');
  }
}

if (typeof document !== 'undefined') {
  document.getElementById('setupSaveBtn')?.addEventListener('click', () => {
    saveSetup(collectConfig()).catch((error) => setBanner(`Setup konnte nicht gespeichert werden: ${error.message}`, 'error'));
  });

  document.getElementById('setupImportBtn')?.addEventListener('click', () => {
    document.getElementById('setupImportFile')?.click();
  });

  document.getElementById('setupImportFile')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    await importSetupFile(file);
    event.target.value = '';
  });

  document.getElementById('victronTransport')?.addEventListener('change', updateTransportVisibility);

  window.addEventListener('plexlite:unauthorized', () => {
    setBanner('API-Zugriff abgelehnt. Wenn ein Token aktiv ist, die Seite mit ?token=DEIN_TOKEN oeffnen.', 'error');
  });

  loadSetup().catch((error) => setBanner(`Setup konnte nicht geladen werden: ${error.message}`, 'error'));
}
