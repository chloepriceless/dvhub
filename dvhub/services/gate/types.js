// services/gate/types.js — JSDoc-Typen der Taille (VCL-Vertrag v6 §0.2, Anhang I). Nur Typen, kein Code.
//
// Die maschinenprüfbare Form derselben drei Typen steht in gate.schema.json (H-11); test/gate-schema.test.js hält
// Hash, Wertemengen und Beispiele gegen diese Datei. Abweichungen vom Entwurf in Anhang I stehen in der Datei
// gate.schema.json unter `$comment` und hier je Feld.

/**
 * @typedef {number|boolean|string} Scalar
 *   Ingenieurwert (= Rust `EngValue`). Text nur bei mehrfeldrigen Punkten als kanonisches Token (B.2).
 */

/**
 * @typedef {{
 *   noGridCharge?: boolean, noGridExport?: boolean,
 *   maxChargeW?: number|null, maxDischargeW?: number|null,
 *   socFloorPct?: number|null, socCeilPct?: number|null,
 *   gridImportMaxW?: number|null, gridExportMaxW?: number|null
 * }} Constraints  A.1 — effektiver Satz, monoton verschärfend gebildet vom Layer.
 */

/**
 * @typedef {{ set: Constraints, caps: { chargeW?: number, dischargeW?: number }, enforcedBy: string[] }} ConstraintSet
 *   A.1 K3 — Prüfgrundlage für Vorprüfung 7, nicht Beschriftung.
 */

/**
 * @typedef {{ loop: 'poll'|'eval'|'zfi'|'multigx'|'ev_bridge'|'device_bridge'|'eebus'|'mypv'|'event', seq: number }} Tick
 *   Abweichung von Anhang I (`loop: string`): Wertemenge wie Rust `Loop`, damit Ereignisse vergleichbar bleiben.
 */

/**
 * @typedef {{ sink: string, fn: string, args: unknown[] }} LegacyCall
 *   Legacy-Modus (D.2): der heutige, schon kodierte Transport-Aufruf. Das Tor reicht `args` unverändert an
 *   `sinks[sink].legacy[fn]` weiter (`fn(...args)`), damit das Verdrahten eines Pfads bit-gleich bleibt.
 *   Nicht in Anhang I — siehe gate.schema.json `$comment`.
 */

/**
 * @typedef {{
 *   device: string, point: string, value: Scalar, requested?: Scalar,
 *   source: string,
 *   kind: 'write'|'keepalive'|'restore'|'sequenceStep'|'neutralize'|'heartbeat',
 *   action: 'command'|'keepalive'|'protectiveLimit'|'autoRestore'|'safetyRelease'|'haltNeutralize'|'manualForceRelease',
 *   lease: { resource: string, epoch: number } | null,
 *   constraints: ConstraintSet,
 *   validUntilMs: number|null,
 *   tick: Tick, step: number, ruleId?: string,
 *   confirmedBy?: string,
 *   legacy?: LegacyCall|null
 * }} GateOp
 *   Anhang I.1 plus: `validUntilMs` darf `null` sein (= keine Frist, wie Rust `Option`); `confirmedBy` (wer die
 *   manuelle Zwangsfreigabe bestätigt hat, H-7); `legacy` (D.2).
 */

/**
 * @typedef {{
 *   opId: string,
 *   outcome: 'ok'|'error'|'skipped_unchanged'|'skipped_not_owned'|'blocked_readonly'|'blocked_nothalt'|'blocked_gate'|'shadow_suppressed',
 *   delivery: 'acked'|'rejected'|'notSent'|'unknown'|null,
 *   detail?: string,
 *   blockedBy?: 'shape'|'halt'|'deadline'|'readOnly'|'release'|'target'|'lease'|'constraint'|'unchanged'|'dispatch',
 *   reason?: string,
 *   exceptionCode?: number,
 *   trust: 'legacy'|'contract',
 *   delivered: boolean, pickup: boolean, possiblyEffective: boolean,
 *   result?: unknown, error?: unknown
 * }} SubmitResult
 *   Anhang I.1 `{ opId, outcome, delivery, detail? }` plus die Zusatzfelder aus B.5 (`delivered`, `pickup`,
 *   `possiblyEffective`) und der Vertrauensklasse (D.2). `result`/`error` sind die unveränderte Rückgabe bzw. der
 *   unveränderte Fehler der Senke (gleiche Referenz) — prozessintern, nicht Teil der JSON-Form.
 *   `delivery: null` = nicht versucht. `possiblyEffective` = `acked` oder `unknown`.
 */

/**
 * @typedef {{
 *   schema: 'dvhub.write/1', impl: 'node', mode: 'live',
 *   ts_ms: number, tick: Tick, decision_id: string, op_id: string,
 *   layer: 'semantic',
 *   target: { kind: string|null, device: string },
 *   point: string,
 *   value: { eng: Scalar, unit?: string, requested?: Scalar },
 *   cause: { source: string, gates: string[], rule_id?: string },
 *   kind: string, action: string, step: number,
 *   lease: { resource: string, epoch: number } | null,
 *   outcome: string, delivery: string|null,
 *   error: string|null, detail?: string,
 *   trust: 'legacy'|'contract',
 *   inputs_ref: string|null, config_rev: string|null,
 *   state_flags: { not_halt: boolean, forced_off: boolean, read_only: boolean, license_pro: boolean }
 * }} WriteEvent
 *   `dvhub.write/1` (Rust dvhub-record/schema/dvhub.write-1.schema.json) plus additive Felder `op_id`, `action`,
 *   `step`, `lease`, `delivery` (H-6), `trust`. Das Rust-Schema verbietet Zusatzfelder nicht.
 */

/**
 * @typedef {{
 *   class: string, resource?: string|null, sink?: string, targetKind?: string, unit?: string,
 *   neutral?: { kind: 'never' } | { kind: 'fixed', value: Scalar } | { kind: 'restoreBefore', fallback?: Scalar }
 *           | { kind: 'sequence', use: string },
 *   forceRelease?: Scalar[]
 * }} PointPolicy
 *   Richtlinie je Ziel (Rust `PointPolicy`, Anhang I). `resource` gruppiert Punkte (H-5); `neutral` fehlt = `never`
 *   (H-8: was DVhub nie gesetzt hat, wird nie neutralisiert). `forceRelease` = Literalwerte Richtung Grundzustand, die
 *   eine manuelle Zwangsfreigabe schreiben darf (H-7); bei `neutral.kind === 'fixed'` ist der feste Wert erlaubt.
 */

export {};
