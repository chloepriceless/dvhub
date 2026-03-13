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
  applyDiscoveredSystemToSetupState,
  buildSetupFieldRenderModel,
  buildSetupSaveOutcome,
  buildSetupReviewSnapshot,
  collectInheritedDvControlNotes,
  collectInheritedMeterNotes,
  createSetupDiscoveryState,
  createSetupWizardState,
  describeSetupStep,
  formatSetupDiscoveredSystemOption,
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
  let state = createSampleState({
    config: { manufacturer: 'victron', victron: { host: '' } }
  });

  state = setActiveSetupStep(state, 'transport');
  state = goToNextSetupStep(state);

  assert.equal(state.activeStepId, 'transport');
  assert.equal(state.validation.steps.transport.valid, false);
  assert.ok(state.validation.summary.some((entry) => entry.path === 'victron.host'));
});

test('transport step guidance explains the manufacturer profile flow', () => {
  const state = setActiveSetupStep(createSampleState(), 'transport');
  const copy = describeSetupStep(state);

  assert.match(copy.highlight.title, /Hersteller|Anlagenadresse/i);
  assert.match(copy.highlight.body, /Herstellerdatei/i);
  assert.match(copy.note, /Herstellerdatei/i);
  assert.equal(copy.progressLabel, 'Schritt 2 von 5');
});

test('plant setup step only exposes manufacturer selection and host for the active Victron profile', () => {
  const state = setActiveSetupStep(createSampleState(), 'transport');
  const fieldPaths = getVisibleSetupFieldsForStep(state, 'transport').map((field) => field.path);

  assert.deepEqual(Array.from(fieldPaths), [
    'manufacturer',
    'victron.host'
  ]);
});

test('transport host field declares manufacturer-aware discovery metadata', () => {
  const definition = getConfigDefinition();
  const hostField = definition.fields.find((field) => field.path === 'victron.host');

  assert.deepEqual(hostField.discovery, {
    manufacturerPath: 'manufacturer',
    actionLabel: 'Find System IP'
  });
});

test('setup discovery helper fills the host field from the selected system without changing validation rules', () => {
  const nextState = applyDiscoveredSystemToSetupState({
    state: createSampleState({
      config: { manufacturer: 'victron', victron: { host: '' } }
    }),
    fieldPath: 'victron.host',
    selectedSystem: { id: 'a', ipv4: '192.168.1.20', ipv6: 'fe80::20', ip: '192.168.1.20' }
  });

  assert.equal(nextState.draftConfig.victron.host, '192.168.1.20');
  assert.equal(nextState.validation.steps.transport.valid, true);
});

test('setup discovery helper prefers ipv4 when a system exposes both address families', () => {
  const nextState = applyDiscoveredSystemToSetupState({
    state: createSampleState({
      config: { manufacturer: 'victron', victron: { host: '' } }
    }),
    fieldPath: 'victron.host',
    selectedSystem: { id: 'a', ipv4: '192.168.1.20', ipv6: 'fe80::20', ip: 'fe80::20' }
  });

  assert.equal(nextState.draftConfig.victron.host, '192.168.1.20');
});

test('setup transport field rendering exposes discovery UI for the host field', () => {
  const state = setActiveSetupStep(createSampleState({
    config: { manufacturer: 'victron', victron: { host: '' } }
  }), 'transport');
  const field = getVisibleSetupFieldsForStep(state, 'transport')
    .find((entry) => entry.path === 'victron.host');

  const model = buildSetupFieldRenderModel(state, field);

  assert.equal(model.discovery.visible, true);
  assert.equal(model.discovery.manufacturer, 'victron');
});

test('setup discovery option text includes both ipv4 and ipv6 when available', () => {
  const text = formatSetupDiscoveredSystemOption({
    label: 'Venus GX',
    host: 'venus.local',
    ipv4: '192.168.1.20',
    ipv6: 'fe80::20'
  });

  assert.match(text, /IPv4:\s*192\.168\.1\.20/);
  assert.match(text, /IPv6:\s*fe80::20/);
});

test('setup discovery errors leave manual host entry available', () => {
  const state = createSetupDiscoveryState({
    manufacturer: 'victron',
    error: 'network unavailable'
  });

  assert.equal(state.disabled, false);
  assert.match(state.message, /manuell/i);
});

test('manufacturer validation accepts victron and blocks unsupported manufacturers', () => {
  const valid = validateSetupWizardState(createSampleState({
    config: {
      manufacturer: 'victron',
      victron: { host: 'venus-gx.local' }
    }
  }));
  const invalid = validateSetupWizardState(createSampleState({
    config: {
      manufacturer: 'unknown',
      victron: { host: 'venus-gx.local' }
    }
  }));

  assert.equal(valid.validation.steps.transport.valid, true);
  assert.equal(invalid.validation.steps.transport.valid, false);
  assert.match(invalid.validation.fields.manufacturer[0], /Hersteller/i);
});

test('blank numeric fields stay invalid instead of coercing to zero defaults', () => {
  const defaults = createDefaultConfig();
  const state = validateSetupWizardState(createSampleState({
    config: {
      ...defaults,
      modbusListenPort: ''
    }
  }));

  assert.equal(state.validation.steps.dv.valid, false);
  assert.match(state.validation.fields.modbusListenPort[0], /Port/i);
});

test('validateSetupWizardState returns per-step and per-field blocking feedback', () => {
  const defaults = createDefaultConfig();
  const state = validateSetupWizardState(createSampleState({
    config: {
      ...defaults,
      manufacturer: '',
      modbusListenPort: ''
    }
  }));

  assert.equal(state.validation.steps.transport.valid, false);
  assert.equal(state.validation.steps.dv.valid, false);
  assert.deepEqual(
    Array.from(state.validation.fields.manufacturer),
    ['Bitte einen gültigen Hersteller wählen.']
  );
  assert.deepEqual(
    Array.from(state.validation.fields.modbusListenPort),
    ['Bitte einen gültigen Port zwischen 1 und 65535 eingeben.']
  );
});

test('collectInheritedMeterNotes describes effective inherited meter connection values', () => {
  const defaults = createDefaultConfig();
  const state = createSampleState({
    config: {
      ...defaults,
      meter: {}
    },
    effectiveConfig: {
      ...defaults,
      meter: {
        ...defaults.meter,
        host: '192.168.1.21',
        port: 502,
        unitId: 100,
        timeoutMs: 1200
      }
    }
  });

  const notes = collectInheritedMeterNotes(state);
  const summary = notes.join(' ');

  assert.match(summary, /Meter Host folgt automatisch/i);
  assert.match(summary, /192\.168\.1\.21/);
  assert.match(summary, /Port.*502/i);
  assert.match(summary, /Unit ID.*100/i);
  assert.match(summary, /Timeout.*1200/i);
});

test('collectInheritedDvControlNotes reports inherited victron target when no own register connection is set', () => {
  const defaults = createDefaultConfig();
  const state = createSampleState({
    config: {
      ...defaults,
      dvControl: {
        ...defaults.dvControl,
        feedExcessDcPv: {
          ...defaults.dvControl.feedExcessDcPv
        },
        dontFeedExcessAcPv: {
          ...defaults.dvControl.dontFeedExcessAcPv
        }
      }
    },
    effectiveConfig: {
      ...defaults,
      dvControl: {
        ...defaults.dvControl,
        feedExcessDcPv: {
          ...defaults.dvControl.feedExcessDcPv,
          host: '192.168.1.30',
          port: 502,
          unitId: 100
        },
        dontFeedExcessAcPv: {
          ...defaults.dvControl.dontFeedExcessAcPv,
          host: '192.168.1.30',
          port: 502,
          unitId: 100
        }
      }
    }
  });

  const notes = collectInheritedDvControlNotes(state);

  assert.equal(notes.length, 1);
  assert.match(notes[0], /DV-Register folgen automatisch/i);
  assert.match(notes[0], /192\.168\.1\.30:502/);
  assert.match(notes[0], /Unit 100/);
});

test('review step extends the wizard flow and summarizes key setup outcomes', () => {
  const state = createValidSetupState();

  assert.deepEqual(Array.from(state.stepOrder), ['basics', 'transport', 'dv', 'services', 'review']);

  const review = buildSetupReviewSnapshot(state);
  const sectionTitles = Array.from(review.map((section) => section.title));
  assert.deepEqual(sectionTitles, ['Webzugriff', 'Anlage', 'DV', 'Dienste']);

  const transportSection = review.find((section) => section.id === 'transport');
  assert.equal(getReviewEntryValue(transportSection, 'Hersteller'), 'victron');
  assert.equal(getReviewEntryValue(transportSection, 'Anlagenadresse'), 'venus-gx.local');
  assert.match(transportSection.notes.join(' '), /Herstellerprofil/i);

  const dvSection = review.find((section) => section.id === 'dv');
  assert.match(dvSection.notes.join(' '), /Meter Host folgt automatisch/i);
  assert.match(dvSection.notes.join(' '), /DV-Register folgen automatisch/i);

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
  const basicsState = setActiveSetupStep(validState, 'basics');
  const servicesState = setActiveSetupStep(validState, 'services');
  const reviewState = setActiveSetupStep(validState, 'review');

  assert.equal(getPrimarySetupActionLabel(basicsState), 'Zur Prüfung');
  assert.equal(getPrimarySetupActionLabel(servicesState), 'Jetzt speichern');
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
    manufacturer: 'victron',
    victron: {
      ...defaults.victron,
      host: ''
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
  assert.match(imported.validation.fields['victron.host'][0], /Anlagen-Host/i);
});

test('save outcome highlights warnings and restart-sensitive manufacturer changes', () => {
  const outcome = buildSetupSaveOutcome({
    meta: {
      warnings: [
        'manufacturer wurde normalisiert',
        'influx.db wurde auf den Standardwert gesetzt'
      ]
    },
    restartRequired: true,
    restartRequiredPaths: ['manufacturer', 'victron.host', 'modbusListenPort']
  }, 'setup');

  assert.equal(outcome.kind, 'warn');
  assert.match(outcome.banner, /Dienst-Neustart/i);
  assert.match(outcome.summary, /erst nach einem Dienst-Neustart/i);
  assert.deepEqual(Array.from(outcome.warnings), [
    'manufacturer wurde normalisiert',
    'influx.db wurde auf den Standardwert gesetzt'
  ]);
  assert.match(outcome.restartItems.join(' '), /Herstellerprofil/i);
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
