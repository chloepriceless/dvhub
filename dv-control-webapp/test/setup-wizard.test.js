import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createDefaultConfig, getConfigDefinition } from '../config-model.js';

function loadSetupWizardHelpers() {
  const setupPath = fileURLToPath(new URL('../public/setup.js', import.meta.url));
  const source = fs.readFileSync(setupPath, 'utf8');
  const sandbox = {
    console,
    globalThis: {},
    window: {
      PlexLiteCommon: {},
      addEventListener() {},
      setTimeout() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(setupPath) });
  return sandbox.PlexLiteSetupWizard;
}

const {
  createSetupWizardState,
  describeSetupStep,
  getVisibleSetupFieldsForStep,
  goToNextSetupStep,
  goToPreviousSetupStep,
  setActiveSetupStep,
  updateSetupDraftValue,
  validateSetupWizardState
} = loadSetupWizardHelpers();

function createSampleState(overrides = {}) {
  const defaults = createDefaultConfig();
  return createSetupWizardState({
    definition: getConfigDefinition(),
    config: {
      victron: { transport: defaults.victron.transport },
      schedule: {},
      epex: {},
      influx: {},
      meter: {},
      dvControl: {}
    },
    effectiveConfig: defaults,
    meta: { needsSetup: true },
    ...overrides
  });
}

test('createSetupWizardState starts on the first step with ordered metadata', () => {
  const state = createSampleState();

  assert.equal(state.activeStepId, 'basics');
  assert.deepEqual(Array.from(state.stepOrder), ['basics', 'transport', 'dv', 'services']);
  assert.deepEqual(Array.from(state.visitedStepIds), ['basics']);
  assert.deepEqual(Array.from(state.steps, (step) => step.id), Array.from(state.stepOrder));
});

test('createSetupWizardState derives setup steps from schema metadata', () => {
  const definition = getConfigDefinition();
  const state = createSampleState({ definition });
  const setupFields = definition.fields
    .filter((field) => field.setup?.stepId === 'transport')
    .sort((left, right) => (left.setup.order || 0) - (right.setup.order || 0));

  assert.ok(Array.isArray(definition.setupWizard?.steps));
  assert.equal(state.steps[0].title, definition.setupWizard.steps[0].title);
  assert.deepEqual(
    Array.from(state.steps.find((step) => step.id === 'transport').fields),
    Array.from(setupFields.map((field) => field.path))
  );
});

test('draft values survive forward and backward navigation', () => {
  let state = createSampleState();
  state = updateSetupDraftValue(state, 'httpPort', 9001);

  state = goToNextSetupStep(state);
  state = goToPreviousSetupStep(state);

  assert.equal(state.activeStepId, 'basics');
  assert.equal(state.draftConfig.httpPort, 9001);
  assert.ok(state.visitedStepIds.includes('transport'));
});

test('navigation is blocked when required transport values are missing', () => {
  const defaults = createDefaultConfig();
  let state = createSampleState({
    config: { victron: { transport: 'mqtt', host: '' } },
    effectiveConfig: {
      ...defaults,
      victron: {
        ...defaults.victron,
        transport: 'mqtt',
        host: '',
        mqtt: {
          ...defaults.victron.mqtt,
          portalId: ''
        }
      }
    }
  });

  state = setActiveSetupStep(state, 'transport');
  state = goToNextSetupStep(state);

  assert.equal(state.activeStepId, 'transport');
  assert.equal(state.validation.steps.transport.valid, false);
  assert.ok(state.validation.summary.some((entry) => entry.path === 'victron.host'));
  assert.ok(state.validation.summary.some((entry) => entry.path === 'victron.mqtt.portalId'));
});

test('transport step guidance and visible fields change between modbus and mqtt', () => {
  const defaults = createDefaultConfig();
  const modbusState = setActiveSetupStep(createSampleState(), 'transport');
  const mqttState = setActiveSetupStep(createSampleState({
    config: {
      victron: { transport: 'mqtt' },
      schedule: {},
      epex: {},
      influx: {},
      meter: {},
      dvControl: {}
    },
    effectiveConfig: {
      ...defaults,
      victron: {
        ...defaults.victron,
        transport: 'mqtt'
      }
    }
  }), 'transport');

  const modbusFields = getVisibleSetupFieldsForStep(modbusState, 'transport').map((field) => field.path);
  const mqttFields = getVisibleSetupFieldsForStep(mqttState, 'transport').map((field) => field.path);
  const modbusCopy = describeSetupStep(modbusState);
  const mqttCopy = describeSetupStep(mqttState);

  assert.deepEqual(Array.from(modbusFields), [
    'victron.transport',
    'victron.host',
    'victron.port',
    'victron.unitId',
    'victron.timeoutMs'
  ]);
  assert.deepEqual(Array.from(mqttFields), [
    'victron.transport',
    'victron.host',
    'victron.mqtt.portalId',
    'victron.mqtt.broker',
    'victron.mqtt.keepaliveIntervalMs'
  ]);
  assert.match(modbusCopy.highlight.title, /Modbus/i);
  assert.match(mqttCopy.highlight.title, /MQTT/i);
  assert.match(mqttCopy.highlight.body, /Broker/i);
  assert.match(mqttCopy.highlight.body, /GX-Host/i);
  assert.equal(mqttCopy.progressLabel, 'Schritt 2 von 4');
});

test('validateSetupWizardState returns per-step and per-field blocking feedback', () => {
  const defaults = createDefaultConfig();
  const state = validateSetupWizardState(createSampleState({
    config: {
      ...defaults,
      modbusListenPort: '',
      meter: {
        ...defaults.meter,
        quantity: 0
      }
    }
  }));

  assert.equal(state.validation.steps.dv.valid, false);
  assert.deepEqual(
    Array.from(state.validation.fields.modbusListenPort),
    ['Bitte einen gueltigen Port zwischen 1 und 65535 eingeben.']
  );
  assert.deepEqual(
    Array.from(state.validation.fields['meter.quantity']),
    ['Bitte eine gueltige Registeranzahl zwischen 1 und 125 eingeben.']
  );
});
