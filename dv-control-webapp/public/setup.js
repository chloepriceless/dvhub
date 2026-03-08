const common = typeof window !== 'undefined' ? window.PlexLiteCommon || {} : {};
const { apiFetch, setStoredApiToken } = common;

const SETUP_STEP_DEFINITIONS = [
  {
    id: 'basics',
    index: 0,
    label: 'Schritt 1',
    title: 'Webserver & Sicherheit',
    description: 'Grundlegende Einstellungen fuer Webzugriff und API-Schutz.'
  },
  {
    id: 'transport',
    index: 1,
    label: 'Schritt 2',
    title: 'Victron Verbindung',
    description: 'Transport, GX-Verbindung und MQTT-Basisdaten.'
  },
  {
    id: 'dv',
    index: 2,
    label: 'Schritt 3',
    title: 'DV & Meter',
    description: 'Proxy-Port, Meterblock und Vorzeichenlogik fuer Netzwerte.'
  },
  {
    id: 'services',
    index: 3,
    label: 'Schritt 4',
    title: 'Preise & Zusatzdienste',
    description: 'Zeitzone sowie optionale Preis- und Logging-Dienste.'
  }
];

const SETUP_FIELD_DEFINITIONS = [
  { stepId: 'basics', legacyId: 'httpPort', path: 'httpPort', label: 'HTTP Port', type: 'number', valueType: 'number', min: 1, max: 65535 },
  { stepId: 'basics', legacyId: 'apiToken', path: 'apiToken', label: 'API Token', type: 'text', valueType: 'string' },
  { stepId: 'transport', legacyId: 'victronTransport', path: 'victron.transport', label: 'Transport', type: 'select', valueType: 'string', options: ['modbus', 'mqtt'] },
  { stepId: 'transport', legacyId: 'victronHost', path: 'victron.host', label: 'GX Host', type: 'text', valueType: 'string' },
  { stepId: 'transport', legacyId: 'victronPort', path: 'victron.port', label: 'GX Port', type: 'number', valueType: 'number', min: 1, max: 65535 },
  { stepId: 'transport', legacyId: 'victronUnitId', path: 'victron.unitId', label: 'Unit ID', type: 'number', valueType: 'number', min: 0, max: 255 },
  { stepId: 'transport', legacyId: 'victronTimeoutMs', path: 'victron.timeoutMs', label: 'Timeout (ms)', type: 'number', valueType: 'number', min: 100, max: 60000 },
  { stepId: 'transport', legacyId: 'mqttBroker', path: 'victron.mqtt.broker', label: 'MQTT Broker URL', type: 'text', valueType: 'string' },
  { stepId: 'transport', legacyId: 'mqttPortalId', path: 'victron.mqtt.portalId', label: 'Portal ID', type: 'text', valueType: 'string' },
  { stepId: 'transport', legacyId: 'mqttKeepalive', path: 'victron.mqtt.keepaliveIntervalMs', label: 'Keepalive (ms)', type: 'number', valueType: 'number', min: 1000, max: 600000 },
  { stepId: 'dv', legacyId: 'modbusListenHost', path: 'modbusListenHost', label: 'Modbus Listen Host', type: 'text', valueType: 'string' },
  { stepId: 'dv', legacyId: 'modbusListenPort', path: 'modbusListenPort', label: 'Modbus Listen Port', type: 'number', valueType: 'number', min: 1, max: 65535 },
  { stepId: 'dv', legacyId: 'gridPositiveMeans', path: 'gridPositiveMeans', label: 'Grid Vorzeichen', type: 'select', valueType: 'string', options: ['feed_in', 'grid_import'] },
  { stepId: 'dv', legacyId: 'meterFc', path: 'meter.fc', label: 'Meter FC', type: 'select', valueType: 'number', options: [4, 3] },
  { stepId: 'dv', legacyId: 'meterAddress', path: 'meter.address', label: 'Meter Startadresse', type: 'number', valueType: 'number', min: 0, max: 65535 },
  { stepId: 'dv', legacyId: 'meterQuantity', path: 'meter.quantity', label: 'Meter Registeranzahl', type: 'number', valueType: 'number', min: 1, max: 125 },
  { stepId: 'dv', legacyId: 'dvControlEnabled', path: 'dvControl.enabled', label: 'DV Control aktivieren', type: 'boolean', valueType: 'boolean' },
  { stepId: 'services', legacyId: 'scheduleTimezone', path: 'schedule.timezone', label: 'Zeitzone', type: 'text', valueType: 'string' },
  { stepId: 'services', legacyId: 'epexEnabled', path: 'epex.enabled', label: 'EPEX aktiv', type: 'boolean', valueType: 'boolean' },
  { stepId: 'services', legacyId: 'epexBzn', path: 'epex.bzn', label: 'BZN', type: 'text', valueType: 'string' },
  { stepId: 'services', legacyId: 'influxEnabled', path: 'influx.enabled', label: 'Influx aktiv', type: 'boolean', valueType: 'boolean' },
  { stepId: 'services', legacyId: 'influxUrl', path: 'influx.url', label: 'Influx URL', type: 'text', valueType: 'string' },
  { stepId: 'services', legacyId: 'influxDb', path: 'influx.db', label: 'Influx DB', type: 'text', valueType: 'string' }
];

let setupWizardState = createSetupWizardState();

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
  const validIds = new Set(SETUP_STEP_DEFINITIONS.map((step) => step.id));
  return validIds.has(stepId) ? stepId : SETUP_STEP_DEFINITIONS[0].id;
}

function getSetupFieldsForStep(stepId) {
  return SETUP_FIELD_DEFINITIONS.filter((field) => field.stepId === stepId);
}

function buildSetupSteps() {
  return SETUP_STEP_DEFINITIONS.map((step) => {
    const fields = getSetupFieldsForStep(step.id);
    return {
      ...step,
      fields: fields.map((field) => field.path),
      fieldCount: fields.length
    };
  });
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
  const fields = {};
  const steps = {};
  for (const step of SETUP_STEP_DEFINITIONS) {
    steps[step.id] = { valid: true, errors: [] };
  }
  for (const entry of summary) {
    steps[entry.stepId].valid = false;
    steps[entry.stepId].errors.push(entry.message);
    if (!fields[entry.path]) fields[entry.path] = [];
    fields[entry.path].push(entry.message);
  }
  return {
    fields,
    steps,
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
  const initialStepId = resolveSetupStepId(payload.activeStepId);
  const state = {
    draftConfig: clone(payload.config || {}),
    effectiveConfig: clone(payload.effectiveConfig || {}),
    meta: clone(payload.meta || {}),
    steps,
    stepOrder: steps.map((step) => step.id),
    activeStepId: initialStepId,
    visitedStepIds: Array.from(new Set([initialStepId])),
    completedStepIds: [],
    transportMode: 'modbus',
    validation: buildValidationResult([])
  };
  return validateSetupWizardState(state);
}

function updateSetupDraftValue(state, path, value) {
  const nextDraft = clone(state?.draftConfig || {});
  setPath(nextDraft, path, value);
  if (path === 'schedule.timezone') setPath(nextDraft, 'epex.timezone', value);
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
  SETUP_FIELD_DEFINITIONS,
  SETUP_STEP_DEFINITIONS,
  createSetupWizardState,
  getSetupFieldsForStep,
  getSetupTransportMode,
  goToNextSetupStep,
  goToPreviousSetupStep,
  resolveWizardValue,
  setActiveSetupStep,
  updateSetupDraftValue,
  validateSetupWizardState
};

if (typeof globalThis !== 'undefined') {
  globalThis.PlexLiteSetupWizard = setupWizardHelpers;
}

function setSetupWizardState(nextState) {
  setupWizardState = validateSetupWizardState(nextState);
  return setupWizardState;
}

function buildMetaText(meta) {
  const parts = [
    `Datei: ${meta.path || '-'}`,
    `Vorhanden: ${meta.exists ? 'Ja' : 'Nein'}`,
    `Gueltig: ${meta.valid ? 'Ja' : 'Nein'}`
  ];
  if (meta.parseError) parts.push(`Parse Fehler: ${meta.parseError}`);
  if (Array.isArray(meta.warnings) && meta.warnings.length) parts.push(`Warnungen: ${meta.warnings.length}`);
  return parts.join(' | ');
}

function setBanner(message, kind = 'info') {
  const element = document.getElementById('setupBanner');
  if (!element) return;
  element.textContent = message;
  element.className = `status-banner ${kind}`;
}

function updateMeta() {
  const element = document.getElementById('setupMeta');
  if (!element) return;
  element.textContent = buildMetaText(setupWizardState.meta || {});
}

function getFieldElement(field) {
  return document.getElementById(field.legacyId);
}

function setFieldElementValue(field, value) {
  const element = getFieldElement(field);
  if (!element) return;
  if (field.type === 'boolean') {
    element.checked = Boolean(value);
    return;
  }
  element.value = value ?? '';
}

function parseFieldElementValue(field, element) {
  if (!element) return undefined;
  if (field.type === 'boolean') return element.checked;
  if (field.valueType === 'number') return element.value === '' ? '' : Number(element.value);
  return String(element.value ?? '');
}

function applySetupWizardStateToForm() {
  for (const field of SETUP_FIELD_DEFINITIONS) {
    setFieldElementValue(field, resolveWizardValue(setupWizardState, field.path));
  }
  updateTransportVisibility();
  updateMeta();
}

function syncRenderedFieldsToDraft() {
  const nextDraft = clone(setupWizardState.draftConfig || {});
  for (const field of SETUP_FIELD_DEFINITIONS) {
    const element = getFieldElement(field);
    if (!element) continue;
    setPath(nextDraft, field.path, parseFieldElementValue(field, element));
  }
  if (hasPath(nextDraft, 'schedule.timezone')) {
    setPath(nextDraft, 'epex.timezone', getPath(nextDraft, 'schedule.timezone'));
  }
  return setSetupWizardState({
    ...setupWizardState,
    draftConfig: nextDraft
  });
}

function updateTransportVisibility() {
  const mqttFields = document.getElementById('mqttFields');
  if (!mqttFields) return;
  mqttFields.style.display = setupWizardState.transportMode === 'mqtt' ? 'grid' : 'none';
}

function hydrateSetupWizardState(payload) {
  setSetupWizardState(createSetupWizardState({
    config: payload?.config || {},
    effectiveConfig: payload?.effectiveConfig || {},
    meta: payload?.meta || {},
    activeStepId: setupWizardState.activeStepId
  }));
  applySetupWizardStateToForm();
  return setupWizardState;
}

function collectConfig() {
  syncRenderedFieldsToDraft();
  return clone(setupWizardState.draftConfig || {});
}

function summarizeBlockingErrors(state) {
  return state.validation.summary
    .slice(0, 2)
    .map((entry) => entry.message)
    .join(' ');
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
  hydrateSetupWizardState({
    config: payload.config,
    effectiveConfig: payload.effectiveConfig,
    meta: payload.meta
  });
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
  hydrateSetupWizardState(payload);
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

function handleFieldMutation() {
  const nextState = syncRenderedFieldsToDraft();
  if (!nextState.validation.summary.length) return;
  setBanner(`Es fehlen noch Pflichtangaben. ${summarizeBlockingErrors(nextState)}`, 'warn');
}

if (typeof document !== 'undefined') {
  document.getElementById('setupSaveBtn')?.addEventListener('click', () => {
    const nextState = syncRenderedFieldsToDraft();
    if (nextState.validation.isBlocking) {
      setBanner(`Bitte zuerst alle Pflichtangaben korrigieren. ${summarizeBlockingErrors(nextState)}`, 'error');
      return;
    }
    saveSetup(clone(nextState.draftConfig)).catch((error) => {
      setBanner(`Setup konnte nicht gespeichert werden: ${error.message}`, 'error');
    });
  });

  document.getElementById('setupImportBtn')?.addEventListener('click', () => {
    document.getElementById('setupImportFile')?.click();
  });

  document.getElementById('setupImportFile')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    await importSetupFile(file);
    event.target.value = '';
  });

  for (const field of SETUP_FIELD_DEFINITIONS) {
    const element = getFieldElement(field);
    const eventName = field.type === 'text' || field.type === 'number' ? 'input' : 'change';
    element?.addEventListener(eventName, handleFieldMutation);
  }

  window.addEventListener('plexlite:unauthorized', () => {
    setBanner('API-Zugriff abgelehnt. Wenn ein Token aktiv ist, die Seite mit ?token=DEIN_TOKEN oeffnen.', 'error');
  });

  loadSetup().catch((error) => setBanner(`Setup konnte nicht geladen werden: ${error.message}`, 'error'));
}
