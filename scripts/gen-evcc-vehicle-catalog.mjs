#!/usr/bin/env node
// Erzeugt den Fahrzeugkatalog für den evcc-Fahrzeugtreiber in DVhub
// (dvhub/services/vehicle-evcc/catalog.json) aus evccs eigener Vorlagen-API.
//
// Quelle (je evcc-Version einmal, z. B. lokal in Docker/Colima):
//   docker run -d --rm --name evcc-tpl -p 127.0.0.1:17070:7070 evcc/evcc:<VERSION>
//   PUT  /api/auth/password {"current":"","new":"<pw>"}   (Wegwerf-Passwort)
//   POST /api/auth/login {"password":"<pw>"}               (Cookie)
//   GET  /api/config/templates/vehicle?lang=de  > templates.json
//   GET  /api/config/products/vehicle?lang=de   > products.json
//   docker stop evcc-tpl
// Aufruf:
//   node scripts/gen-evcc-vehicle-catalog.mjs <VERSION> templates.json products.json
//
// Aufgenommen wird, was DVhub über die Oberfläche einrichten kann: keine
// Vorlagen mit Browser-Anmeldung (OAuth → nur in evccs eigener Oberfläche),
// keine mit evcc-Sponsor-Pflicht, keine ohne Nutzen (offline, iso15118,
// teslamate — TeslaMate kann DVhub selbst). Felder ohne „advanced“ und ohne
// die evcc-Ladepunkt-Felder (Titel, Icon, Phasen, Ströme …).
import fs from 'node:fs';
import path from 'node:path';

const [version, tplFile, prodFile] = process.argv.slice(2);
if (!version || !tplFile || !prodFile) {
  console.error('Aufruf: node scripts/gen-evcc-vehicle-catalog.mjs <VERSION> templates.json products.json');
  process.exit(2);
}
const templates = JSON.parse(fs.readFileSync(tplFile, 'utf8'));
const products = JSON.parse(fs.readFileSync(prodFile, 'utf8'));

const USELESS = new Set(['offline', 'iso15118', 'teslamate', 'outlanderphev', 'homeassistant']);
const SKIP_PARAMS = new Set(['title', 'icon', 'capacity', 'phases', 'mode', 'minCurrent', 'maxCurrent', 'maxPower', 'identifiers', 'priority', 'cache']);

function excluded(t) {
  if (USELESS.has(t.Template)) return 'ohne Nutzen für DVhub';
  if (t.Auth) return 'Anmeldung im Browser (nur in evccs eigener Oberfläche)';
  if (String(t.Requirements?.EVCC || '').includes('sponsorship')) return 'braucht evcc-Sponsor-Lizenz';
  return null;
}

const cleanText = (s) => String(s || '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/\s+\n/g, '\n').trim();

const out = { evccVersion: version, generatedAt: new Date().toISOString().slice(0, 10), templates: [], excluded: [] };
for (const t of templates) {
  const reason = excluded(t);
  const brands = [...new Set((t.Products || []).map((p) => p.Brand).filter(Boolean))];
  if (reason) { out.excluded.push({ template: t.Template, brands, reason }); continue; }
  const params = (t.Params || [])
    .filter((p) => !p.Advanced && !p.Deprecated && !SKIP_PARAMS.has(p.Name))
    .map((p) => {
      const o = { name: p.Name, label: p.Description || p.Name };
      if (p.Help) o.help = cleanText(p.Help);
      if (p.Required) o.required = true;
      if (p.Mask) o.secret = true;
      if (p.Type && p.Type !== 'String') o.type = p.Type.toLowerCase();
      if (p.Example) o.example = String(p.Example);
      if (p.Default !== undefined && p.Default !== '') o.default = p.Default;
      if (Array.isArray(p.Choice) && p.Choice.length) o.choice = p.Choice;
      if (p.Unit) o.unit = p.Unit;
      return o;
    });
  out.templates.push({
    template: t.Template,
    brands,
    note: cleanText(t.Requirements?.Description).slice(0, 600) || undefined,
    params,
  });
}
const included = new Set(out.templates.map((t) => t.template));
out.products = products.filter((p) => included.has(p.template)).map((p) => ({ name: p.name, template: p.template }));
// Vorlagen ohne Produkt-Eintrag (generische wie ovms, evnotify) unter ihrem Namen anbieten.
for (const t of out.templates) {
  if (!out.products.some((p) => p.template === t.template)) out.products.push({ name: t.brands[0] || t.template, template: t.template });
}
out.products.sort((a, b) => a.name.localeCompare(b.name, 'de'));

const target = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dvhub', 'services', 'vehicle-evcc', 'catalog.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out, null, 1) + '\n');
console.log(`${target}: ${out.templates.length} Vorlagen, ${out.products.length} Einträge, ${out.excluded.length} ausgelassen`);
