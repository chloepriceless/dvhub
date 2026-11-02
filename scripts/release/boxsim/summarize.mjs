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
  const viaInstaller = find((l) => l.git_update_mode).git_update_mode === 'installer';
  const jobs = all((l) => l.job);
  // Zuordnung über die Kennung des Schritts, nicht über die Reihenfolge (Gegenprüfung ff8530d0).
  const byLabel = (label) => jobs.find((j) => j.label === label) || {};
  const mig = byLabel('migrate');
  const upd = byLabel('package-update');
  const rb = byLabel('rollback');
  const checks = all((l) => l.step === 'check');
  const main = checks.filter((c) => !String(c.check).startsWith('neg-'));
  const bad = main.filter((c) => c.ok !== '1').map((c) => `${c.check}: ${c.bad}`);
  const changed = [...new Set(main.map((c) => c.config_changed_keys).filter((k) => k && k !== '-'))];
  const sizes = all((l) => l.step === 'sizes');
  const sz = (n) => sizes.find((x) => x.sizes === n) || {};
  const reseed = find((l) => l.step === 'reseed-state');
  const lost = reseed.lost_by_old_git_update;
  const migratedKeys = reseed.config_migrated_by_version_update;
  const total = find((l) => l.total_s).total_s;
  const migratedOk = mig.state === 'ok' && main.find((c) => c.check === 'after-migration')?.ok === '1';
  const notes = [];
  if (lost) notes.push(`alte git-Oberfläche hat ${lost} weggeräumt (Altfehler, vor der Umstellung)`);
  if (migratedKeys && migratedKeys !== '-') notes.push(`Config beim Versions-Update (git) migriert: ${migratedKeys}`);
  const changedAfter = [...new Set(main.filter((c) => c.check !== 'installed' && c.check !== 'after-git-update').map((c) => c.config_changed_keys).filter((k) => k && k !== '-'))];
  if (changedAfter.length) notes.push(`Config nach der Umstellung geändert: ${changedAfter.join(', ')}`);
  void changed;
  if (bad.length) notes.push(`Prüfungen: ${bad.join('; ')}`);
  if (mig.state && mig.state !== 'ok') notes.push(`Umstellung: ${mig.msg}`);
  rows.push({
    fall: d,
    install: install.install === '0' ? `ok (${install.time_s} s)` : `rc=${install.install ?? '?'}`,
    git: viaInstaller ? 'per Installer (Emulation)' : (git.gui_git_update === 'true' ? `ok (${git.time_s} s)` : (git.gui_git_update ?? '—')),
    migration: mig.state ? `${mig.state} (${mig.time_s} s)` : '—',
    update: upd.state ? `${upd.state} (${upd.time_s} s)` : '—',
    rollback: rb.state ? `${rb.state} (${rb.time_s} s)` : '—',
    daten: bad.length ? 'NEIN' : (main.length ? 'ja' : '—'),
    db: main.length ? (main.every((c) => c.db === 'ok') ? `ok (${main.length}×)` : main.map((c) => `${c.check}:${c.db}`).join(' ')) : '—',
    groesse: `${sz('git-1.0.9').program_mb ?? '?'} MB / ${sz('git-1.0.9').files ?? '?'} Dateien → Release ${sz('package').current_release_mb ?? '?'} MB / ${sz('package').current_release_files ?? '?'}`,
    gesamt: migratedOk && upd.state === 'ok' && rb.state === 'ok' && !bad.length && main.every((c) => c.db === 'ok') ? 'OK' : 'FEHLER',
    zeit: total ? `${total} s` : '?',
    notes: notes.join(' · ') || '—',
  });
  const NEG_NAMES = {
    'neg-tampered': 'verändertes Paket', 'neg-badsig': 'fremde Signatur', 'neg-interrupt-once': 'Download bricht einmal ab',
    'neg-interrupt-always': 'Download bricht immer ab', 'neg-precheck': 'Vorabprüfung Platz (8-MB-Staging)',
    'neg-enospc': 'Platte läuft während des Downloads voll (ENOSPC)', 'neg-health': 'neue Version startet nicht',
  };
  // Erwartetes Ergebnis je Negativfall (Zustand und Meldung), nicht nur „irgendwie gescheitert“.
  const NEG_EXPECT = {
    'neg-tampered': ['failed', /Prüfsumme/], 'neg-badsig': ['failed', /Signatur ungültig/], 'neg-interrupt-once': ['ok', /installiert und gesund/],
    'neg-interrupt-always': ['failed', /Download/], 'neg-precheck': ['failed', /zu wenig Speicher/],
    'neg-enospc': ['failed', /Speicher voll beim Download/], 'neg-health': ['rolled_back', /nicht gesund/],
  };
  const fill = find((l) => l.step === 'fill-report');
  for (const j of jobs.filter((x) => String(x.label).startsWith('neg-'))) {
    const [st, re] = NEG_EXPECT[j.label] || [];
    const check = checks.find((c) => c.check === j.label);
    let expected = st ? (j.state === st && re.test(String(j.msg))) : null;
    if (j.label === 'neg-enospc' && fill.filled !== '1') expected = false;
    // Box danach aktiv und auf dem erwarteten Stand (Gegenprüfung 61228be9).
    const wantCurrent = ['neg-tampered', 'neg-badsig'].includes(j.label) ? 'releases/1.0.9' : 'releases/1.0.10';
    if (!check || check.ok !== '1' || check.db !== 'ok' || check.active !== 'active' || check.current !== wantCurrent) expected = false;
    negs.push({ fall: d, name: NEG_NAMES[j.label] || j.label, state: j.state, msg: j.msg, check, expected,
      extra: j.label === 'neg-enospc' ? `Füller ${fill.filled === '1' ? `${fill.filler_mb} MB` : 'NICHT aktiv'}` : '' });
  }
}

const head = ['Fall', 'Gesamt', 'install.sh', 'git-Update (alte Oberfläche)', 'Umstellung', 'Paket-Update', 'Rückweg', 'Daten/Config/Kanal', 'Datenbank-Marker', 'git-Checkout 1.0.9 → Release 1.0.9 (MB / Dateien)', 'Laufzeit', 'Notizen'];
console.log(`# Release-Paket-Matrix ${path.basename(run)}\n`);
console.log(`| ${head.join(' | ')} |`);
console.log(`|${head.map(() => '---').join('|')}|`);
for (const r of rows) console.log(`| ${[r.fall, r.gesamt, r.install, r.git, r.migration, r.update, r.rollback, r.daten, r.db, r.groesse, r.zeit, r.notes].join(' | ')} |`);
if (negs.length) {
  console.log('\n## Negativfälle\n');
  console.log('| Box | Fall | wie erwartet | Ergebnis | Meldung | Box danach |');
  console.log('|---|---|---|---|---|---|');
  for (const n of negs) console.log(`| ${n.fall} | ${n.name} | ${n.expected ? 'ja' : 'NEIN'} | ${n.state} | ${n.msg}${n.extra ? ` (${n.extra})` : ''} | ${n.check ? `${n.check.current}, Marker ${n.check.ok === '1' ? 'ok' : n.check.bad}, DB ${n.check.db}` : '—'} |`);
}
