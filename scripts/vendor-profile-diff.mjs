#!/usr/bin/env node
// vendor-profile-diff.mjs — zeigt den Unterschied zwischen einem AKTIVEN
// Herstellerprofil (/etc/dvhub/hersteller/<name>) und der beim Update
// bereitgelegten neuen Version (<name>.dist), und kann auf Wunsch die NEU
// hinzugekommenen Felder sicher ins aktive Profil übernehmen.
//
// Hintergrund: der Update-Abgleich (reconcile-vendor-profiles.mjs) überschreibt
// ein vom Operator geändertes Profil NIE — die neue Version landet als
// <name>.dist daneben. Dieses Werkzeug macht die Migration nachvollziehbar:
//   node scripts/vendor-profile-diff.mjs victron.json               # nur anzeigen
//   node scripts/vendor-profile-diff.mjs victron.json --apply-additions
//                                                                    # neue Felder übernehmen (Backup!)
//
// --apply-additions fügt AUSSCHLIESSLICH Felder hinzu, die in .dist neu sind
// (z. B. eine neue alarms-Sektion) — es ändert oder entfernt NIE ein bestehendes
// Feld. Deine Anpassungen (Register, Broker-IP …) bleiben unangetastet. Alles
// andere (geänderte Werte, in .dist entfernte Felder) bleibt bewusst deine
// Entscheidung und wird nur angezeigt.

import path from 'node:path';

// Reine Helfer — unit-testbar, ohne fs.
export function flatten(obj, prefix = '') {
  const out = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) Object.assign(out, flatten(v, prefix ? `${prefix}.${k}` : k));
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => Object.assign(out, flatten(v, `${prefix}[${i}]`)));
  } else {
    out[prefix] = obj;
  }
  return out;
}

// Klassifiziert die Feld-Unterschiede zwischen active und dist.
export function classifyDiff(active, dist) {
  const fa = flatten(active);
  const fd = flatten(dist);
  const added = [];    // nur in dist (neue shipped-Felder → sicher übernehmbar)
  const removed = [];  // nur in active (deine Anpassung / in neuer Version entfernt)
  const changed = [];  // beide, anderer Wert (deine Anpassung vs. neuer Default)
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fd)])) {
    const inA = k in fa, inD = k in fd;
    if (inA && inD) { if (JSON.stringify(fa[k]) !== JSON.stringify(fd[k])) changed.push({ path: k, active: fa[k], dist: fd[k] }); }
    else if (inD) added.push({ path: k, dist: fd[k] });
    else removed.push({ path: k, active: fa[k] });
  }
  const cmp = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  return { added: added.sort(cmp), removed: removed.sort(cmp), changed: changed.sort(cmp) };
}

// Übernimmt NUR neu hinzugekommene Objekt-Zweige aus dist in active (rekursiv,
// nie überschreibend). Gibt {merged, addedTopLevel} zurück.
export function mergeAdditions(active, dist) {
  const merged = JSON.parse(JSON.stringify(active));
  const addedTopLevel = [];
  const addInto = (dst, src, trail) => {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return;
    for (const [k, v] of Object.entries(src)) {
      if (!(k in dst)) { dst[k] = JSON.parse(JSON.stringify(v)); if (trail.length <= 1) addedTopLevel.push([...trail, k].join('.')); }
      else if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
        addInto(dst[k], v, [...trail, k]);
      } // bestehendes Skalar/Array bleibt unangetastet
    }
  };
  addInto(merged, dist, []);
  return { merged, addedTopLevel };
}

// CLI
// Läuft meist als root im Ordner des Dienstbenutzers: nur im echten Ordner
// (inode-geprüft), ohne Verweisen zu folgen (Gegenprüfung ad70a264, P3).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { inRealDir, readNoFollow, writeNoFollow } = await import('./reconcile-vendor-profiles.mjs');
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  const apply = args.includes('--apply-additions');
  const configDir = process.env.CONFIG_DIR || '/etc/dvhub';
  if (!name || !/^[A-Za-z0-9._-]+\.json$/.test(name) || name.startsWith('.')) {
    console.error('usage: vendor-profile-diff.mjs <name.json> [--apply-additions]'); process.exit(2);
  }
  const herstellerDir = path.resolve(configDir, 'hersteller');
  let rc = 0;
  try {
    inRealDir(herstellerDir, () => {
      const bufA = readNoFollow(name);
      const bufD = readNoFollow(`${name}.dist`);
      for (const [buf, f] of [[bufA, name], [bufD, `${name}.dist`]]) {
        if (!buf) { console.error(`nicht gefunden oder ein Verweis: ${path.join(herstellerDir, f)}`); rc = 1; return; }
      }
      const A = JSON.parse(bufA.toString('utf8'));
      const D = JSON.parse(bufD.toString('utf8'));
      const { added, removed, changed } = classifyDiff(A, D);

      console.log(`\nHerstellerprofil ${name}: aktiv  vs  ${name}.dist (neue Version)\n`);
      console.log(`  NEU in der neuen Version (sicher übernehmbar): ${added.length}`);
      for (const x of added) console.log(`    + ${x.path} = ${JSON.stringify(x.dist)}`);
      console.log(`\n  DEINE Anpassung, in neuer Version anders (bleibt — du entscheidest): ${changed.length}`);
      for (const x of changed) console.log(`    ~ ${x.path}: deins=${JSON.stringify(x.active)}  neu=${JSON.stringify(x.dist)}`);
      console.log(`\n  NUR bei dir (in neuer Version nicht mehr vorhanden): ${removed.length}`);
      for (const x of removed) console.log(`    - ${x.path} = ${JSON.stringify(x.active)}`);

      if (!apply) {
        console.log(`\nNur angezeigt. Zum Übernehmen der ${added.length} neuen Felder (deine Anpassungen bleiben):`);
        console.log(`  node scripts/vendor-profile-diff.mjs ${name} --apply-additions`);
        return;
      }
      if (added.length === 0) { console.log('\nNichts Neues zu übernehmen.'); return; }
      const { merged, addedTopLevel } = mergeAdditions(A, D);
      const bak = `${name}.bak-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
      writeNoFollow(bak, bufA);
      writeNoFollow(name, JSON.stringify(merged, null, 2) + '\n');
      console.log(`\n✓ Übernommen: ${addedTopLevel.join(', ')}`);
      console.log(`  Backup: ${path.join(herstellerDir, bak)}`);
      console.log(`  DVhub neu starten, damit das Profil geladen wird:  systemctl restart dvhub`);
    });
  } catch (e) {
    console.error(`abgebrochen: ${e.message}`);
    rc = 1;
  }
  process.exit(rc);
}
