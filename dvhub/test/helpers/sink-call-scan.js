// test/helpers/sink-call-scan.js — findet Schreibaufrufe an Senken im Produktivcode (VCL-Vertrag v6 D.1 R-T1).
//
// Ein Fund ist (Datei, Funktion, Senke) plus die Zahl der Aufrufstellen darin — ohne Zeilennummer, damit die
// Ausnahmeliste stabil bleibt, aber ein zweiter Direktaufruf in einer schon gelisteten Funktion auffällt (Codex
// 39b19e4a P2). „Funktion“ ist die Kette der benannten umschließenden Funktionen (`createSungrowEms>writeReg`),
// anonyme Rückrufe zählen zur nächsten benannten Funktion; auf Modulebene `<module>`.
//
// Erkannt werden (AST, acorn — der Parser unter ESLint):
//   mbWriteSingle | mbWriteMultiple | mbWriteCoil   Modbus-Schreibfunktionen (Aufruf, Weitergabe, Destrukturierung)
//   mqttWrite                                       MQTT-Schreibfunktion des Transports
//   publish                                         jeder `.publish(`/`.publishAsync(`-Aufruf (Steuer- oder nicht:
//                                                   statisch nicht trennbar → jede Stelle muss eingeordnet sein)
//   pickup:<fn>                                     Abholpuffer für Loxone/HA (services/control-snapshot.js)
//   writeReg                                        Sungrow-Registerschreiber am Tor vorbei (bis Phase 2; seither
//                                                   heißt er submitReg und reicht über gate.submit() ein — ein neuer
//                                                   writeReg-Aufruf wäre wieder ein Direktweg)
//   callAction                                      OCPP-Befehl an die Wallbox
//   und nur in den Geräteadaptern (Wallbox, Schaltgeräte, myPV, EEBUS, evcc):
//   http | send | stdin.write                       rohe HTTP-Anfrage, WebSocket-Rahmen, EEBUS-Brücke
//
// Ohne `services/gate/` (das Tor selbst), Tests, Frontend (public/, läuft im Browser) und node_modules.
// Aufruf zum Ansehen der aktuellen Funde:  node test/helpers/sink-call-scan.js

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as acorn from 'acorn';

export const DVHUB_DIR = path.resolve(import.meta.dirname, '..', '..');

const SKIP_DIRS = new Set(['node_modules', 'test', 'public', 'python', '.git', 'test-results']);
const GATE_DIR = path.join('services', 'gate') + path.sep;

const MODBUS_WRITES = new Set(['mbWriteSingle', 'mbWriteMultiple', 'mbWriteCoil']);
const MQTT_WRITES = new Set(['mqttWrite']);
const PUBLISH = new Set(['publish', 'publishAsync']);
const PICKUP = new Set(['buildControlSnapshot', 'controlSnapshotFlat', 'buildGridLimitSnapshot', 'gridLimitSnapshotFlat']);
const HTTP_FN = new Set(['fetch', 'outboundFetch']);
const HTTP_MODULES = new Set(['http', 'https', 'client']);

/** Geräteadapter nach D.1 (Zeile „myPV, Schaltgeräte, evcc, Wallbox, OCPP, EEBUS“). */
export function isDeviceAdapterFile(rel) {
  return rel.startsWith(`services${path.sep}wallbox${path.sep}`)
    || rel.startsWith(`services${path.sep}devices${path.sep}`)
    || rel.startsWith(`services${path.sep}eebus${path.sep}`)
    || rel === 'evcc-integration.js';
}

export function* productionFiles(dir = DVHUB_DIR) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* productionFiles(p);
    else if (/\.m?js$/.test(e.name)) {
      const rel = path.relative(DVHUB_DIR, p);
      if (!rel.startsWith(GATE_DIR)) yield rel;
    }
  }
}

const staticName = (key) => {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) return String(key.value);
  return null;
};

function memberName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  if (!node.computed) return staticName(node.property);
  return node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : null;
}

const isFunction = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

function functionName(fn, parent) {
  if (fn.id?.name) return fn.id.name;
  if (!parent) return null;
  if (parent.type === 'VariableDeclarator' && parent.init === fn) return staticName(parent.id);
  if ((parent.type === 'Property' || parent.type === 'PropertyDefinition') && parent.value === fn) return staticName(parent.key);
  if (parent.type === 'MethodDefinition') return staticName(parent.key);
  if (parent.type === 'AssignmentExpression' && parent.right === fn) {
    return parent.left.type === 'Identifier' ? parent.left.name : memberName(parent.left);
  }
  if (parent.type === 'ExportDefaultDeclaration') return 'default';
  return null;
}

function chainOf(ancestors) {
  const names = [];
  for (let i = 0; i < ancestors.length; i += 1) {
    const n = ancestors[i];
    if (!isFunction(n)) continue;
    const name = functionName(n, ancestors[i - 1]);
    if (name) names.push(name);
  }
  return names.length ? names.join('>') : '<module>';
}

/** Senke an diesem Knoten, sonst null. `parent` ist der direkte Elternknoten. */
function sinkAt(node, parent, deviceScope) {
  if (node.type === 'MemberExpression') {
    const name = memberName(node);
    if (!name || (!MODBUS_WRITES.has(name) && !MQTT_WRITES.has(name))) return null;
    // `typeof t.mbWriteSingle === 'function'` ist eine Fähigkeitsabfrage, `t.mbWriteSingle = …` ein Austausch — kein Schreiben.
    if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof') return null;
    if (parent?.type === 'AssignmentExpression' && parent.left === node) return null;
    return name;
  }
  if (node.type === 'Property' && parent?.type === 'ObjectPattern') {
    // const { mbWriteSingle } = transport
    const name = staticName(node.key);
    return name && (MODBUS_WRITES.has(name) || MQTT_WRITES.has(name)) ? name : null;
  }
  if (node.type === 'Identifier' && PICKUP.has(node.name)) {
    if (!parent) return null;
    if (['ImportSpecifier', 'ExportSpecifier', 'FunctionDeclaration'].includes(parent.type)) return null;
    if (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return null;
    if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return `pickup:${node.name}`;
    return `pickup:${node.name}`;
  }
  if (node.type !== 'CallExpression') return null;
  const callee = node.callee;
  const mName = memberName(callee);
  if (mName && PUBLISH.has(mName)) return 'publish';
  if (callee.type === 'Identifier' && callee.name === 'writeReg') return 'writeReg';
  if ((callee.type === 'Identifier' && callee.name === 'callAction') || mName === 'callAction') return 'callAction';
  if (!deviceScope) return null;
  if (callee.type === 'Identifier' && HTTP_FN.has(callee.name)) return 'http';
  if ((mName === 'request' || mName === 'get') && callee.object.type === 'Identifier' && HTTP_MODULES.has(callee.object.name)) return 'http';
  if (mName === 'send') return 'send';
  if (mName === 'write' && memberName(callee.object) === 'stdin') return 'stdin.write';
  return null;
}

function walk(node, ancestors, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walk(c, ancestors, visit);
    else if (v && typeof v.type === 'string') walk(v, ancestors, visit);
  }
  ancestors.pop();
}

export function parseModule(src) {
  return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: false });
}

/** Funde in einem Quelltext: [{ fn, sink, count }] (eindeutig je fn + sink, count = Aufrufstellen). */
export function scanSource(src, { deviceScope = false } = {}) {
  const ast = parseModule(src);
  const found = new Map();
  walk(ast, [], (node, ancestors) => {
    const sink = sinkAt(node, ancestors[ancestors.length - 1], deviceScope);
    if (!sink) return;
    const fn = chainOf(ancestors);
    const key = `${fn} :: ${sink}`;
    const hit = found.get(key);
    if (hit) hit.count += 1;
    else found.set(key, { fn, sink, count: 1 });
  });
  return [...found.values()];
}

/** Alle Funde im Produktivcode, sortiert: [{ file, fn, sink, count }]. Dateipfade mit `/`. */
export function scanProduction(dir = DVHUB_DIR) {
  const out = [];
  for (const rel of productionFiles(dir)) {
    const src = fs.readFileSync(path.join(dir, rel), 'utf8');
    for (const f of scanSource(src, { deviceScope: isDeviceAdapterFile(rel) })) {
      out.push({ file: rel.split(path.sep).join('/'), ...f });
    }
  }
  return out.sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
}

export const entryKey = (e) => `${e.file} :: ${e.fn} :: ${e.sink}`;

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  for (const e of scanProduction()) console.log(`${entryKey(e)} ×${e.count}`);
}
