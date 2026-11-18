// services/gate/constants.js — feste Wertemengen des Node-Schreibtors (VCL-Vertrag v6, §0.2, A.5, D.1, Anhang I).
//
// Jede Menge hier steht wortgleich als `enum` in gate.schema.json; test/gate-schema.test.js bricht, wenn Code und
// Schema auseinanderlaufen. Namen der Ergebnisse (`outcome`) wie im Rust-Tor (dvhub-record/src/write.rs, Outcome).

/** Ergebnis einer Tor-Operation — dieselben acht Werte wie Rust `Outcome` (snake_case). */
export const OUTCOMES = Object.freeze([
  'ok',
  'error',
  'skipped_unchanged',
  'skipped_not_owned',
  'blocked_readonly',
  'blocked_nothalt',
  'blocked_gate',
  'shadow_suppressed',
]);

/**
 * Zustellung je Versuch (§0.2, B.5) — die vier Werte, kein fünfter. `null` im Ergebnis heißt „nicht versucht“.
 *   acked    Gegenstelle hat den Empfang quittiert (nicht: „Gerät steht im Sollzustand“)
 *   rejected nachgewiesene Nichtwirkung
 *   notSent  nachweislich nicht gesendet
 *   unknown  Wirkung unbestimmt — zählt als angekommen
 */
export const DELIVERIES = Object.freeze(['acked', 'rejected', 'notSent', 'unknown']);

/** Art der Operation (`kind`, Rust write.rs Kind). */
export const KINDS = Object.freeze(['write', 'keepalive', 'restore', 'sequenceStep', 'neutralize', 'heartbeat']);

/** Aktionsklassen (A.5). Die Klasse vergibt der Layer; ein Profil kann sie nicht wählen. */
export const ACTIONS = Object.freeze([
  'command',
  'keepalive',
  'protectiveLimit',
  'autoRestore',
  'safetyRelease',
  'haltNeutralize',
  'manualForceRelease',
]);

/** Schreibfreigabe je Gerät (D.1 Vorprüfung 4). Nur `open` lässt alles durch. */
export const RELEASE_STATES = Object.freeze(['open', 'profileInvalid', 'setupIncomplete', 'notIdentified', 'identityMismatch']);

/** Vertrauensklasse des Pfads (D.2): `legacy` ist eine eigene Klasse, nie `guarded`, nie automatisch hochgestuft. */
export const TRUST = Object.freeze(['legacy', 'contract']);

/** Takt-Namen wie Rust `Loop` (dvhub-record/src/write.rs) — nötig, damit Node- und Rust-Ereignisse vergleichbar sind. */
export const LOOPS = Object.freeze(['poll', 'eval', 'zfi', 'multigx', 'ev_bridge', 'device_bridge', 'eebus', 'mypv', 'event']);

/** Die acht Vorprüfungen in fester Reihenfolge (D.1). Der Name steht im Ergebnis als `blockedBy`. */
export const PRE_CHECKS = Object.freeze([
  'halt',        // 1 Not-Halt
  'deadline',    // 2 Frist abgelaufen
  'readOnly',    // 3 Lese-Modus
  'release',     // 4 Schreibfreigabe je Gerät
  'target',      // 5 unbekanntes Ziel, Freigabestufe
  'lease',       // 6 Lease: Epoche aktuell, Ressource passt zum Punkt
  'constraint',  // 7 Einschränkung (Phase 1: nur Schnittstelle)
  'unchanged',   // 8 unverändert → kein Write
]);

/** Geschlossene Schlüsselmenge einer GateOp (IOP-4); `x-`/`_`-Schlüssel werden ignoriert. */
export const GATE_OP_KEYS = Object.freeze([
  'device', 'point', 'value', 'requested', 'source', 'kind', 'action', 'lease', 'constraints',
  'validUntilMs', 'tick', 'step', 'ruleId', 'confirmedBy', 'legacy',
]);

/** Aktionsklassen, die eine Lease brauchen (A.5, Spalte „Lease“). */
export const LEASE_REQUIRED = Object.freeze(new Set(['command', 'keepalive', 'protectiveLimit', 'autoRestore', 'safetyRelease']));

/** Bei `profileInvalid` gesperrte Aktionsklassen (D.1 R-T2.2). `safetyRelease` darf einmal je Punkt (R-T2.3). */
export const BLOCKED_WHEN_PROFILE_INVALID = Object.freeze(new Set(['command', 'keepalive', 'protectiveLimit', 'autoRestore']));

/** Zusatzgründe (`detail`) — Rust-Namen, wo es sie gibt (`not_halt`, `expired`, `read_only`, …). */
export const DETAIL = Object.freeze({
  invalidOp: 'invalid_op',
  notHalt: 'not_halt',
  haltStateUnknown: 'halt_state_unknown',
  fenced: 'fenced',
  neverNeutralized: 'never_neutralized',
  neutralizeNotNeutral: 'neutralize_not_neutral',
  forceReleaseUnconfirmed: 'force_release_unconfirmed',
  forceReleaseNotNeutral: 'force_release_not_neutral',
  neutralizeOutsideHalt: 'neutralize_outside_halt',
  expired: 'expired',
  readOnly: 'read_only',
  readOnlyStateUnknown: 'read_only_state_unknown',
  profileInvalid: 'profile_invalid',
  setupIncomplete: 'setup_incomplete',
  notIdentified: 'not_identified',
  identityMismatch: 'identity_mismatch',
  releasePassDone: 'release_pass_done',
  unknownTarget: 'unknown_target',
  stageNotReleased: 'stage_not_released',
  leaseMissing: 'lease_missing',
  leaseResourceMismatch: 'lease_resource_mismatch',
  leaseEpochStale: 'lease_epoch_stale',
  epochStale: 'epoch_stale',
  notControlled: 'not_controlled',
  constraint: 'constraint',
  noSink: 'no_sink',
  gateError: 'gate_error',
  pickupPending: 'pickupPending',
  noAck: 'no_ack',
});

/** `detail` je Freigabezustand (Vorprüfung 4). */
export const RELEASE_DETAIL = Object.freeze({
  profileInvalid: DETAIL.profileInvalid,
  setupIncomplete: DETAIL.setupIncomplete,
  notIdentified: DETAIL.notIdentified,
  identityMismatch: DETAIL.identityMismatch,
});
