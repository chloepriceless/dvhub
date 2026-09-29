import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDefaultConfig, getConfigDefinition, normalizeConfigInput, detectRestartRequired, loadConfigFile } from '../config-model.js';

// Issue #5: victron.acPvSource wählt den AC-PV-Registerblock des GX (unit-id 100)
// nach Verdrahtungsposition: on-output 808, on-grid 811, on-genset 814. Löst den
// Fall „AC-Wechselrichter am Netz-Eingang erscheint als Netzbezug".
test('Issue #5: victron.acPvSource mappt AC-PV-Registeradressen (output/grid/genset)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-acpv-'));
  const cfgPath = path.join(dir, 'config.json');
  try {
    for (const [src, base] of Object.entries({ output: 808, grid: 811, genset: 814 })) {
      fs.writeFileSync(cfgPath, JSON.stringify({ pvCoupling: 'ac_dc', victron: { acPvSource: src } }));
      const { effectiveConfig } = loadConfigFile(cfgPath);
      assert.equal(effectiveConfig.points.acPvL1W.address, base, `${src} L1 -> ${base}`);
      assert.equal(effectiveConfig.points.acPvL2W.address, base + 1, `${src} L2`);
      assert.equal(effectiveConfig.points.acPvL3W.address, base + 2, `${src} L3`);
    }
    // Default (kein acPvSource) reproduziert 808 -> keine Verhaltensänderung.
    fs.writeFileSync(cfgPath, JSON.stringify({ pvCoupling: 'ac_dc' }));
    assert.equal(loadConfigFile(cfgPath).effectiveConfig.points.acPvL1W.address, 808, 'Default = 808 (output)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #9: MQTT (Hub + Victron-Transport) verbindet nur beim Boot; ein Aktivieren
// muss daher als restart-sensitiv gelten, sonst meldet die UI "gespeichert" ohne
// Neustart-Hinweis und der Broker bleibt getrennt.
test('detectRestartRequired: MQTT-Aktivierungspfade verlangen Neustart, weather-MQTT nicht (Issue #9)', () => {
  assert.equal(detectRestartRequired(['mqtt.enabled']).required, true);
  assert.equal(detectRestartRequired(['mqtt.broker']).required, true);
  assert.equal(detectRestartRequired(['victron.mqtt.broker']).required, true);
  assert.equal(detectRestartRequired(['victron.transport']).required, true);
  // Negativfall: die Wetter-MQTT-Quelle ist NICHT der Broker-Hub -> kein Neustart.
  assert.equal(detectRestartRequired(['forecast.weather.mqtt.brokerUrl']).required, false);
  assert.equal(detectRestartRequired(['schedule.rules']).required, false);
});

// Smoke guard so this file always runs at least one assertion that exercises
// the module surface even if the schedule block above changes shape.
test('getConfigDefinition and createDefaultConfig remain importable', () => {
  assert.equal(typeof getConfigDefinition, 'function');
  const defaults = createDefaultConfig();
  assert.ok(defaults && typeof defaults === 'object');
});

// --- Phase 24-02: sichere Out-of-Box-Security-Defaults (Wave-0-Assertions) ---
//
// 24-01-AUDIT zeigt: die root-fähige VPN-Apply-Route hängt am
// `security.lanTrust:'open'`-Default — ein Neuinstall lässt out-of-box jeden
// LAN-Client token-frei schreiben/admin/VPN steuern. Diese Wave-0-Assertions
// nageln die sichere Default-Posture für `createDefaultConfig` (Neuinstalls)
// fest. BEACHTE die Verschachtelung: `cfg.security.lanTrust` liegt im
// security-Block, aber `cfg.allowedHosts`/`cfg.corsAllowedOrigins`/
// `cfg.trustProxy`/`cfg.trustedProxyIps` sind Geschwister EINE Ebene höher.
test('Phase 24-02: createDefaultConfig liefert eine sichere LAN-Trust-Default-Posture', () => {
  const cfg = createDefaultConfig();

  // Christin-Entscheid 2026-07-09: LAN-Appliance-Default = 'open' (kein Token im
  // Heimnetz; die Token-Hürde verwirrte Endkunden, GH #7). Bewusste Umkehr des
  // 'restricted'-Defaults aus Phase 24-02.
  assert.equal(
    cfg.security.lanTrust,
    'open',
    'Neuinstall-Default lanTrust ist "open" (LAN ohne Token, Christin 2026-07-09)'
  );

  // Feld-Coverage-Assertions: die übrigen Security-Default-Felder bleiben auf
  // ihren konservativen Out-of-Box-Werten (DNS-Rebinding-Schutz NICHT vorbefüllt,
  // kein Reverse-Proxy-Vertrauen ohne Operator-Opt-in).
  assert.deepEqual(
    cfg.allowedHosts,
    [],
    'allowedHosts bleibt out-of-box leer (Vorbefüllung ist Setup-Wizard-Logik, kein Default)'
  );
  assert.deepEqual(
    cfg.corsAllowedOrigins,
    [],
    'corsAllowedOrigins bleibt out-of-box leer'
  );
  assert.equal(
    cfg.trustProxy,
    false,
    'trustProxy bleibt out-of-box false (kein Reverse-Proxy-Vertrauen ohne Operator-Opt-in)'
  );
});

// Single-floor model (2026-06-16): the misleading soft `optimizer.minSocPct`
// knob was retired from the settings UI — it never governed the EOS control
// path (EOS discharges to optimizer.hardFloorSocPct), so showing it as
// "Min. SOC — der Optimizer entlädt nie unter diesen Wert" was a footgun. The
// hard floor is now the ONE operator-facing discharge floor. Guard against the
// soft knob being reintroduced as a UI field.
test('single-floor model: no optimizer.minSocPct UI field, hard floor present', () => {
  const def = getConfigDefinition();
  const optPaths = (def.fields || [])
    .map((f) => f && f.path)
    .filter((p) => typeof p === 'string' && p.startsWith('optimizer.'));
  assert.equal(
    optPaths.includes('optimizer.minSocPct'),
    false,
    'optimizer.minSocPct must NOT be a settings field (retired soft floor)'
  );
  assert.equal(
    optPaths.includes('optimizer.hardFloorSocPct'),
    true,
    'optimizer.hardFloorSocPct must remain the single discharge floor'
  );
});

// --- Phase 26-04: schedule.timezone / epex.timezone Intl-Guard (warn+reset) ---
//
// schedule.timezone (:962) und epex.timezone (:2201) sind Freitext-Felder. Ein
// ungültiger Wert (z. B. 'Europe/Berln') erreicht später new Intl.DateTimeFormat
// ({ timeZone }) in formatLocalDate/localMinutesOfDay und wirft dort RangeError.
// validateConfigSchema läuft VOR deepMerge — der Reset auf Europe/Berlin hier
// sorgt dafür, dass der Merge den gültigen Default trägt und downstream kein
// RangeError-fähiger Wert ankommt. RED bis 26-04 Task 2 den Guard ergänzt.

const DEFAULT_TZ = 'Europe/Berlin';

test('26-04 Test A: ungültige schedule.timezone → warn+reset auf Europe/Berlin', () => {
  const normalized = normalizeConfigInput({
    schedule: { timezone: 'Europe/Berln' }
  });
  assert.equal(
    normalized.rawConfig.schedule.timezone,
    DEFAULT_TZ,
    'ungültige schedule.timezone muss auf Europe/Berlin zurückgesetzt werden'
  );
  assert.equal(
    normalized.persistedConfig.schedule.timezone,
    DEFAULT_TZ,
    'nach deepMerge muss der gültige Default getragen werden'
  );
  assert.ok(
    normalized.warnings.some((w) => /schedule\.timezone/.test(String(w))),
    'eine Warnung muss schedule.timezone referenzieren'
  );
});

test('26-04 Test B: ungültige epex.timezone → warn+reset auf Europe/Berlin', () => {
  const normalized = normalizeConfigInput({
    epex: { timezone: 'Nonsense/Zone' }
  });
  assert.equal(
    normalized.rawConfig.epex.timezone,
    DEFAULT_TZ,
    'ungültige epex.timezone muss auf Europe/Berlin zurückgesetzt werden'
  );
  assert.equal(
    normalized.persistedConfig.epex.timezone,
    DEFAULT_TZ
  );
  assert.ok(
    normalized.warnings.some((w) => /epex\.timezone/.test(String(w))),
    'eine Warnung muss epex.timezone referenzieren'
  );
});

test('26-04 Test C: gültige IANA-TZ (America/New_York) bleibt unverändert, keine TZ-Warnung', () => {
  const normalized = normalizeConfigInput({
    schedule: { timezone: 'America/New_York' }
  });
  assert.equal(
    normalized.rawConfig.schedule.timezone,
    'America/New_York',
    'eine gültige IANA-Zone darf NICHT zurückgesetzt werden'
  );
  assert.equal(
    normalized.persistedConfig.schedule.timezone,
    'America/New_York'
  );
  assert.equal(
    normalized.warnings.some((w) => /timezone/.test(String(w))),
    false,
    'für eine gültige Zone darf KEINE timezone-Warnung erscheinen'
  );
});

test('26-04 Test D: kein RangeError downstream nach Reset einer ungültigen TZ', () => {
  const normalized = normalizeConfigInput({
    schedule: { timezone: 'Europe/Berln' }
  });
  const tz = normalized.persistedConfig.schedule.timezone;
  // Der downstream-Pfad (formatLocalDate/localMinutesOfDay) baut genau dieses
  // Intl-Objekt. Nach dem Reset muss es ohne RangeError konstruierbar sein.
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  }, 'die zurückgesetzte Zeitzone darf in Intl.DateTimeFormat keinen RangeError werfen');
});

// --- T-DEFAULT-PLACEHOLDER: defaults reisen in der Definition mit ------------
// Leere GUI-Felder zeigen ihren wirksamen Default als Platzhalter „Standard: X".
// Quelle ist getConfigDefinition().defaults (= createDefaultConfig()).
test('getConfigDefinition liefert defaults (kanonisches Default-Objekt) mit', () => {
  const def = getConfigDefinition();
  assert.ok(def.defaults, 'defaults-Property vorhanden');
  assert.equal(def.defaults.httpPort, createDefaultConfig().httpPort);
  assert.equal(def.defaults.schedule.controlKeepaliveMs, 5000);
  assert.equal(def.defaults.schedule.controlWriteVerify.enabled, false,
    'T-VERIFY default OFF reist mit (Opt-in bleibt sichtbar)');
  // Frische Kopie, kein geteilter Zustand:
  def.defaults.httpPort = 99999;
  assert.notEqual(getConfigDefinition().defaults.httpPort, 99999);
});

// --- T-MQTT-BROKER-TYPO (Kundenfall 2026-09-29) --------------------------------
// Ein vertippter Broker-Port (1833 statt 1883) kappte still den kompletten
// Steuerpfad; im Leitstand war nur „MQTT nicht verbunden" sichtbar. Die
// Broker-URL-Felder werden jetzt beim Normalisieren geprüft.

test('broker port typo (1833) produces a warning referencing victron.mqtt.broker', () => {
  const normalized = normalizeConfigInput({
    victron: { mqtt: { broker: 'mqtt://192.168.155.72:1833' } }
  });
  assert.ok(
    normalized.warnings.some((w) => /victron\.mqtt\.broker/.test(String(w)) && /1833/.test(String(w))),
    `erwartete Warnung zu victron.mqtt.broker, kam: ${JSON.stringify(normalized.warnings)}`
  );
  assert.equal(
    normalized.persistedConfig.victron.mqtt.broker,
    'mqtt://192.168.155.72:1833',
    'Warnung darf den Wert nicht verlieren (Custom-Port bleibt möglich)'
  );
});

test('broker schema gets normalized to lowercase (MQTT:// → mqtt://)', () => {
  const normalized = normalizeConfigInput({
    victron: { mqtt: { broker: 'MQTT://192.168.155.72:1883' } }
  });
  assert.equal(normalized.persistedConfig.victron.mqtt.broker, 'mqtt://192.168.155.72:1883');
  assert.equal(
    normalized.warnings.some((w) => /victron\.mqtt\.broker/.test(String(w))),
    false,
    'Großschreibung ist korrigierbar und braucht keine Warnung, wenn der Port stimmt'
  );
});

test('standard broker URL stays silent', () => {
  const normalized = normalizeConfigInput({
    mqtt: { brokerUrl: 'mqtt://192.168.155.72:1883' },
    victron: { mqtt: { broker: 'mqtts://broker.example:8883' } }
  });
  assert.equal(
    normalized.warnings.some((w) => /broker/i.test(String(w))),
    false,
    `keine Broker-Warnung erwartet, kam: ${JSON.stringify(normalized.warnings)}`
  );
});

test('unparseable broker URL warns but does not invalidate the config', () => {
  const normalized = normalizeConfigInput({
    mqtt: { brokerUrl: '192.168.155.72:1883' }
  });
  assert.ok(
    normalized.warnings.some((w) => /mqtt\.brokerUrl/.test(String(w))),
    `erwartete Warnung zu mqtt.brokerUrl, kam: ${JSON.stringify(normalized.warnings)}`
  );
  assert.equal(normalized.persistedConfig.mqtt.brokerUrl, '192.168.155.72:1883');
});

test('wrong scheme (http://) on a broker field warns', () => {
  const normalized = normalizeConfigInput({
    victron: { mqttCrossCheck: { broker: 'http://192.168.155.72:1883' } }
  });
  assert.ok(
    normalized.warnings.some((w) => /victron\.mqttCrossCheck\.broker/.test(String(w))),
    `erwartete Warnung zu victron.mqttCrossCheck.broker, kam: ${JSON.stringify(normalized.warnings)}`
  );
});

test('empty broker field (default-from-host path) stays silent', () => {
  const normalized = normalizeConfigInput({
    victron: { mqtt: { broker: '' } }
  });
  assert.equal(
    normalized.warnings.some((w) => /victron\.mqtt\.broker/.test(String(w))),
    false
  );
});

test('websocket broker URLs (ws://…:8083/mqtt) bekommen keinen Port-Hinweis', () => {
  // EMQX-Default 8083 / mosquitto-WS 9001 sind legitim — der Hinweis waer ein
  // False-Positive und wuerde Admins bei jedem Speichern zumuellen.
  const normalized = normalizeConfigInput({
    victron: { mqtt: { broker: 'ws://192.168.1.9:8083/mqtt' } },
    mqtt: { brokerUrl: 'ws://192.168.1.9:9001' }
  });
  assert.equal(
    normalized.warnings.some((w) => /broker/i.test(String(w))),
    false,
    `keine Broker-Warnung bei ws-Ports erwartet, kam: ${JSON.stringify(normalized.warnings)}`
  );
});

// Regression (Selbst-Review 2026-09-30): der Warn-Text enthält den
// Nutzereingabe-Rohwert. Ein Newline darin würde im Leitstand/Audit eine
// zusätzliche (gefälschte) Log-Zeile erzeugen.
test('broker warning escapes newlines from user input (no log forging)', () => {
  const normalized = normalizeConfigInput({
    mqtt: { brokerUrl: 'kaputt\n/api/log?forge=1' }
  });
  const brokerWarnings = normalized.warnings.filter((w) => /broker/i.test(String(w)));
  assert.equal(brokerWarnings.length, 1, `genau eine Broker-Warnung erwartet, kam: ${JSON.stringify(normalized.warnings)}`);
  assert.ok(!/[\r\n]/.test(brokerWarnings[0]),
    `Warnung darf kein Roh-Newline enthalten (Log-Fälschung): ${JSON.stringify(brokerWarnings[0])}`);
  assert.equal(normalized.persistedConfig.mqtt.brokerUrl, 'kaputt\n/api/log?forge=1',
    'Wert bleibt erhalten, nur die Warnung ist escaped');
});

// Regression (Selbst-Review Runde 2, 2026-09-30): der unparseable-Zweig gab den
// Rohwert zurück — bei kaputten URLs mit Zugangsdaten stand das Passwort im
// Leitstand/Audit (Regel: Secrets nie ins Log).
test('broker warning masks credentials in unparseable URLs', () => {
  const normalized = normalizeConfigInput({
    mqtt: { brokerUrl: 'mqtt://u:g3heim@broken host:1883' }
  });
  const brokerWarnings = normalized.warnings.filter((w) => /broker/i.test(String(w)));
  assert.equal(brokerWarnings.length, 1, `genau eine Broker-Warnung erwartet, kam: ${JSON.stringify(normalized.warnings)}`);
  assert.ok(!brokerWarnings[0].includes('g3heim'),
    `Passwort darf nicht in der Warnung auftauchen: ${brokerWarnings[0]}`);
  assert.equal(normalized.persistedConfig.mqtt.brokerUrl, 'mqtt://u:g3heim@broken host:1883',
    'Wert selbst bleibt unangetastet (Nutzer soll ihn korrigieren können)');
});

// Codex-Review 2026-09-29: Schwärzung per Regex versagte bei Leerzeichen im
// Passwort ("my secret") — der Rohwert wird deshalb gar nicht mehr ausgegeben.
test('broker warning never echoes the raw value (password with spaces, no @, garbage)', () => {
  for (const broker of ['mqtt://u:my secret@broken host:1883', 'mqtt://nur-passwort geheimXYZ', 'geheimXYZ ohne schema']) {
    const normalized = normalizeConfigInput({ victron: { mqtt: { broker } } });
    const w = normalized.warnings.filter((x) => /victron\.mqtt\.broker/.test(String(x)));
    assert.equal(w.length, 1, `eine Warnung erwartet für ${JSON.stringify(broker)}: ${JSON.stringify(normalized.warnings)}`);
    assert.ok(!/secret|geheimXYZ/.test(w[0]), `Rohwert/Passwort in der Warnung: ${w[0]}`);
  }
});
