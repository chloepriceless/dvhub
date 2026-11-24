// test/helpers/mini-json-schema.js — kleiner JSON-Schema-Prüfer (Teilmenge von Draft 2020-12) für gate.schema.json.
//
// Unterstützt genau, was das Tor-Schema nutzt: $ref (#/$defs/…), type (auch als Liste, integer, null), enum, const,
// properties, required, additionalProperties (false/Schema), patternProperties, items, minLength, minimum, anyOf.
// Unbekannte Schlüsselwörter brechen ab — damit das Schema nicht still mehr verspricht, als hier geprüft wird.

const KNOWN = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment', 'title', 'description', 'type', 'enum', 'const', 'properties',
  'required', 'additionalProperties', 'patternProperties', 'items', 'minLength', 'minimum', 'anyOf',
]);

function typeOk(t, v) {
  switch (t) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: throw new Error(`unbekannter Typ ${t}`);
  }
}

/** @returns {string[]} Fehlerliste (leer = gültig) */
export function validate(root, schema, value, at = '$') {
  const errors = [];
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`Schlüsselwort ${k} nicht unterstützt (${at})`);
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    if (!m || !root.$defs || !Object.hasOwn(root.$defs, m[1])) throw new Error(`$ref ${schema.$ref} unauflösbar`);
    errors.push(...validate(root, root.$defs[m[1]], value, at));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) errors.push(`${at}: Typ ${JSON.stringify(schema.type)} erwartet`);
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) errors.push(`${at}: ${JSON.stringify(value)} nicht in enum`);
  if ('const' in schema && schema.const !== value) errors.push(`${at}: const ${JSON.stringify(schema.const)} erwartet`);
  if (typeof value === 'string' && schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: zu kurz`);
  if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) errors.push(`${at}: < ${schema.minimum}`);
  if (schema.anyOf && !schema.anyOf.some((s) => validate(root, s, value, at).length === 0)) errors.push(`${at}: kein anyOf passt`);
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...validate(root, schema.items, v, `${at}[${i}]`)));
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) if (!(r in value)) errors.push(`${at}: ${r} fehlt`);
    for (const [k, v] of Object.entries(value)) {
      // Nur eigene Schlüssel — `constructor`/`toString` stehen sonst über den Prototyp „im Schema“ (Codex 81133b2e P2).
      if (schema.properties && Object.hasOwn(schema.properties, k)) {
        errors.push(...validate(root, schema.properties[k], v, `${at}.${k}`));
        continue;
      }
      const pat = Object.entries(schema.patternProperties || {}).find(([p]) => new RegExp(p).test(k));
      if (pat) { errors.push(...validate(root, pat[1], v, `${at}.${k}`)); continue; }
      if (schema.additionalProperties === false) errors.push(`${at}: Schlüssel ${k} nicht erlaubt`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validate(root, schema.additionalProperties, v, `${at}.${k}`));
      }
    }
  }
  return errors;
}
