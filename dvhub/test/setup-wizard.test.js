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
      DVhubCommon: {},
      addEventListener() {},
      setTimeout() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(setupPath) });
  return sandbox.DVhubSetupWizard;
}

const {
  buildSetupSaveOutcome,
  buildSetupReviewSnapshot,
  createSetupWizardState,
  describeSetupStep,
  getPrimarySetupActionLabel,
  getVisibleSetupFieldsForStep,
  goToNextSetupStep,
  goToPreviousSetupStep,
  setActiveSetupStep,
  updateSetupDraftValue,
  validateSetupSubmissionConfig,
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

function createValidSetupState(overrides = {}) {
  const defaults = createDefaultConfig();
  return validateSetupWizardState(createSampleState({
    config: {
      ...defaults,
      httpPort: 9090,
      apiToken: 'secret-token',
      victron: {
        ...defaults.victron,
        transport: 'mqtt',
        host: 'venus-gx.local',
        mqtt: {
          ...defaults.victron.mqtt,
          broker: '',
          portalId: 'VRM123456',
          keepaliveIntervalMs: 45000
        }
      },
      modbusListenHost: '0.0.0.0',
      modbusListenPort: 1502,
      schedule: {
        ...defaults.schedule,
        timezone: 'Europe/Berlin'
      },
      epex: {
        ...defaults.epex,
        enabled: true,
        bzn: 'DE-LU',
        timezone: 'Europe/Berlin'
      },
      influx: {
        ...defaults.influx,
        enabled: false
      }
    },
    effectiveConfig: {
      ...defaults,
      httpPort: 9090,
      apiToken: 'secret-token',
      victron: {
        ...defaults.victron,
        transport: 'mqtt',
        host: 'venus-gx.local',
        mqtt: {
          ...defaults.victron.mqtt,
          broker: '',
          portalId: 'VRM123456',
          keepaliveIntervalMs: 45000
        }
      },
      meter: {
        ...defaults.meter,
        host: 'venus-gx.local'
      },
      dvControl: {
        ...defaults.dvControl,
        enabled: true,
        feedExcessDcPv: {
          ...defaults.dvControl.feedExcessDcPv,
          host: 'venus-gx.local'
        },
        dontFeedExcessAcPv: {
          ...defaults.dvControl.dontFeedExcessAcPv,
          host: 'venus-gx.local'
        }
      },
      modbusListenHost: '0.0.0.0',
      modbusListenPort: 1502,
      schedule: {
        ...defaults.schedule,
        timezone: 'Europe/Berlin'
      },
      epex: {
        ...defaults.epex,
        enabled: true,
        bzn: 'DE-LU',
        timezone: 'Europe/Berlin'
      },
      influx: {
        ...defaults.influx,
        enabled: false
      }
    },
    ...overrides
  }));
}

function getReviewEntryValue(section, label) {
  return section.entries.find((entry) => entry.label === label)?.value;
}

test('createSetupWizardState starts on the first step with ordered metadata', () => {
  const state = createSampleState();

  assert.equal(state.activeStepId, 'basics');
  assert.deepEqual(Array.from(state.stepOrder), ['basics', 'transport', 'dv', 'services', 'review']);
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
    config: { victron: { transport: 'mqtt', host: '', mqtt: { broker: '' } } },
    effectiveConfig: {
      ...defaults,
      victron: {
        ...defaults.victron,
        transport: 'mqtt',
        host: '',
        mqtt: {
          ...defaults.victron.mqtt,
          broker: '',
          portalId: ''
        }
      }
    }
  });

  state = setActiveSetupStep(state, 'transport');
  state = goToNextSetupStep(state);

  assert.equal(state.activeStepId, 'transport');
  assert.equal(state.validation.steps.transport.valid, false);
  assert.ok(state.validation.summary.some((entry) => entry.path === 'victron.mqtt.broker'));
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
  assert.equal(mqttCopy.progressLabel, 'Schritt 2 von 5');
});

test('mqtt validation accepts broker fallback but blocks when neither broker nor host is present', () => {
  const defaults = createDefaultConfig();
  const validWithBroker = validateSetupWizardState(createSampleState({
    config: {
      ...defaults,
      victron: {
        ...defaults.victron,
        transport: 'mqtt',
        host: '',
        mqtt: {
          ...defaults.victron.mqtt,
          broker: 'mqtt://venus-broker.local:1883',
          portalId: 'VRM123456',
          keepaliveIntervalMs: 30000
        }
      }
    }
  }));
  const invalidWithoutBrokerOrHost = validateSetupWizardState(createSampleState({
    config: {
      ...defaults,
      victron: {
        ...defaults.victron,
        transport: 'mqtt',
        host: '',
        mqtt: {
          ...defaults.victron.mqtt,
          broker: '',
          portalId: 'VRM123456',
          keepaliveIntervalMs: 30000
        }
      }
    }
  }));

  assert.equal(validWithBroker.validation.steps.transport.valid, true);
  assert.equal(invalidWithoutBrokerOrHost.validation.steps.transport.valid, false);
  assert.match(invalidWithoutBrokerOrHost.validation.fields['victron.mqtt.broker'][0], /Broker URL oder den GX-Host/i);
});

test('blank numeric fields stay invalid instead of coercing to zero defaults', () => {
  const defaults = createDefaultConfig();
  const state = validateSetupWizardState(createSampleState({
    config: {
      ...defaults,
      victron: {
        ...defaults.victron,
        transport: 'modbus',
        unitId: ''
      },
      meter: {
        ...defaults.meter,
        address: ''
      }
    }
  }));

  assert.equal(state.validation.steps.transport.valid, false);
  assert.equal(state.validation.steps.dv.valid, false);
  assert.match(state.validation.fields['victron.unitId'][0], /Unit ID/i);
  assert.match(state.validation.fields['meter.address'][0], /Startadresse/i);
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
    ['Bitte einen gültigen Port zwischen 1 und 65535 eingeben.']
  );
  assert.deepEqual(
    Array.from(state.validation.fields['meter.quantity']),
    ['Bitte eine gültige Registeranzahl zwischen 1 und 125 eingeben.']
  );
});

test('review step extends the wizard flow and summarizes key setup outcomes', () => {
  const state = createValidSetupState();

  assert.deepEqual(Array.from(state.stepOrder), ['basics', 'transport', 'dv', 'services', 'review']);

  const review = buildSetupReviewSnapshot(state);
  const sectionTitles = Array.from(review.map((section) => section.title));
  assert.deepEqual(sectionTitles, ['Webzugriff', 'Victron Verbindung', 'DV & Meter', 'DV Steuerung', 'Dienste']);

  const transportSection = review.find((section) => section.id === 'transport');
  assert.equal(getReviewEntryValue(transportSection, 'Transport'), 'MQTT');
  assert.equal(getReviewEntryValue(transportSection, 'GX Host'), 'venus-gx.local');
  assert.equal(getReviewEntryValue(transportSection, 'Portal ID'), 'VRM123456');
  assert.match(transportSection.notes.join(' '), /GX-Host/i);

  const dvControlSection = review.find((section) => section.id === 'dvControl');
  assert.equal(getReviewEntryValue(dvControlSection, 'DV Steuerung'), 'Aktiv');
  assert.equal(getReviewEntryValue(dvControlSection, 'DC-PV Register'), '2707');
  assert.equal(getReviewEntryValue(dvControlSection, 'AC-PV Register'), '2708');
  assert.equal(getReviewEntryValue(dvControlSection, 'Negativpreis-Schutz'), 'Aktiv');
  assert.match(dvControlSection.notes.join(' '), /Victron-Verbindung/i);

  const servicesSection = review.find((section) => section.id === 'services');
  assert.equal(getReviewEntryValue(servicesSection, 'Zeitzone'), 'Europe/Berlin');
  assert.equal(getReviewEntryValue(servicesSection, 'EPEX'), 'Aktiv');
  assert.equal(getReviewEntryValue(servicesSection, 'InfluxDB'), 'Deaktiviert');

  const reviewStep = describeSetupStep(setActiveSetupStep(state, 'review'));
  assert.match(reviewStep.highlight.title, /Prüfen|Review/i);
  assert.equal(reviewStep.progressLabel, 'Schritt 5 von 5');
});

test('review step copy distinguishes review from opening the review', () => {
  const reviewStep = describeSetupStep(setActiveSetupStep(createValidSetupState(), 'review'));

  assert.match(reviewStep.note, /speichern/i);
  assert.doesNotMatch(reviewStep.note, /Review öffnen/i);
});

test('primary setup action switches from review to save on the review step', () => {
  const validState = createValidSetupState();
  const servicesState = setActiveSetupStep(validState, 'services');
  const reviewState = setActiveSetupStep(validState, 'review');

  assert.equal(getPrimarySetupActionLabel(servicesState), 'Zur Prüfung');
  assert.equal(getPrimarySetupActionLabel(reviewState), 'Jetzt speichern');
});

test('review step is blocked until the full draft validates', () => {
  const defaults = createDefaultConfig();
  const state = validateSetupWizardState(createSampleState({
    activeStepId: 'services',
    config: {
      ...defaults,
      httpPort: '',
      schedule: {
        ...defaults.schedule,
        timezone: 'Europe/Berlin'
      }
    }
  }));

  const nextState = goToNextSetupStep(state);

  assert.equal(nextState.activeStepId, 'services');
  assert.equal(nextState.validation.steps.basics.valid, false);
  assert.equal(nextState.validation.steps.services.valid, true);
});

test('import validation rejects configs that still miss required setup fields', () => {
  const defaults = createDefaultConfig();
  const state = createSampleState();
  const imported = validateSetupSubmissionConfig({
    ...defaults,
    httpPort: 8080,
    victron: {
      ...defaults.victron,
      transport: 'mqtt',
      host: '',
      mqtt: {
        ...defaults.victron.mqtt,
        broker: '',
        portalId: ''
      }
    },
    modbusListenPort: '',
    schedule: {
      ...defaults.schedule,
      timezone: ''
    }
  }, state);

  assert.equal(imported.validation.isBlocking, true);
  assert.equal(imported.validation.steps.transport.valid, false);
  assert.equal(imported.validation.steps.dv.valid, false);
  assert.equal(imported.validation.steps.services.valid, false);
  assert.match(imported.validation.fields['victron.mqtt.portalId'][0], /Portal ID/i);
});

test('save outcome highlights warnings and restart-sensitive transport changes', () => {
  const outcome = buildSetupSaveOutcome({
    meta: {
      warnings: [
        'victron.mqtt.portalId wurde normalisiert',
        'influx.db wurde auf den Standardwert gesetzt'
      ]
    },
    restartRequired: true,
    restartRequiredPaths: ['victron.transport', 'victron.mqtt.portalId', 'modbusListenPort']
  }, 'setup');

  assert.equal(outcome.kind, 'warn');
  assert.match(outcome.banner, /Dienst-Neustart/i);
  assert.match(outcome.summary, /erst nach einem Dienst-Neustart/i);
  assert.deepEqual(Array.from(outcome.warnings), [
    'victron.mqtt.portalId wurde normalisiert',
    'influx.db wurde auf den Standardwert gesetzt'
  ]);
  assert.match(outcome.restartItems.join(' '), /Victron-Transport/i);
  assert.match(outcome.restartItems.join(' '), /DV Modbus Proxy/i);
  assert.equal(outcome.redirectUrl, '/settings.html?setup=done');
  assert.match(outcome.banner, /Weiterleitung zur Einrichtung/i);
  assert.match(outcome.nextSteps.join(' '), /Einrichtung/i);
});

test('import outcome uses import-specific completion copy', () => {
  const outcome = buildSetupSaveOutcome({
    meta: { warnings: [] },
    restartRequired: false,
    restartRequiredPaths: []
  }, 'import');

  assert.equal(outcome.kind, 'success');
  assert.match(outcome.title, /Config importiert/i);
  assert.match(outcome.banner, /Weiterleitung zur Einrichtung/i);
  assert.match(outcome.nextSteps.join(' '), /Einrichtung/i);
});
