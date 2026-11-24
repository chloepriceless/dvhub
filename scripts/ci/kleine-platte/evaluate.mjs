// scripts/ci/kleine-platte/evaluate.mjs — Bewertung des E2E-Tests „kleine Platte“.
//
//   node evaluate.mjs <szenario-ordner>          → <ordner>/result.json, eine Zeile Text
//   node evaluate.mjs --summary <out> [sek]      → <out>/summary.json + summary.txt
//
// Jede Prüfung hat eine Art:
//   basis   — muss schon heute halten (kein Absturz, Preise/15-min/Altdaten bleiben)
//   fehler  — bekannter Fehler, den der Fix schließen muss (Wache bricht ab, keine Warnung,
//             falsche Platte gemessen …)
//   neu     — neue Funktion aus dem Konzept (Profil, Reichweite, Kompressions-Angabe, Push …)
// und ein Ergebnis: ok | rot | fehlt (Schnittstelle gibt es im Stand noch nicht) | info.
// Ein Szenario ist GRÜN nur, wenn keine Prüfung rot oder fehlt ist.
//
// Die neuen Schnittstellen sind beim Schreiben noch im Bau (fix/speicher-wache-sofort,
// feat/speicher-stufen-1min). Darum wird tolerant gelesen: mehrere Feldnamen, nichts
// davon ist Pflicht für einen Lauf ohne Absturz.
import fs from 'node:fs';
import path from 'node:path';

const readJson = (f, dflt = null) => {
  try { const t = fs.readFileSync(f, 'utf8').trim(); return t ? JSON.parse(t) : dflt; } catch { return dflt; }
};
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const num = (v) => (v == null || v === '' ? null : Number(v));
// a ≥ b nur, wenn beide Werte da sind (fehlender Schnappschuss ist nie „ok“).
const ge = (a, b) => num(a) != null && num(b) != null && num(a) >= num(b);

// ── tolerantes Lesen der Status-API ───────────────────────────────────────
function pick(obj, paths) {
  for (const p of paths) {
    let v = obj;
    for (const k of p.split('.')) { v = v == null ? undefined : v[k]; }
    if (v !== undefined && v !== null) return { value: v, path: p };
  }
  return null;
}
// Profil nach Plattengröße (sizeProfile) zuerst — „effective“ darf bei wenig/kritisch
// befristet härter sein (Konzept § 6.3), das steht nur im Beleg.
function profileOf(st) {
  const p = pick(st, ['profile.sizeProfile', 'profile.base', 'profile.effective', 'profile.name', 'profile.id', 'profile.key', 'profile', 'storageProfile', 'profil']);
  if (!p) return null;
  const eff = st?.profile && typeof st.profile === 'object' ? st.profile.effective : null;
  return { value: typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value), path: p.path, effective: eff ?? null };
}
function daysLeftOf(st) {
  const p = pick(st, ['daysLeft', 'reach.days', 'reachDays', 'rangeDays', 'reichweiteTage', 'growth.daysLeft', 'forecast.daysLeft']);
  if (p) return p;
  const ms = mountsOf(st).map((m) => num(m.daysLeft ?? m.reachDays)).filter((x) => x != null && Number.isFinite(x));
  return ms.length ? { value: Math.min(...ms), path: 'mounts[].daysLeft' } : null;
}
function compressionOf(st) {
  const c = pick(st, ['compression', 'db.compression', 'timescale.compression']);
  if (!c) return null;
  const v = c.value;
  if (typeof v === 'boolean') return { active: v, raw: v, path: c.path };
  const active = v.active ?? v.enabled ?? v.on ?? v.ok ?? (typeof v.status === 'string' ? /^(on|active|ok|aktiv)$/i.test(v.status) : undefined);
  return { active: typeof active === 'boolean' ? active : null, raw: v, path: c.path };
}
function mountsOf(st) {
  if (!st || typeof st !== 'object') return [];
  for (const k of ['mounts', 'disks', 'volumes', 'filesystems', 'datentraeger']) {
    if (Array.isArray(st[k])) return st[k];
  }
  // alter Aufbau (main): eine Messstelle auf oberster Ebene
  if (st.totalMb != null) return [{ dir: st.dir, totalMb: st.totalMb, freeMb: st.freeMb, freePct: st.freePct, level: st.level, roles: ['(einzige Messstelle)'] }];
  return [];
}
const LEVELS = ['ok', 'knapp', 'wenig', 'kritisch'];
const levelRank = (l) => LEVELS.indexOf(String(l || '').toLowerCase());

function evaluateScenario(dir) {
  const meta = readJson(path.join(dir, 'meta.json'), {});
  const st = readJson(path.join(dir, 'storage-status.json'), null);
  const polls = readLines(path.join(dir, 'status-polls.jsonl')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const api = readJson(path.join(dir, 'api-status.json'), {});
  const before = readJson(path.join(dir, 'snap-before.json'), {});
  const after = readJson(path.join(dir, 'snap-after.json'), {});
  const compressed = readJson(path.join(dir, 'snap-compressed.json'), null);
  const audit = readJson(path.join(dir, 'audit.json'), []) || [];
  const push = readLines(path.join(dir, 'push.jsonl')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const cDv = readJson(path.join(dir, 'container-dvhub.json'), {});
  const cDb = readJson(path.join(dir, 'container-db.json'), {});
  const wait = readJson(path.join(dir, 'guard-wait.json'), {});
  const fsMain = readJson(path.join(dir, 'fs-main-filled.json'), {});
  const fsData = readJson(path.join(dir, 'fs-data-filled.json'), null);
  const shim = readLines(path.join(dir, 'shim.txt'));
  // Hinweise: alle, die nach dem Füllen bei einem Lauf der Wache oder am Ende zu sehen waren.
  const tickPolls = readLines(path.join(dir, 'warnings-polls.jsonl')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const warnMap = new Map();
  for (const w of [...tickPolls.flatMap((t) => t.api?.systemWarnings || []), ...(Array.isArray(api?.systemWarnings) ? api.systemWarnings : [])]) {
    warnMap.set(`${w.id}|${w.message}`, w);
  }
  const warnings = [...warnMap.values()];
  const fillAt = Number(wait.fillAtMs || 0);
  const auditAfterFill = audit.filter((a) => Date.parse(a.ts) > fillAt);
  const checks = [];
  const add = (id, kind, status, detail) => checks.push({ id, kind, status, detail });

  // ── basis: läuft alles? ──
  add('dvhub-laeuft', 'basis', cDv.running === true && !cDv.oomKilled && Number(cDv.restarts || 0) === 0 ? 'ok' : 'rot',
    `DVhub-Container running=${cDv.running} restarts=${cDv.restarts} oom=${cDv.oomKilled}`);
  add('db-laeuft', 'basis', cDb.running === true && !cDb.oomKilled && Number(cDb.restarts || 0) === 0 ? 'ok' : 'rot',
    `DB-Container running=${cDb.running} restarts=${cDb.restarts} oom=${cDb.oomKilled}`);
  add('status-api', 'basis', st && typeof st === 'object' ? 'ok' : 'rot',
    st ? `/api/storage/status antwortet (level=${st.level})` : '/api/storage/status antwortet nicht');
  add('wache-beschleunigt', 'info', 'info',
    shim.length ? `Zeitgeber verkürzt: ${shim.length} Stelle(n)` : 'timer-shim hat KEINEN Zeitgeber der Wache gefunden — ohne eigenen Test-Hook läuft die Wache erst nach 5 min');

  // ── fehler: Wache läuft nach dem Füllen, ohne Abbruch ──
  const guardErrors = auditAfterFill.filter((a) => /storage_guard_error|speicher.*fehler/i.test(a.event));
  const ranAfterFill = Number(wait.ticksAfterFill || 0) > 0;
  add('wache-laeuft-nach-fuellen', 'fehler', ranAfterFill ? 'ok' : 'rot',
    ranAfterFill ? `${wait.ticksAfterFill} Lauf/Läufe mit neuem Stand` : `kein Lauf mit Zeitstempel nach dem Füllen (Status zeigt at=${st?.at ?? '–'}, level=${st?.level ?? '–'})`);
  add('wache-ohne-abbruch', 'fehler', guardErrors.length ? 'rot' : 'ok',
    guardErrors.length ? `storage_guard_error: ${guardErrors.map((a) => a.payload?.error).filter(Boolean).slice(0, 2).join(' | ')}` : 'kein storage_guard_error nach dem Füllen');

  // Stufe: beim ERSTEN Lauf nach dem Füllen (danach darf Komprimieren/Löschen Platz schaffen)
  const firstTick = polls.find((p) => Date.parse(p.at || '') > fillAt) || null;
  const lvl = String(firstTick?.level ?? '');
  const lvlOk = new RegExp(`^(${meta.expectLevel})$`).test(lvl);
  add('stufe', 'fehler', lvlOk ? 'ok' : 'rot', `erster Lauf nach Füllen: level=${lvl || '– (kein Lauf)'} bei ${firstTick?.freeMb ?? '–'} MB frei, am Ende level=${st?.level ?? '–'} (erwartet ${meta.expectLevel}); PG-Platte nach Füllen ${fsMain.freeMb} MB frei = ${fsMain.freePct} %`
    + (fsData ? `; DVhub-Daten-Platte ${fsData.freeMb} MB = ${fsData.freePct} %` : ''));

  // Hinweis „Speicher …“ in der Leiste
  const storageWarn = warnings.filter((w) => /storage|speicher/i.test(`${w.id} ${w.message}`));
  if (meta.expectLevel !== 'ok') {
    add('systemhinweis-speicher', 'fehler', storageWarn.length ? 'ok' : 'rot',
      storageWarn.length ? storageWarn.map((w) => `[${w.id}] ${w.message}`).join(' · ').slice(0, 400) : `kein Speicher-Hinweis in systemWarnings (${warnings.length} Hinweise gesamt)`);
  }

  // Kompression
  const noComp = meta.tsMode === 'apache' || meta.tsMode === 'plain';
  const compWarn = warnings.filter((w) => /kompr/i.test(w.message) && /(nicht|ohne|keine|fehlt)/i.test(w.message));
  if (noComp) {
    add('warnung-ohne-kompression', 'fehler', compWarn.length ? 'ok' : 'rot',
      compWarn.length ? compWarn.map((w) => `[${w.id}] ${w.message}`).join(' · ').slice(0, 400) : 'kein Hinweis „ohne Kompression“ in systemWarnings');
  } else {
    add('keine-falsche-kompressionswarnung', 'fehler', compWarn.length ? 'rot' : 'ok',
      compWarn.length ? `unerwartet: ${compWarn.map((w) => w.message).join(' · ')}` : 'kein Hinweis „ohne Kompression“ (richtig, Community)');
    add('kompression-eingeschaltet', 'basis', before.compression_enabled === true && (before.jobs || []).some((j) => j.proc === 'policy_compression') ? 'ok' : 'rot',
      `compression_enabled=${before.compression_enabled}, Regel ${JSON.stringify((before.jobs || []).filter((j) => j.proc === 'policy_compression').map((j) => j.config?.compress_after))}, Blöcke ${before.chunk_interval_h} h`);
  }
  if (meta.id === 1 && compressed) {
    const b = num(compressed.compressed_before_bytes); const a = num(compressed.compressed_after_bytes);
    add('kompression-wirkt', 'basis', compressed.chunks_compressed > 0 && a > 0 ? 'ok' : 'rot',
      `${compressed.chunks_compressed}/${compressed.chunks} Blöcke komprimiert` + (a ? `, ${Math.round(b / 1048576)} MB → ${Math.round(a / 1048576)} MB (${(b / a).toFixed(1)}:1)` : ''));
  }
  const comp = compressionOf(st);
  add('status-kompression', 'neu', comp == null ? 'fehlt' : (comp.active === !noComp ? 'ok' : 'rot'),
    comp == null ? 'Status nennt keine Kompression (Feld fehlt)' : `${comp.path}=${JSON.stringify(comp.raw).slice(0, 200)}`);

  // Profil
  const prof = profileOf(st);
  add('profil', 'neu', prof == null ? 'fehlt' : (new RegExp(`\\b${meta.expectProfile}\\b`, 'i').test(prof.value) ? 'ok' : 'rot'),
    prof == null ? 'Status nennt kein Profil' : `${prof.path}=${prof.value} (erwartet ${meta.expectProfile})${prof.effective ? `, wirksam ${prof.effective}` : ''}`);

  // Reichweite
  const dl = daysLeftOf(st);
  const dlKey = st && typeof st === 'object' && ['daysLeft', 'reachDays', 'rangeDays'].find((k) => Object.hasOwn(st, k));
  if (dl == null && dlKey) {
    // Feld da, aber leer: ohne Wachstumswerte (Messpunkt je Tag) keine Reichweite — im
    // Minuten-Test erwartbar. Kein Fehler, aber sichtbar.
    add('reichweite', 'info', 'info', `${dlKey}=null (kein Wachstum bekannt; growthMbPerDay=${st.growthMbPerDay ?? 'null'}, reserveMb=${st.reserveMb ?? '–'}) — im Minuten-Test nicht prüfbar`);
  } else if (dl == null) add('reichweite', 'neu', 'fehlt', 'Status nennt keine Reichweite in Tagen');
  else {
    const d = num(dl.value);
    let okd;
    if (meta.expectLevel === 'ok') okd = d != null && d >= 60;              // 6 GB frei, komprimiert: Jahre
    else okd = d != null && d >= 0 && d < 180;                               // knapp und weniger
    add('reichweite', 'neu', okd ? 'ok' : 'rot', `${dl.path}=${dl.value} Tage (plausibel: ${meta.expectLevel === 'ok' ? '≥ 60' : '0…180'})`);
  }

  // ── Daten: Rohwerte entfernt, Rest bleibt ──
  if (meta.expectLevel !== 'ok') {
    const dropped = num(after.live_raw_rows) != null && num(before.live_raw_rows) != null && num(after.live_raw_rows) < num(before.live_raw_rows);
    const oldest = num(after.live_raw_oldest_days);
    // Ziel der Wache (V2 a, 24.11.): nur so weit löschen, bis die Platte wieder über der Schwelle „wenig“
    // liegt — nicht zwingend bis 30 Tage. OK also bei ≤ ~31 Tagen ODER wenn am Ende genug frei ist
    // (Stufe nicht mehr „kritisch“, mindestens 300 MB frei) und überhaupt älteres gelöscht wurde.
    const fsEnd = readJson(path.join(dir, 'fs-main-after.json'), {});
    const endLevel = String(st?.level || '');
    const roomOk = num(fsEnd.freeMb) != null && num(fsEnd.freeMb) >= 300 && endLevel !== 'kritisch' && endLevel !== ''
      && oldest != null && num(before.live_raw_oldest_days) != null && oldest < num(before.live_raw_oldest_days) - 0.5;
    const keepOk = (oldest != null && oldest <= 31.5) || roomOk;
    // Nicht zu viel: die letzten 25 Tage bleiben vollständig (0,5 % Spiel für das wandernde Fenster).
    const recentKept = num(after.live_recent_rows) != null && num(before.live_recent_rows) != null
      && num(after.live_recent_rows) >= num(before.live_recent_rows) * 0.995;
    add('rohwerte-entfernt', 'fehler', dropped && keepOk ? 'ok' : 'rot',
      `5-s-Live-Zeilen ${before.live_raw_rows} → ${after.live_raw_rows}, ältester ${before.live_raw_oldest_days} → ${after.live_raw_oldest_days} Tage (erwartet ≤ ~31 oder Platte wieder über „wenig“: Ende ${endLevel || '–'}, ${fsEnd.freeMb ?? '–'} MB frei)`);
    add('juengste-rohwerte-bleiben', 'basis', recentKept ? 'ok' : 'rot',
      `Live-Zeilen der letzten 25 Tage ${before.live_recent_rows} → ${after.live_recent_rows} (dürfen nicht weniger werden)`);
    const fsAfter = readJson(path.join(dir, 'fs-main-after.json'), {});
    add('platz-danach', 'info', 'info', `PG-Platte frei: nach Füllen ${fsMain.freeMb} MB, am Ende ${fsAfter.freeMb} MB`
      + (meta.tsMode === 'plain' ? ' (reines PostgreSQL: DELETE gibt Platz nicht ans Dateisystem zurück)' : ''));
    const freed = auditAfterFill.filter((a) => /storage_raw_dropped/.test(a.event)).map((a) => a.payload);
    add('protokoll-entfernt', 'info', 'info', freed.length ? `storage_raw_dropped ${JSON.stringify(freed).slice(0, 200)}` : 'kein storage_raw_dropped im audit_log');
  } else {
    add('nichts-entfernt', 'basis', ge(after.live_raw_rows, before.live_raw_rows) ? 'ok' : 'rot',
      `5-s-Live-Zeilen ${before.live_raw_rows} → ${after.live_raw_rows} (bei genug Platz darf nichts weg)`);
  }
  add('preise-bleiben', 'basis', ge(after.price_rows_past, before.price_rows_past) ? 'ok' : 'rot',
    `Preiszeilen (älter 1 Tag) ${before.price_rows_past} → ${after.price_rows_past}`);
  add('15min-bleiben', 'basis', ge(after.slots15_rows, before.slots15_rows) ? 'ok' : 'rot',
    `energy_slots_15m ${before.slots15_rows} → ${after.slots15_rows} (Reihen ${before.slots15_series} → ${after.slots15_series})`);
  add('altdaten-bleiben', 'basis', ge(after.history_rows_past, before.history_rows_past) ? 'ok' : 'rot',
    `importierte Altdaten (scope≠live) ${before.history_rows_past} → ${after.history_rows_past}`);
  // Datenstufen (1 min / 15 min je Reihe), falls der Stand sie hat
  const tb = before.tier_tables || {}; const ta = after.tier_tables || {};
  const tierNames = Object.keys({ ...tb, ...ta });
  const rowsOf = (x) => Number(x?.rows ?? x ?? 0);
  if (!tierNames.length) add('stufen-bleiben', 'neu', 'fehlt', 'keine 1-min/15-min-Stufentabelle im Schema');
  else {
    const lost = tierNames.filter((t) => rowsOf(ta[t]) < rowsOf(tb[t]));
    add('stufen-bleiben', 'neu', lost.length ? 'rot' : 'ok',
      tierNames.map((t) => `${t} ${rowsOf(tb[t])} → ${rowsOf(ta[t])} Zeilen (${ta[t]?.series ?? '–'} Reihen)`).join(', '));
  }
  if (meta.expectLevel !== 'ok') {
    // 15-min für JEDE aufgenommene Reihe (S3 a+c): nach dem Entfernen müssen alle Live-Reihen verdichtet vorliegen.
    // Gezählt werden nur Reihen, deren 15-min-Werte den entfernbaren Bereich (32–44 Tage alt)
    // zu ≥ 90 % abdecken — eine einzelne neue Zeile je Reihe reicht nicht (Codex 30c76e1c).
    const live = num(before.live_series);
    const t15 = tierNames.filter((t) => /15m/.test(t));
    const full = t15.map((t) => ({ t, n: Number(ta[t]?.old_full_series ?? 0) }));
    const best = full.reduce((m, x) => (x.n > m.n ? x : m), { t: null, n: 0 });
    add('15min-alle-reihen', 'neu', live != null && best.n >= live ? 'ok' : (t15.length ? 'rot' : 'fehlt'),
      t15.length ? `Reihen mit voller 15-min-Abdeckung 32–44 Tage zurück: ${full.map((x) => `${x.t}=${x.n}`).join(', ')} vs. Live-Reihen ${live}`
        : `keine 15-min-Stufentabelle je Reihe (energy_slots_15m hat ${after.slots15_series} Reihen, davon 8 vom Test)`);
  }

  // Push
  if (meta.expectLevel !== 'ok') {
    const p = push.filter((m) => /speicher|platte|frei|storage|komprim/i.test(`${m.title} ${m.body}`));
    add('push', 'neu', p.length ? 'ok' : 'fehlt',
      p.length ? p.map((m) => `${m.title}: ${m.body}`).join(' · ').slice(0, 300) : `keine Push-Meldung zum Speicher (${push.length} Meldungen gesamt am Mitschnitt)`);
  }

  // Szenario 5: richtige Platte gemessen, beide gewarnt
  if (meta.separateData) {
    const mounts = mountsOf(st);
    // Stufen je Platte wie bei „stufe“ beim ERSTEN Lauf nach dem Füllen — danach darf die Wache (und seit 24.11.
    // die Kompression der Datenstufen) Platz schaffen, am Ende ist die PG-Platte dann womöglich schon wieder „ok“.
    const tickMounts = mountsOf(firstTick).length ? mountsOf(firstTick) : mounts;
    const pgTotal = readJson(path.join(dir, 'fs-main-filled.json'), {}).totalMb;
    const dataTotal = fsData?.totalMb;
    const near = (a, b) => a != null && b != null && Math.abs(a - b) / b < 0.05;
    const pgMount = mounts.find((m) => near(num(m.totalMb), pgTotal));
    const dataMount = mounts.find((m) => near(num(m.totalMb), dataTotal));
    add('misst-pg-platte', 'fehler', pgMount ? 'ok' : 'rot',
      `Messstellen: ${mounts.map((m) => `${m.dir || m.path || (m.roles || []).join('+') || m.role || '?'}=${m.totalMb} MB (${m.level ?? '–'})`).join(', ') || '–'}; PG-Platte ${pgTotal} MB, DVhub-Daten ${dataTotal} MB`);
    // Stufe je Platte: eigenes Feld, sonst aus freePct mit den alten Prozent-Schwellen (nur zur Einordnung).
    const lv = (m) => m?.level ?? (m?.freePct == null ? null : (m.freePct < 5 ? 'kritisch' : m.freePct < 10 ? 'wenig' : m.freePct < 20 ? 'knapp' : 'ok'));
    const pgTick = tickMounts.find((m) => near(num(m.totalMb), pgTotal)) || pgMount;
    const dataTick = tickMounts.find((m) => near(num(m.totalMb), dataTotal)) || dataMount;
    const both = pgMount && dataMount && pgMount !== dataMount;
    const warnBoth = storageWarn.length >= 2 || storageWarn.some((w) => /daten(bank)?/i.test(w.message) && /(dvhub-daten|datenverzeichnis|beide|\/var\/lib\/dvhub)/i.test(w.message));
    add('warnt-fuer-beide', 'neu', both && levelRank(lv(pgTick)) > 0 && levelRank(lv(dataTick)) > 0 && warnBoth ? 'ok' : (mounts.length > 1 ? 'rot' : 'fehlt'),
      both ? `erster Lauf nach Füllen: PG ${lv(pgTick)}, DVhub-Daten ${lv(dataTick)} (am Ende PG ${lv(pgMount)}, DVhub-Daten ${lv(dataMount)}); Speicher-Hinweise: ${storageWarn.length}` : 'nicht beide Platten getrennt im Status');
  }

  const bad = checks.filter((c) => c.status === 'rot' || c.status === 'fehlt');
  const result = {
    scenario: meta.id, name: meta.name, sha: meta.sha, runId: meta.runId,
    verdict: bad.length ? 'ROT' : 'GRÜN',
    counts: Object.fromEntries(['ok', 'rot', 'fehlt', 'info'].map((s) => [s, checks.filter((c) => c.status === s).length])),
    failing: bad.map((c) => `${c.kind}:${c.id}=${c.status}`),
    checks,
    evidence: {
      storageStatus: st, systemWarnings: warnings, polls: polls.length,
      auditAfterFill: auditAfterFill.slice(-20), push: push.slice(-5),
      snapBefore: before, snapAfter: after, snapCompressed: compressed, fsMainFilled: fsMain, fsDataFilled: fsData, shim,
    },
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  const lines = [`   Szenario ${meta.id}: ${result.verdict} — ${meta.name}`];
  for (const c of checks) lines.push(`     ${c.status.padEnd(5)} ${c.kind.padEnd(6)} ${c.id.padEnd(34)} ${c.detail}`);
  console.log(lines.join('\n'));
  return result;
}

function summary(out, secs, runId, scenarios) {
  // Nur Ergebnisse DIESES Laufs und der angefragten Szenarien (Codex 30c76e1c: --out wiederverwendet).
  const want = scenarios ? new Set(String(scenarios).split(',').map((x) => Number(x.trim()))) : null;
  const dirs = fs.readdirSync(out).filter((d) => /^s\d+$/.test(d)).sort();
  const results = dirs.map((d) => readJson(path.join(out, d, 'result.json'))).filter(Boolean)
    .filter((r) => (!runId || r.runId === runId) && (!want || want.has(Number(r.scenario))));
  const allIds = [...new Set(results.flatMap((r) => r.checks.map((c) => c.id)))];
  const s = {
    at: new Date().toISOString(), out, seconds: Number(secs) || null,
    sha: results[0]?.sha ?? null, runId: results[0]?.runId ?? null,
    allGreen: results.length > 0 && results.every((r) => r.verdict === 'GRÜN'),
    scenarios: results.map((r) => ({ scenario: r.scenario, name: r.name, verdict: r.verdict, counts: r.counts, failing: r.failing })),
  };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(s, null, 2));
  const head = ['Prüfung'.padEnd(34), ...results.map((r) => `S${r.scenario}`.padEnd(6))].join(' ');
  const rows = allIds.map((id) => [id.padEnd(34), ...results.map((r) => (r.checks.find((c) => c.id === id)?.status ?? '·').padEnd(6))].join(' '));
  const txt = [
    `Kleine Platte E2E — Stand ${s.sha} — Lauf ${s.runId} — ${s.seconds ?? '?'} s`,
    '',
    ...results.map((r) => `S${r.scenario} ${r.verdict.padEnd(5)} ${r.name}  [ok ${r.counts.ok} · rot ${r.counts.rot} · fehlt ${r.counts.fehlt}]`),
    '',
    head, '-'.repeat(head.length), ...rows,
    '',
    'ok = erfüllt · rot = falsches Verhalten · fehlt = Schnittstelle/Funktion im Stand nicht vorhanden · info = nur Beleg',
  ].join('\n');
  fs.writeFileSync(path.join(out, 'summary.txt'), txt + '\n');
  console.log(txt);
}

if (process.argv[2] === '--summary') summary(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
else evaluateScenario(process.argv[2]);
