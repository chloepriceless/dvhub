// vendor-profile-diff: Migrations-Helfer für <name>.dist. classifyDiff() teilt in
// added/changed/removed; mergeAdditions() übernimmt NUR neue Felder, nie
// überschreibend (deine Anpassungen bleiben). Bildet das reale prod-Szenario ab
// (victron.json: alarms neu, broker/maxDischargeW = Operator-Edit).

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyDiff, mergeAdditions } from '../../scripts/vendor-profile-diff.mjs';

test('classifyDiff: added / changed / removed', () => {
  const active = { victron: { mqtt: { broker: 'mqtt://203.0.113.19:1883' } }, points: { maxDischargeW: { address: 2704 } } };
  const dist = { victron: { mqtt: { broker: 'mqtt://192.168.1.10:1883' }, alarms: { enabled: true, vebusUnitId: null } } };
  const { added, changed, removed } = classifyDiff(active, dist);
  assert.deepEqual(added.map((x) => x.path), ['victron.alarms.enabled', 'victron.alarms.vebusUnitId']);
  assert.deepEqual(changed.map((x) => x.path), ['victron.mqtt.broker']); // Operator-Edit
  assert.deepEqual(removed.map((x) => x.path), ['points.maxDischargeW.address']); // Operator-Zusatz
});

test('mergeAdditions adds ONLY new fields, never touching edited/existing ones', () => {
  const active = {
    victron: { mqtt: { broker: 'mqtt://203.0.113.19:1883' } },
    points: { maxDischargeW: { enabled: true, address: 2704 } }
  };
  const dist = {
    victron: { mqtt: { broker: 'mqtt://192.168.1.10:1883' }, alarms: { enabled: true, pollIntervalMs: 30000 } }
  };
  const { merged, addedTopLevel } = mergeAdditions(active, dist);
  // Neu übernommen:
  assert.deepEqual(merged.victron.alarms, { enabled: true, pollIntervalMs: 30000 });
  // Operator-Edits UNANGETASTET:
  assert.equal(merged.victron.mqtt.broker, 'mqtt://203.0.113.19:1883', 'broker-IP bleibt');
  assert.deepEqual(merged.points.maxDischargeW, { enabled: true, address: 2704 }, 'maxDischargeW bleibt');
  assert.ok(addedTopLevel.includes('victron.alarms'));
});

test('mergeAdditions is a no-op when dist adds nothing new', () => {
  const active = { victron: { mqtt: { broker: 'x' } } };
  const dist = { victron: { mqtt: { broker: 'y' } } }; // nur geändert, nichts neu
  const { merged, addedTopLevel } = mergeAdditions(active, dist);
  assert.deepEqual(merged, active, 'geänderte Werte werden NICHT übernommen');
  assert.deepEqual(addedTopLevel, []);
});
