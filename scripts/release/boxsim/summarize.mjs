// summarize.mjs — Ergebnis-Tabelle aus den results.txt der Matrix-Fälle.
//   node summarize.mjs <run-dir>
import fs from 'node:fs';
import path from 'node:path';

const run = process.argv[2];
const kv = (line) => {
  const o = {};
  for (const m of line.matchAll(/(\w+)=('([^']*)'|"([^"]*)"|\S*)/g)) o[m[1]] = m[3] ?? m[4] ?? m[2];
  return o;
};
const rows = [];
const negs = [];
for (const d of fs.readdirSync(run).sort()) {
  const f = path.join(run, d, 'results.txt');
  if (!fs.existsSync(f)) continue;
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => ({ step: l.split(' ')[0], ...kv(l) }));
  const find = (pred) => lines.find(pred) || {};
  const all = (pred) => lines.filter(pred);
  const install = find((l) => l.step === 'install');
  const git = find((l) => l.step === 'gui-git-update');
  const jobs = all((l) => l.job);
  const mig = jobs.find((j) => j.job === 'migrate') || {};
  const upd = jobs.find((j) => j.job === 'install') || {};
  const rb = jobs.find((j) => j.job === 'rollback') || {};
  const checks = all((l) => l.step === 'check');
  const main = checks.filter((c) => !String(c.check).startsWith('neg-'));
  const bad = main.filter((c) => c.ok !== '1').map((c) => `${c.check}: ${c.bad}`);
  const changed = [...new Set(main.map((c) => c.config_changed_keys).filter((k) => k && k !== '-'))];
  const sizes = all((l) => l.step === 'sizes');
  const sz = (n) => sizes.find((x) => x.sizes === n) || {};
  const lost = find((l) => l.step === 'reseed-state').lost_by_old_git_update;
  const total = find((l) => l.total_s).total_s;
  const migratedOk = mig.state === 'ok' && main.find((c) => c.check === 'after-migration')?.ok === '1';
  const notes = [];
  if (lost) notes.push(`alte git-Oberfläche hat ${lost} weggeräumt (Altfehler, vor der Umstellung)`);
  if (changed.length) notes.push(`Config-Schlüssel geändert: ${changed.join(', ')}`);
  if (bad.length) notes.push(`Prüfungen: ${bad.join('; ')}`);
  if (mig.state && mig.state !== 'ok') notes.push(`Umstellung: ${mig.msg}`);
  rows.push({
    fall: d,
    install: install.install === '0' ? `ok (${install.time_s} s)` : `rc=${install.install ?? '?'}`,
    git: git.gui_git_update === 'true' ? `ok (${git.time_s} s)` : (git.gui_git_update ?? '—'),
    migration: mig.state ? `${mig.state} (${mig.time_s} s)` : '—',
    update: upd.state ? `${upd.state} (${upd.time_s} s)` : '—',
    rollback: rb.state ? `${rb.state} (${rb.time_s} s)` : '—',
    daten: bad.length ? 'NEIN' : (main.length ? 'ja' : '—'),
    groesse: `${sz(`git-${d.split('-')[0]}`).program_mb ?? '?'} MB / ${sz(`git-${d.split('-')[0]}`).files ?? '?'} → Release ${sz('package-after-update').current_release_mb ?? sz('package').current_release_mb ?? '?'} MB`,
    gesamt: migratedOk && upd.state === 'ok' && rb.state === 'ok' && !bad.length ? 'OK' : 'FEHLER',
    zeit: total ? `${total} s` : '?',
    notes: notes.join(' · ') || '—',
  });
  const negSteps = jobs.filter((j) => j.job === 'install').slice(1);
  if (negSteps.length) {
    const names = ['verändertes Paket', 'fremde Signatur', 'Download bricht einmal ab', 'Download bricht immer ab', 'Platte voll', 'neue Version startet nicht'];
    const negChecks = checks.filter((c) => String(c.check).startsWith('neg-'));
    negSteps.forEach((j, i) => negs.push({ fall: d, name: names[i] || `#${i}`, state: j.state, msg: j.msg, check: negChecks[i] }));
  }
}

const head = ['Fall', 'Gesamt', 'install.sh', 'git-Update (alte Oberfläche)', 'Umstellung', 'Paket-Update', 'Rückweg', 'Daten/Config/Kanal', 'Programmordner git → Release', 'Laufzeit', 'Notizen'];
console.log(`# Release-Paket-Matrix ${path.basename(run)}\n`);
console.log(`| ${head.join(' | ')} |`);
console.log(`|${head.map(() => '---').join('|')}|`);
for (const r of rows) console.log(`| ${[r.fall, r.gesamt, r.install, r.git, r.migration, r.update, r.rollback, r.daten, r.groesse, r.zeit, r.notes].join(' | ')} |`);
if (negs.length) {
  console.log('\n## Negativfälle\n');
  console.log('| Fall | Fall | Ergebnis | Meldung | Box danach |');
  console.log('|---|---|---|---|---|');
  for (const n of negs) console.log(`| ${n.fall} | ${n.name} | ${n.state} | ${n.msg} | ${n.check ? `${n.check.current}, Marker ${n.check.ok === '1' ? 'ok' : n.check.bad}` : '—'} |`);
}
