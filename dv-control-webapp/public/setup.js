const common = typeof window !== 'undefined' ? window.DVhubCommon || {} : {};
const { apiFetch, setStoredApiToken } = common;

let setupDefinition = null;

const REVIEW_STEP_ID = 'review';

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

function inferSetupFieldValueType(field) {
  if (field.type === 'number') return 'number';
  if (field.type === 'boolean') return 'boolean';
  if (field.type === 'select' && Array.isArray(field.options) && field.options.length && field.options.every((option) => typeof option.value === 'number')) return 'number';
  return 'string';
}

function getSetupStepDefinitions(definitionLike = setupDefinition) {
  return (definitionLike?.setupWizard?.steps || [])
    .map((step, index) => ({
      ...step,
      index: Number.isInteger(step.index) ? step.index : index
    }))
    .sort((left, right) => left.index - right.index);
}

function getSetupFieldDefinitions(definitionLike = setupDefinition) {
  return (definitionLike?.fields || [])
    .filter((field) => field?.setup?.stepId)
    .map((field) => ({
      ...field,
      help: field.setup?.help || field.help || '',
      valueType: inferSetupFieldValueType(field)
    }))
    .sort((left, right) => {
      if (left.setup.stepId !== right.setup.stepId) return left.setup.stepId.localeCompare(right.setup.stepId);
      return (left.setup.order || 0) - (right.setup.order || 0);
    });
}

function resolveSetupStepId(stepId, steps = getSetupStepDefinitions()) {
  const validIds = new Set((steps || []).map((step) => step.id));
  if (validIds.has(stepId)) return stepId;
  return steps[0]?.id || '';
}

function getSetupFieldsForStep(stepId, definitionLike = setupDefinition) {
  return getSetupFieldDefinitions(definitionLike).filter((field) => field.setup?.stepId === stepId);
}

function matchesSetupVisibilityRule(state, rule) {
  if (!rule?.path) return true;
  return resolveWizardValue(state, rule.path) === rule.equals;
}

function isSetupFieldVisible(state, field) {
  const setup = field?.setup || {};
  if (Array.isArray(setup.visibleWhenTransport) && setup.visibleWhenTransport.length && !setup.visibleWhenTransport.includes(getSetupTransportMode(state))) return false;
  if (setup.visibleWhenPath && !matchesSetupVisibilityRule(state, setup.visibleWhenPath)) return false;
  if (setup.hiddenWhenPath && matchesSetupVisibilityRule(state, setup.hiddenWhenPath)) return false;
  return true;
}

function getVisibleSetupFieldsForStep(state, stepId) {
  return getSetupFieldsForStep(stepId, state?.definition || setupDefinition).filter((field) => isSetupFieldVisible(state, field));
}

function buildSetupSteps(definitionLike = setupDefinition) {
  const steps = getSetupStepDefinitions(definitionLike);
  const reviewStep = steps.find((step) => step.id === REVIEW_STEP_ID) || {
    id: REVIEW_STEP_ID,
    index: steps.length,
    label: `Schritt ${steps.length + 1}`,
    title: 'Prüfen & speichern',
    description: 'Kontrolliere die wichtigsten Werte und die wirksamen Defaults, bevor DVhub die Config speichert.'
  };
  return [...steps, reviewStep].map((step, index) => {
    const fields = getSetupFieldsForStep(step.id, definitionLike);
    return {
      ...step,
      index,
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

function buildValidationResult(summary, steps = []) {
  const fields = {};
  const stepState = {};
  for (const step of steps) {
    stepState[step.id] = { valid: true, errors: [] };
  }
  for (const entry of summary) {
    if (!stepState[entry.stepId]) stepState[entry.stepId] = { valid: true, errors: [] };
    stepState[entry.stepId].valid = false;
    stepState[entry.stepId].errors.push(entry.message);
    if (!fields[entry.path]) fields[entry.path] = [];
    fields[entry.path].push(entry.message);
  }
  return {
    fields,
    steps: stepState,
    summary,
    isBlocking: summary.length > 0
  };
}

function pushValidationError(summary, stepId, path, message) {
  summary.push({ stepId, path, message });
}

function isBlankValue(value) {
  return value === '' || value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function validateIntegerInRange(value, min, max) {
  if (isBlankValue(value)) return false;
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= min && normalized <= max;
}

function validateSetupWizardState(state) {
  const steps = buildSetupSteps(state?.definition || setupDefinition);
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

  requireInteger('basics', 'httpPort', 1, 65535, 'Bitte einen gültigen Port zwischen 1 und 65535 eingeben.');

  requireOption('transport', 'victron.transport', ['modbus', 'mqtt'], 'Bitte einen gültigen Victron-Transport wählen.');
  if (transport === 'modbus') {
    requireText('transport', 'victron.host', 'Bitte den GX-Host oder DNS-Namen angeben.');
    requireInteger('transport', 'victron.port', 1, 65535, 'Bitte einen gültigen GX-Port zwischen 1 und 65535 eingeben.');
    requireInteger('transport', 'victron.unitId', 0, 255, 'Bitte eine gültige Unit ID zwischen 0 und 255 eingeben.');
    requireInteger('transport', 'victron.timeoutMs', 100, 60000, 'Bitte einen gültigen Timeout zwischen 100 und 60000 ms eingeben.');
  } else {
    if (isBlankValue(resolveWizardValue(state, 'victron.host', '')) && isBlankValue(resolveWizardValue(state, 'victron.mqtt.broker', ''))) {
      pushValidationError(summary, 'transport', 'victron.mqtt.broker', 'Bitte entweder eine MQTT Broker URL oder den GX-Host angeben.');
    }
    requireText('transport', 'victron.mqtt.portalId', 'Bitte die Victron Portal ID für MQTT angeben.');
    requireInteger('transport', 'victron.mqtt.keepaliveIntervalMs', 1000, 600000, 'Bitte ein gültiges Keepalive zwischen 1000 und 600000 ms eingeben.');
  }

  requireText('dv', 'modbusListenHost', 'Bitte den Modbus-Listen-Host angeben.');
  requireInteger('dv', 'modbusListenPort', 1, 65535, 'Bitte einen gültigen Port zwischen 1 und 65535 eingeben.');
  requireOption('dv', 'gridPositiveMeans', ['feed_in', 'grid_import'], 'Bitte eine gültige Vorzeichenlogik wählen.');
  requireOption('dv', 'meter.fc', [3, 4], 'Bitte einen gültigen Meter Function Code wählen.');
  requireInteger('dv', 'meter.address', 0, 65535, 'Bitte eine gültige Meter-Startadresse zwischen 0 und 65535 eingeben.');
  requireInteger('dv', 'meter.quantity', 1, 125, 'Bitte eine gültige Registeranzahl zwischen 1 und 125 eingeben.');

  requireText('services', 'schedule.timezone', 'Bitte eine Zeitzone für den Zeitplan angeben.');
  if (resolveWizardValue(state, 'epex.enabled', false)) {
    requireText('services', 'epex.bzn', 'Bitte die BZN für den EPEX-Dienst angeben.');
  }
  if (resolveWizardValue(state, 'influx.enabled', false)) {
    requireText('services', 'influx.url', 'Bitte die Influx-URL angeben.');
    requireText('services', 'influx.db', 'Bitte die Influx-Datenbank angeben.');
  }

  return {
    ...state,
    definition: clone(state?.definition || setupDefinition || {}),
    steps,
    stepOrder: steps.map((step) => step.id),
    activeStepId: resolveSetupStepId(state?.activeStepId, steps),
    transportMode: transport,
    validation: buildValidationResult(summary, steps)
  };
}

function createSetupWizardState(payload = {}) {
  const definition = clone(payload.definition || setupDefinition || {});
  const steps = buildSetupSteps(definition);
  const initialStepId = resolveSetupStepId(payload.activeStepId, steps);
  const state = {
    definition,
    draftConfig: clone(payload.config || {}),
    effectiveConfig: clone(payload.effectiveConfig || {}),
    meta: clone(payload.meta || {}),
    steps,
    stepOrder: steps.map((step) => step.id),
    activeStepId: initialStepId,
    visitedStepIds: Array.from(new Set(initialStepId ? [initialStepId] : [])),
    completedStepIds: [],
    transportMode: 'modbus',
    validation: buildValidationResult([], steps)
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
  const steps = state?.steps?.length ? state.steps : buildSetupSteps(state?.definition || setupDefinition);
  const activeStepId = resolveSetupStepId(requestedStepId, steps);
  return {
    ...state,
    steps,
    stepOrder: steps.map((step) => step.id),
    activeStepId,
    visitedStepIds: Array.from(new Set([...(state?.visitedStepIds || []), activeStepId]))
  };
}

function getCurrentStepIndex(state) {
  return Math.max(0, (state?.stepOrder || []).indexOf(state?.activeStepId));
}

function describeSetupStep(state, stepId = state?.activeStepId) {
  const steps = state?.steps || [];
  const activeStep = steps.find((step) => step.id === stepId) || steps[0] || null;
  const currentIndex = Math.max(0, steps.findIndex((step) => step.id === activeStep?.id));
  const progressCurrent = steps.length ? currentIndex + 1 : 0;
  const visibleFields = activeStep ? getVisibleSetupFieldsForStep(state, activeStep.id) : [];
  const baseDescription = {
    progressLabel: steps.length ? `Schritt ${progressCurrent} von ${steps.length}` : '',
    progressValue: steps.length ? Math.round((progressCurrent / steps.length) * 100) : 0,
    fieldCountLabel: activeStep?.id === REVIEW_STEP_ID
      ? 'Zusammenfassung & Speichern'
      : (visibleFields.length === 1 ? '1 Fokusfeld' : `${visibleFields.length} Fokusfelder`),
    highlight: {
      eyebrow: activeStep?.label || '',
      title: activeStep?.title || '',
      body: activeStep?.description || ''
    },
    note: ''
  };

  switch (activeStep?.id) {
    case 'basics':
      return {
        ...baseDescription,
        highlight: {
          eyebrow: 'Erster Zugriff',
          title: 'Nur die Daten, die DVhub direkt erreichbar machen',
          body: 'HTTP-Port und optionales API-Token reichen für den ersten sicheren Einstieg.'
        },
        note: 'Alles Weitere bleibt später in den Einstellungen verfuegbar. Hier geht es nur um den schnellen, sicheren Start.'
      };
    case 'transport':
      if (getSetupTransportMode(state) === 'mqtt') {
        return {
          ...baseDescription,
          highlight: {
            eyebrow: 'Venus MQTT',
            title: 'MQTT mit Portal ID und optionalem Broker',
            body: 'Portal ID ist Pflicht. Einen Broker trennst du nur dann ein, wenn DVhub nicht direkt über den GX-Host verbinden soll.'
          },
          note: 'Wenn das Broker-Feld leer bleibt, verwendet DVhub den GX-Host als MQTT-Fallback. Unpassende Modbus-Felder verschwinden aus diesem Schritt.'
        };
      }
      return {
        ...baseDescription,
        highlight: {
          eyebrow: 'Direkte Registerverbindung',
          title: 'Modbus TCP direkt zum GX',
          body: 'Für Modbus brauchst du nur Host, Port, Unit ID und Timeout für die erste stabile Registerverbindung.'
        },
        note: 'MQTT-spezifische Felder werden ausgeblendet, damit der Schritt ruhig und eindeutig bleibt.'
      };
    case 'dv':
      return {
        ...baseDescription,
        highlight: {
          eyebrow: 'Proxy & Meter',
          title: 'DV-Port, Meterblock und Vorzeichen an einem Ort',
          body: 'In diesem Schritt definierst du, wie DVhub Netzwerte liest und später an externe Systeme weiterreicht.'
        },
        note: 'Nur der Kernblock für den Start bleibt sichtbar. Host- oder Timeout-Overrides des Meters folgen später in den Einstellungen.'
      };
    case 'services':
      return {
        ...baseDescription,
        highlight: {
          eyebrow: 'Optional zum Start',
          title: 'Zeitzone zuerst, Dienste nur bei Bedarf',
          body: 'Schedule, EPEX und Influx bleiben kompakt. Zusatzfelder erscheinen erst, wenn du den jeweiligen Dienst einschaltest.'
        },
        note: 'So bleibt der letzte Schritt klein, auch wenn du nur die Grundkonfiguration speichern willst.'
      };
    case REVIEW_STEP_ID:
      return {
        ...baseDescription,
        highlight: {
          eyebrow: 'Letzter Check',
          title: 'Prüfen, was DVhub wirklich speichert und verwendet',
          body: 'Vor dem Speichern siehst du die Kernwerte, aktive Dienste und wichtige Default- oder Fallback-Ergebnisse der aktuellen Konfiguration.'
        },
        note: 'Kontrolliere hier besonders Transport, Meter und optionale Dienste. Danach kannst du das Setup oben speichern.'
      };
    default:
      return baseDescription;
  }
}

function goToNextSetupStep(state) {
  const validatedState = validateSetupWizardState(state);
  const currentStepId = validatedState.activeStepId;
  if (!validatedState.validation.steps[currentStepId]?.valid) return validatedState;
  const currentIndex = getCurrentStepIndex(validatedState);
  const nextStepId = validatedState.stepOrder[currentIndex + 1] || currentStepId;
  if (nextStepId === REVIEW_STEP_ID && validatedState.validation.isBlocking) return validatedState;
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

function formatReviewValue(value, fallback = 'Nicht gesetzt') {
  if (isBlankValue(value)) return fallback;
  if (typeof value === 'boolean') return value ? 'Aktiv' : 'Deaktiviert';
  return String(value);
}

function hasOwnDraftValue(state, path) {
  return hasPath(state?.draftConfig, path) && !isBlankValue(getPath(state?.draftConfig, path));
}

function collectInheritedMeterNotes(state) {
  const effectiveHost = resolveWizardValue(state, 'meter.host', '');
  const effectivePort = resolveWizardValue(state, 'meter.port', '');
  const effectiveUnitId = resolveWizardValue(state, 'meter.unitId', '');
  const effectiveTimeout = resolveWizardValue(state, 'meter.timeoutMs', '');
  const notes = [];

  if (!hasOwnDraftValue(state, 'meter.host') && !isBlankValue(effectiveHost)) {
    notes.push(`Meter Host folgt automatisch der Victron-Verbindung: ${effectiveHost}.`);
  }
  if (!hasOwnDraftValue(state, 'meter.port') && !isBlankValue(effectivePort)) {
    notes.push(`Meter Port bleibt auf dem wirksamen Standard ${effectivePort}.`);
  }
  if (!hasOwnDraftValue(state, 'meter.unitId') && !isBlankValue(effectiveUnitId)) {
    notes.push(`Meter Unit ID übernimmt den wirksamen Wert ${effectiveUnitId}.`);
  }
  if (!hasOwnDraftValue(state, 'meter.timeoutMs') && !isBlankValue(effectiveTimeout)) {
    notes.push(`Meter Timeout bleibt beim wirksamen Wert ${effectiveTimeout} ms.`);
  }

  return notes;
}

function buildSetupReviewSnapshot(state) {
  const transportMode = getSetupTransportMode(state);
  const host = resolveWizardValue(state, 'victron.host', '');
  const scheduleTimezone = resolveWizardValue(state, 'schedule.timezone', '');
  const epexEnabled = Boolean(resolveWizardValue(state, 'epex.enabled', false));
  const influxEnabled = Boolean(resolveWizardValue(state, 'influx.enabled', false));

  const transportSection = {
    id: 'transport',
    title: 'Victron Verbindung',
    entries: [
      { label: 'Transport', value: transportMode === 'mqtt' ? 'MQTT' : 'Modbus TCP' },
      { label: 'GX Host', value: formatReviewValue(host) }
    ],
    notes: []
  };

  if (transportMode === 'mqtt') {
    transportSection.entries.push(
      { label: 'Portal ID', value: formatReviewValue(resolveWizardValue(state, 'victron.mqtt.portalId', '')) },
      { label: 'Broker', value: formatReviewValue(resolveWizardValue(state, 'victron.mqtt.broker', ''), 'GX-Host als Fallback') },
      { label: 'Keepalive', value: `${formatReviewValue(resolveWizardValue(state, 'victron.mqtt.keepaliveIntervalMs', ''))} ms` }
    );
    if (isBlankValue(resolveWizardValue(state, 'victron.mqtt.broker', '')) && !isBlankValue(host)) {
      transportSection.notes.push(`Kein eigener Broker gespeichert. DVhub nutzt beim Verbinden automatisch den GX-Host ${host} auf MQTT-Port 1883.`);
    }
  } else {
    transportSection.entries.push(
      { label: 'GX Port', value: formatReviewValue(resolveWizardValue(state, 'victron.port', '')) },
      { label: 'Unit ID', value: formatReviewValue(resolveWizardValue(state, 'victron.unitId', '')) },
      { label: 'Timeout', value: `${formatReviewValue(resolveWizardValue(state, 'victron.timeoutMs', ''))} ms` }
    );
  }

  const serviceNotes = [];
  if (epexEnabled && !hasOwnDraftValue(state, 'epex.timezone') && !isBlankValue(scheduleTimezone)) {
    serviceNotes.push(`EPEX übernimmt die Setup-Zeitzone ${scheduleTimezone}, solange keine eigene Zeitzone gesetzt ist.`);
  }

  return [
    {
      id: 'basics',
      title: 'Webzugriff',
      entries: [
        { label: 'HTTP Port', value: formatReviewValue(resolveWizardValue(state, 'httpPort', '')) },
        { label: 'API Token', value: isBlankValue(resolveWizardValue(state, 'apiToken', '')) ? 'Nicht gesetzt' : 'Gesetzt' }
      ],
      notes: isBlankValue(resolveWizardValue(state, 'apiToken', ''))
        ? ['Ohne API-Token bleibt der lokale Zugriff einfacher, externe Zugriffe sollten dann anderweitig abgesichert werden.']
        : []
    },
    transportSection,
    {
      id: 'dv',
      title: 'DV & Meter',
      entries: [
        { label: 'Proxy Host', value: formatReviewValue(resolveWizardValue(state, 'modbusListenHost', '')) },
        { label: 'Proxy Port', value: formatReviewValue(resolveWizardValue(state, 'modbusListenPort', '')) },
        { label: 'Vorzeichenlogik', value: resolveWizardValue(state, 'gridPositiveMeans', '') === 'grid_import' ? 'Positiv = Netzbezug' : 'Positiv = Einspeisung' },
        { label: 'Meter FC', value: formatReviewValue(resolveWizardValue(state, 'meter.fc', '')) },
        { label: 'Meter Start', value: formatReviewValue(resolveWizardValue(state, 'meter.address', '')) },
        { label: 'Register', value: formatReviewValue(resolveWizardValue(state, 'meter.quantity', '')) }
      ],
      notes: collectInheritedMeterNotes(state)
    },
    {
      id: 'services',
      title: 'Dienste',
      entries: [
        { label: 'Zeitzone', value: formatReviewValue(scheduleTimezone) },
        { label: 'EPEX', value: epexEnabled ? 'Aktiv' : 'Deaktiviert' },
        { label: 'EPEX BZN', value: epexEnabled ? formatReviewValue(resolveWizardValue(state, 'epex.bzn', '')) : 'Nicht aktiv' },
        { label: 'InfluxDB', value: influxEnabled ? 'Aktiv' : 'Deaktiviert' },
        { label: 'Influx URL', value: influxEnabled ? formatReviewValue(resolveWizardValue(state, 'influx.url', '')) : 'Nicht aktiv' },
        { label: 'Influx DB', value: influxEnabled ? formatReviewValue(resolveWizardValue(state, 'influx.db', '')) : 'Nicht aktiv' }
      ],
      notes: serviceNotes
    }
  ];
}

function validateSetupSubmissionConfig(config, state = setupWizardState) {
  const baseState = state || setupWizardState || {};
  return createSetupWizardState({
    definition: baseState.definition || setupDefinition,
    config: clone(config || {}),
    effectiveConfig: clone(config || {}),
    meta: clone(baseState.meta || {}),
    activeStepId: baseState.activeStepId
  });
}

function describeRestartPath(path) {
  if (path === 'httpPort') return 'Webserver-Port';
  if (path === 'modbusListenHost' || path === 'modbusListenPort') return 'DV Modbus Proxy';
  if (path === 'victron.transport') return 'Victron-Transport';
  if (path.startsWith('victron.mqtt.broker')) return 'MQTT Broker';
  if (path.startsWith('victron.mqtt.portalId')) return 'MQTT Portal ID';
  if (path.startsWith('victron.mqtt.keepaliveIntervalMs')) return 'MQTT Keepalive';
  if (path.startsWith('victron.mqtt.qos')) return 'MQTT QoS';
  return path;
}

function buildSetupSaveOutcome(payload, source = 'setup') {
  const warnings = Array.isArray(payload?.meta?.warnings) ? payload.meta.warnings : [];
  const restartItems = Array.from(new Set((Array.isArray(payload?.restartRequiredPaths) ? payload.restartRequiredPaths : []).map(describeRestartPath)));
  const title = source === 'import' ? 'Config importiert' : 'Setup gespeichert';
  const kind = payload?.restartRequired || warnings.length ? 'warn' : 'success';
  const summary = payload?.restartRequired
    ? 'Ein Teil der Änderungen ist gespeichert, wird aber erst nach einem Dienst-Neustart oder einer neuen Verbindung wirksam.'
    : 'Die Kernkonfiguration ist gespeichert und die naechsten Schritte liegen jetzt in den Einstellungen.';
  const bannerParts = [title];
  if (payload?.restartRequired) bannerParts.push('Einige Einstellungen werden erst nach einem Dienst-Neustart aktiv.');
  if (warnings.length) bannerParts.push(`Bitte ${warnings.length === 1 ? 'die Warnung' : 'die Warnungen'} unten prüfen.`);
  bannerParts.push('Weiterleitung zu den Einstellungen...');
  const nextSteps = payload?.restartRequired
    ? ['In den Einstellungen prüfen, welche Verbindungswerte aktiv sind.', 'Danach den DVhub-Dienst oder die betroffene Verbindung neu starten.']
    : ['In den Einstellungen die vollstaendige Config prüfen und bei Bedarf weiter verfeinern.'];
  return {
    title,
    kind,
    summary,
    banner: bannerParts.join(' '),
    warnings,
    restartItems,
    nextSteps,
    redirectUrl: '/settings.html?setup=done',
    redirectDelayMs: payload?.restartRequired || warnings.length ? 2600 : 1800
  };
}

const setupWizardHelpers = {
  buildSetupReviewSnapshot,
  buildSetupSaveOutcome,
  buildSetupSteps,
  createSetupWizardState,
  describeSetupStep,
  getSetupFieldsForStep,
  getSetupFieldDefinitions,
  getSetupStepDefinitions,
  getSetupTransportMode,
  getVisibleSetupFieldsForStep,
  goToNextSetupStep,
  goToPreviousSetupStep,
  resolveWizardValue,
  setActiveSetupStep,
  updateSetupDraftValue,
  buildSetupSaveOutcome,
  validateSetupSubmissionConfig,
  validateSetupWizardState
};

if (typeof globalThis !== 'undefined') {
  globalThis.DVhubSetupWizard = setupWizardHelpers;
}

function setSetupWizardState(nextState) {
  setupDefinition = clone(nextState?.definition || setupDefinition || {});
  setupWizardState = validateSetupWizardState(nextState);
  return setupWizardState;
}

function buildMetaText(meta) {
  const parts = [
    `Datei: ${meta.path || '-'}`,
    `Vorhanden: ${meta.exists ? 'Ja' : 'Nein'}`,
    `Gültig: ${meta.valid ? 'Ja' : 'Nein'}`
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

function getFieldInputId(path) {
  return `setup_field_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

function parseFieldElementValue(field, element) {
  if (!element) return undefined;
  if (field.type === 'boolean') return element.checked;
  if (field.valueType === 'number') return element.value === '' ? '' : Number(element.value);
  return String(element.value ?? '');
}

function summarizeBlockingErrors(state) {
  return state.validation.summary
    .slice(0, 2)
    .map((entry) => entry.message)
    .join(' ');
}

function renderSetupSteps() {
  const container = document.getElementById('setup-steps');
  if (!container) return;
  container.replaceChildren();

  const list = document.createElement('ol');
  list.className = 'wizard-steps';

  for (const step of setupWizardState.steps) {
    const item = document.createElement('li');
    item.className = 'setup-step-item';
    const button = document.createElement('button');
    const isActive = step.id === setupWizardState.activeStepId;
    const isComplete = setupWizardState.completedStepIds.includes(step.id);
    const isVisited = setupWizardState.visitedStepIds.includes(step.id);
    const currentIndex = getCurrentStepIndex(setupWizardState);
    const stepIndex = setupWizardState.stepOrder.indexOf(step.id);

    button.type = 'button';
    button.dataset.stepId = step.id;
    button.className = 'setup-step-button';
    button.disabled = stepIndex > currentIndex + 1 || (!isVisited && stepIndex > currentIndex);
    button.setAttribute('aria-current', isActive ? 'step' : 'false');
    if (isComplete) button.dataset.state = 'complete';
    else if (isActive) button.dataset.state = 'active';
    else if (isVisited) button.dataset.state = 'visited';

    const index = document.createElement('span');
    index.className = 'setup-step-index';
    index.textContent = String(step.index + 1).padStart(2, '0');

    const copy = document.createElement('span');
    copy.className = 'setup-step-copy';

    const title = document.createElement('strong');
    title.className = 'setup-step-title';
    title.textContent = step.title;

    const summary = document.createElement('small');
    summary.className = 'setup-step-meta';
    if (!setupWizardState.validation.steps[step.id].valid) summary.textContent = 'Pflichtangaben fehlen';
    else if (isComplete) summary.textContent = 'Bereit';
    else if (isActive) summary.textContent = step.description;
    else if (step.id === REVIEW_STEP_ID) summary.textContent = 'Zusammenfassung und letzter Check';
    else summary.textContent = `${step.fieldCount} Felder im Fokus`;

    copy.append(title, summary);
    button.append(index, copy);
    item.appendChild(button);
    list.appendChild(item);
  }

  container.appendChild(list);
}

function renderField(field) {
  const wrapper = document.createElement('label');
  wrapper.className = 'settings-field setup-field';
  if (field.type === 'boolean') wrapper.classList.add('checkbox-field');

  const title = document.createElement('span');
  title.className = 'settings-field-title';
  title.textContent = field.label;
  wrapper.appendChild(title);

  let input;
  const value = resolveWizardValue(setupWizardState, field.path, field.type === 'boolean' ? false : '');
  if (field.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(value);
  } else if (field.type === 'select') {
    input = document.createElement('select');
    for (const optionDef of field.options || []) {
      const option = document.createElement('option');
      option.value = String(optionDef.value);
      option.textContent = optionDef.label;
      input.appendChild(option);
    }
    input.value = String(value);
  } else {
    input = document.createElement('input');
    input.type = field.type === 'number' ? 'number' : 'text';
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    input.value = value === null || value === undefined ? '' : String(value);
  }

  input.id = getFieldInputId(field.path);
  input.dataset.path = field.path;
  input.dataset.stepId = field.setup?.stepId || '';
  wrapper.appendChild(input);

  const help = document.createElement('small');
  help.className = 'field-help';
  const fieldErrors = setupWizardState.validation.fields[field.path] || [];
  if (fieldErrors.length) wrapper.classList.add('has-error');
  help.textContent = fieldErrors.length ? fieldErrors[0] : field.help || '';
  wrapper.appendChild(help);

  return wrapper;
}

function renderSetupWorkspace() {
  const container = document.getElementById('setup-workspace');
  const reviewPanel = document.getElementById('setup-review-panel');
  if (!container) return;
  container.replaceChildren();
  if (reviewPanel) {
    reviewPanel.replaceChildren();
    reviewPanel.hidden = true;
  }

  const activeStep = setupWizardState.steps.find((step) => step.id === setupWizardState.activeStepId);
  if (!activeStep) return;
  const stepDescription = describeSetupStep(setupWizardState, activeStep.id);

  const progress = document.createElement('div');
  progress.className = 'setup-progress';

  const progressHead = document.createElement('div');
  progressHead.className = 'setup-progress-head';

  const progressLabel = document.createElement('p');
  progressLabel.className = 'eyebrow setup-progress-label';
  progressLabel.textContent = stepDescription.progressLabel;

  const progressCount = document.createElement('span');
  progressCount.className = 'setup-progress-count';
  progressCount.textContent = stepDescription.fieldCountLabel;

  const progressBar = document.createElement('div');
  progressBar.className = 'setup-progress-bar';
  const progressFill = document.createElement('span');
  progressFill.className = 'setup-progress-fill';
  progressFill.style.width = `${stepDescription.progressValue}%`;
  progressBar.appendChild(progressFill);

  progressHead.append(progressLabel, progressCount);
  progress.append(progressHead, progressBar);

  const header = document.createElement('div');
  header.className = 'panel-head setup-step-head';

  const titleGroup = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'card-title';
  eyebrow.textContent = activeStep.label;
  const title = document.createElement('h2');
  title.className = 'section-title';
  title.textContent = activeStep.title;
  const intro = document.createElement('p');
  intro.className = 'field-help setup-step-intro';
  intro.textContent = activeStep.description;
  titleGroup.append(eyebrow, title, intro);
  header.appendChild(titleGroup);

  const callout = document.createElement('section');
  callout.className = 'setup-callout';

  const calloutEyebrow = document.createElement('p');
  calloutEyebrow.className = 'card-title setup-callout-eyebrow';
  calloutEyebrow.textContent = stepDescription.highlight.eyebrow;

  const calloutTitle = document.createElement('h3');
  calloutTitle.className = 'setup-callout-title';
  calloutTitle.textContent = stepDescription.highlight.title;

  const calloutBody = document.createElement('p');
  calloutBody.className = 'setup-callout-body';
  calloutBody.textContent = stepDescription.highlight.body;

  const calloutNote = document.createElement('p');
  calloutNote.className = 'setup-callout-note';
  calloutNote.textContent = stepDescription.note;

  callout.append(calloutEyebrow, calloutTitle, calloutBody, calloutNote);

  if (activeStep.id === REVIEW_STEP_ID) {
    const review = document.createElement('section');
    review.className = 'setup-review';

    for (const section of buildSetupReviewSnapshot(setupWizardState)) {
      const card = document.createElement('article');
      card.className = 'setup-review-card';

      const cardHead = document.createElement('div');
      cardHead.className = 'setup-review-head';

      const cardTitle = document.createElement('h3');
      cardTitle.className = 'setup-review-title';
      cardTitle.textContent = section.title;

      cardHead.appendChild(cardTitle);
      card.appendChild(cardHead);

      const list = document.createElement('dl');
      list.className = 'setup-review-list';
      for (const entry of section.entries) {
        const term = document.createElement('dt');
        term.textContent = entry.label;
        const value = document.createElement('dd');
        value.textContent = entry.value;
        list.append(term, value);
      }
      card.appendChild(list);

      if (Array.isArray(section.notes) && section.notes.length) {
        const notes = document.createElement('ul');
        notes.className = 'setup-review-notes';
        for (const note of section.notes) {
          const item = document.createElement('li');
          item.textContent = note;
          notes.appendChild(item);
        }
        card.appendChild(notes);
      }

      review.appendChild(card);
    }

    container.append(progress, header, callout);
    if (reviewPanel) {
      reviewPanel.hidden = false;
      reviewPanel.appendChild(review);
    } else {
      container.appendChild(review);
    }
    return;
  }

  const fields = document.createElement('div');
  fields.className = 'settings-fields compact setup-fields';
  for (const field of getVisibleSetupFieldsForStep(setupWizardState, activeStep.id)) {
    fields.appendChild(renderField(field));
  }

  container.append(progress, header, callout, fields);
}

function renderSetupErrors() {
  const container = document.getElementById('setup-errors');
  if (!container) return;
  container.replaceChildren();
  container.className = 'status-banner';

  const stepErrors = setupWizardState.validation.summary.filter((entry) => entry.stepId === setupWizardState.activeStepId);
  if (!stepErrors.length) {
    container.classList.add('info');
    container.textContent = 'Dieser Schritt ist bereit. Mit Weiter gehst du zur naechsten Setup-Seite.';
    return;
  }

  container.classList.add('error');
  const headline = document.createElement('strong');
  headline.textContent = `${stepErrors.length} Angabe${stepErrors.length === 1 ? '' : 'n'} noch prüfen`;
  const intro = document.createElement('p');
  intro.className = 'setup-error-intro';
  intro.textContent = 'Bitte diese Punkte korrigieren, bevor du in den naechsten Setup-Schritt wechselst.';
  const list = document.createElement('ul');
  list.className = 'setup-error-list';
  for (const entry of stepErrors) {
    const item = document.createElement('li');
    item.textContent = entry.message;
    list.appendChild(item);
  }
  container.append(headline, intro, list);
}

function renderSetupOutcome() {
  const container = document.getElementById('setup-save-outcome');
  if (!container) return;
  container.replaceChildren();
  container.hidden = true;
  container.className = 'setup-save-outcome';

  const outcome = setupWizardState.lastSaveOutcome;
  if (!outcome) return;

  container.hidden = false;
  container.classList.add(outcome.kind === 'warn' ? 'is-warn' : 'is-success');

  const card = document.createElement('section');
  card.className = 'setup-save-card';

  const title = document.createElement('h3');
  title.className = 'setup-save-title';
  title.textContent = outcome.title;

  const summary = document.createElement('p');
  summary.className = 'setup-save-summary';
  summary.textContent = outcome.summary;

  card.append(title, summary);

  if (Array.isArray(outcome.restartItems) && outcome.restartItems.length) {
    const restartTitle = document.createElement('strong');
    restartTitle.className = 'setup-save-subtitle';
    restartTitle.textContent = 'Neustart oder Neuverbindung noetig für:';
    const restartList = document.createElement('ul');
    restartList.className = 'setup-save-list';
    for (const item of outcome.restartItems) {
      const entry = document.createElement('li');
      entry.textContent = item;
      restartList.appendChild(entry);
    }
    card.append(restartTitle, restartList);
  }

  if (Array.isArray(outcome.warnings) && outcome.warnings.length) {
    const warningTitle = document.createElement('strong');
    warningTitle.className = 'setup-save-subtitle';
    warningTitle.textContent = 'Backend-Warnungen';
    const warningList = document.createElement('ul');
    warningList.className = 'setup-save-list setup-save-list-warnings';
    for (const warning of outcome.warnings) {
      const entry = document.createElement('li');
      entry.textContent = warning;
      warningList.appendChild(entry);
    }
    card.append(warningTitle, warningList);
  }

  if (Array.isArray(outcome.nextSteps) && outcome.nextSteps.length) {
    const nextTitle = document.createElement('strong');
    nextTitle.className = 'setup-save-subtitle';
    nextTitle.textContent = 'Als Naechstes';
    const nextList = document.createElement('ul');
    nextList.className = 'setup-save-list';
    for (const step of outcome.nextSteps) {
      const entry = document.createElement('li');
      entry.textContent = step;
      nextList.appendChild(entry);
    }
    card.append(nextTitle, nextList);
  }

  container.appendChild(card);
}

function renderSetupNav() {
  const container = document.getElementById('setup-nav');
  if (!container) return;
  container.replaceChildren();

  const currentIndex = getCurrentStepIndex(setupWizardState);
  const isLastStep = currentIndex === setupWizardState.stepOrder.length - 1;
  const isReviewStep = setupWizardState.activeStepId === REVIEW_STEP_ID;
  const stepDescription = describeSetupStep(setupWizardState);

  const copy = document.createElement('div');
  copy.className = 'setup-nav-copy';

  const copyTitle = document.createElement('strong');
  copyTitle.textContent = isReviewStep ? 'Zusammenfassung prüfen und dann oben speichern' : 'Weiter zum naechsten Fokusblock';

  const copyBody = document.createElement('span');
  copyBody.textContent = stepDescription.note || 'Jeder Schritt zeigt nur die Felder, die du für diesen Abschnitt wirklich brauchst.';

  copy.append(copyTitle, copyBody);

  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'btn btn-ghost';
  backButton.dataset.action = 'back';
  backButton.disabled = currentIndex === 0;
  backButton.textContent = 'Zurück';

  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'btn btn-primary';
  nextButton.dataset.action = 'next';
  nextButton.hidden = isReviewStep;
  nextButton.textContent = isLastStep ? 'Review öffnen' : 'Weiter';

  container.append(copy, backButton, nextButton);
}

function renderSetupWizard() {
  renderSetupSteps();
  renderSetupWorkspace();
  renderSetupErrors();
  renderSetupOutcome();
  renderSetupNav();
  updateMeta();
}

function syncActiveWorkspaceFieldsToDraft() {
  const nextDraft = clone(setupWizardState.draftConfig || {});
  for (const field of getVisibleSetupFieldsForStep(setupWizardState, setupWizardState.activeStepId)) {
    const input = document.getElementById(getFieldInputId(field.path));
    if (!input) continue;
    setPath(nextDraft, field.path, parseFieldElementValue(field, input));
  }
  if (hasPath(nextDraft, 'schedule.timezone')) {
    setPath(nextDraft, 'epex.timezone', getPath(nextDraft, 'schedule.timezone'));
  }
  return setSetupWizardState({
    ...setupWizardState,
    draftConfig: nextDraft
  });
}

function moveToFirstInvalidStep(state) {
  const firstInvalid = state.stepOrder.find((stepId) => !state.validation.steps[stepId].valid);
  if (!firstInvalid) return state;
  return setSetupWizardState(setActiveSetupStep(state, firstInvalid));
}

function hydrateSetupWizardState(payload) {
  setSetupWizardState(createSetupWizardState({
    definition: payload?.definition || setupDefinition,
    config: payload?.config || {},
    effectiveConfig: payload?.effectiveConfig || {},
    meta: payload?.meta || {},
    activeStepId: setupWizardState.activeStepId
  }));
  renderSetupWizard();
  return setupWizardState;
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
  const outcome = buildSetupSaveOutcome(payload, source);
  setSetupWizardState({
    ...setupWizardState,
    lastSaveOutcome: outcome
  });
  renderSetupWizard();
  setBanner(outcome.banner, outcome.kind);
  window.setTimeout(() => {
    window.location.href = outcome.redirectUrl;
  }, outcome.redirectDelayMs);
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
  if (payload.meta.needsSetup) setBanner('Noch keine gültige Config gefunden. Bitte die Basisdaten eintragen oder eine vorhandene Config importieren.', 'warn');
  else setBanner('Es existiert bereits eine gültige Config. Der Assistent kann trotzdem zum schnellen Ueberschreiben genutzt werden.', 'success');
}

async function importSetupFile(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const submissionState = validateSetupSubmissionConfig(parsed);
    setSetupWizardState(submissionState);
    if (submissionState.validation.isBlocking) {
      moveToFirstInvalidStep(submissionState);
      renderSetupWizard();
      setBanner(`Import enthaelt noch fehlende Pflichtangaben. ${summarizeBlockingErrors(setupWizardState)}`, 'error');
      return;
    }
    await saveSetup(parsed, 'import');
  } catch (error) {
    setBanner(`Import fehlgeschlagen: ${error.message}`, 'error');
  }
}

function handleWizardStepNavigation(requestedStepId) {
  const currentIndex = getCurrentStepIndex(setupWizardState);
  const requestedIndex = setupWizardState.stepOrder.indexOf(requestedStepId);
  syncActiveWorkspaceFieldsToDraft();

  if (requestedIndex > currentIndex) {
    const nextState = goToNextSetupStep(setupWizardState);
    setSetupWizardState(nextState);
    if (nextState.activeStepId !== requestedStepId && nextState.activeStepId === setupWizardState.activeStepId) {
      moveToFirstInvalidStep(nextState);
      renderSetupWizard();
      setBanner(`Bitte zuerst die Pflichtangaben im aktuellen Schritt korrigieren. ${summarizeBlockingErrors(setupWizardState)}`, 'error');
      return;
    }
  } else {
    setSetupWizardState(setActiveSetupStep(setupWizardState, requestedStepId));
  }

  renderSetupWizard();
}

function handleWizardNav(action) {
  const syncedState = syncActiveWorkspaceFieldsToDraft();
  if (action === 'back') {
    setSetupWizardState(goToPreviousSetupStep(syncedState));
    renderSetupWizard();
    return;
  }

  const nextState = goToNextSetupStep(syncedState);
  setSetupWizardState(nextState);
  if (nextState.activeStepId === syncedState.activeStepId) {
    const requestedStepId = syncedState.stepOrder[getCurrentStepIndex(syncedState) + 1];
    if (requestedStepId === REVIEW_STEP_ID && nextState.validation.isBlocking) moveToFirstInvalidStep(nextState);
    renderSetupWizard();
    setBanner(`Bitte zuerst die Pflichtangaben im aktuellen Schritt korrigieren. ${summarizeBlockingErrors(nextState)}`, 'error');
    return;
  }

  renderSetupWizard();
  setBanner('Schritt gespeichert. Du kannst weiter zur naechsten Setup-Seite gehen.', 'info');
}

function collectConfig() {
  const syncedState = syncActiveWorkspaceFieldsToDraft();
  return clone(syncedState.draftConfig || {});
}

if (typeof document !== 'undefined') {
  document.getElementById('setupSaveBtn')?.addEventListener('click', () => {
    const syncedState = syncActiveWorkspaceFieldsToDraft();
    const nextState = validateSetupWizardState(syncedState);
    setSetupWizardState(nextState);
    if (nextState.validation.isBlocking) {
      moveToFirstInvalidStep(nextState);
      renderSetupWizard();
      setBanner(`Bitte zuerst alle Pflichtangaben korrigieren. ${summarizeBlockingErrors(setupWizardState)}`, 'error');
      return;
    }

    if (nextState.activeStepId !== REVIEW_STEP_ID) {
      setSetupWizardState(setActiveSetupStep(nextState, REVIEW_STEP_ID));
      renderSetupWizard();
      setBanner('Alle Pflichtangaben sind bereit. Bitte pruefe jetzt die Zusammenfassung vor dem Speichern.', 'info');
      return;
    }

    saveSetup(clone(nextState.draftConfig || {})).catch((error) => {
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

  document.getElementById('setup-workspace')?.addEventListener('input', (event) => {
    const path = event.target?.dataset?.path;
    if (!path) return;
    syncActiveWorkspaceFieldsToDraft();
    renderSetupErrors();
    renderSetupSteps();
  });

  document.getElementById('setup-workspace')?.addEventListener('change', (event) => {
    const path = event.target?.dataset?.path;
    if (!path) return;
    syncActiveWorkspaceFieldsToDraft();
    if (path === 'victron.transport') {
      renderSetupWizard();
      return;
    }
    renderSetupErrors();
    renderSetupSteps();
  });

  document.getElementById('setup-steps')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-step-id]');
    if (!button || button.disabled) return;
    handleWizardStepNavigation(button.dataset.stepId);
  });

  document.getElementById('setup-nav')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    handleWizardNav(button.dataset.action);
  });

  window.addEventListener('dvhub:unauthorized', () => {
    setBanner('API-Zugriff abgelehnt. Wenn ein Token aktiv ist, die Seite mit ?token=DEIN_TOKEN öffnen.', 'error');
  });

  loadSetup().catch((error) => setBanner(`Setup konnte nicht geladen werden: ${error.message}`, 'error'));
}
