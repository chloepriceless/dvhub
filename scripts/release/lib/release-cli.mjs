#!/usr/bin/env node
// release-cli.mjs — Kommandozeile zu release-lib.mjs für build-release.sh und
// publish-release.sh. Jede Teilaufgabe ist ein Unterbefehl; Fehler beenden mit
// Exit 1 und einer Meldung auf stderr.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAllowlist, assembleTree, referencedScripts, checkDependencies,
  computeReleaseVersion, packTree, assetBaseName, mergeIndex, validateIndex,
  MANIFEST_NAME, ARCHES, changelogSection,
} from './release-lib.mjs';

function opts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unerwartetes Argument: ${a}`);
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) { o[key] = true; continue; }
    o[key] = val;
    i++;
  }
  return o;
}

function need(o, ...keys) {
  for (const k of keys) if (o[k] === undefined || o[k] === true) throw new Error(`--${k} fehlt`);
}

const commands = {
  // Erlaubte Dateien kopieren; Skripte, die post-update.sh/install.sh aufrufen,
  // müssen dabei sein.
  assemble(o) {
    need(o, 'src', 'dest', 'allowlist');
    const rules = parseAllowlist(fs.readFileSync(o.allowlist, 'utf8'));
    fs.mkdirSync(o.dest, { recursive: true });
    const taken = assembleTree(o.src, o.dest, rules);
    const missing = [];
    for (const f of ['post-update.sh', 'install.sh']) {
      const p = path.join(o.src, f);
      if (!fs.existsSync(p)) continue;
      for (const ref of referencedScripts(fs.readFileSync(p, 'utf8'))) {
        if (fs.existsSync(path.join(o.src, ref)) && !fs.existsSync(path.join(o.dest, ref))) missing.push(`${ref} (aus ${f})`);
      }
    }
    if (missing.length) throw new Error(`Allowlist lässt aufgerufene Skripte weg: ${missing.join(', ')}`);
    process.stdout.write(`${taken.length}\n`);
  },

  'check-deps'(o) {
    need(o, 'app');
    const problems = checkDependencies(o.app);
    if (problems.length) throw new Error(`node_modules nicht architekturneutral:\n  ${problems.join('\n  ')}`);
  },

  version(o) {
    need(o, 'pkg-version', 'commit-time', 'sha');
    const tag = typeof o.tag === 'string' ? o.tag : '';
    process.stdout.write(`${JSON.stringify(computeReleaseVersion({
      tag, pkgVersion: o['pkg-version'], commitTime: Number(o['commit-time']), sha: o.sha,
    }))}\n`);
  },

  // Baum → dvhub-<v>-<arch>.tar.gz + .manifest.json; Ausgabe: JSON mit sha256/size.
  pack(o) {
    need(o, 'root', 'out-dir', 'meta');
    const meta = JSON.parse(fs.readFileSync(o.meta, 'utf8'));
    if (!ARCHES.includes(meta.arch)) throw new Error(`Architektur ${meta.arch} unbekannt`);
    const { gz, manifestBuf, manifest } = packTree(o.root, { mtime: meta.commit_time, meta });
    const base = assetBaseName(meta.version, meta.arch);
    fs.mkdirSync(o['out-dir'], { recursive: true });
    fs.writeFileSync(path.join(o['out-dir'], `${base}.tar.gz`), gz);
    fs.writeFileSync(path.join(o['out-dir'], `${base}.manifest.json`), manifestBuf);
    process.stdout.write(`${JSON.stringify({
      file: `${base}.tar.gz`,
      sha256: crypto.createHash('sha256').update(gz).digest('hex'),
      size: gz.length,
      files: manifest.files.length,
    })}\n`);
  },

  // Release in den Kanal-Index einfügen.
  index(o) {
    need(o, 'channel', 'release', 'out');
    const prev = typeof o.prev === 'string' && fs.existsSync(o.prev) ? JSON.parse(fs.readFileSync(o.prev, 'utf8')) : null;
    const release = JSON.parse(fs.readFileSync(o.release, 'utf8'));
    const idx = validateIndex(mergeIndex(prev, { channel: o.channel, release, keep: o.keep ? Number(o.keep) : undefined }), o.channel);
    fs.writeFileSync(o.out, `${JSON.stringify(idx, null, 2)}\n`);
  },

  // Feld aus einer JSON-Datei lesen (für die Shell-Skripte).
  get(o) {
    need(o, 'file', 'path');
    let v = JSON.parse(fs.readFileSync(o.file, 'utf8'));
    for (const k of String(o.path).split('.')) v = v?.[k];
    if (v === undefined) throw new Error(`${o.path} fehlt in ${o.file}`);
    process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
  },

  // Änderungsliste für den Index: stable → Abschnitt aus CHANGELOG.md
  // (oberste Aufzählungspunkte, ohne Markdown), dev → Commit-Betreffs.
  changes(o) {
    need(o, 'out');
    let list = [];
    if (typeof o.changelog === 'string' && typeof o.version === 'string') {
      list = changelogSection(fs.readFileSync(o.changelog, 'utf8'), o.version);
    } else if (typeof o.subjects === 'string') {
      list = fs.readFileSync(o.subjects, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    }
    fs.writeFileSync(o.out, `${JSON.stringify(list.slice(0, 30))}\n`);
  },

  // Release-Objekt (release.json) um Kanal-Pfade und Änderungen ergänzen.
  'index-entry'(o) {
    need(o, 'release', 'release-tag', 'changes', 'out');
    const r = JSON.parse(fs.readFileSync(o.release, 'utf8'));
    const changes = JSON.parse(fs.readFileSync(o.changes, 'utf8'));
    const artifacts = {};
    for (const [arch, a] of Object.entries(r.artifacts)) {
      artifacts[arch] = { url: `../${o['release-tag']}/${a.file}`, sha256: a.sha256, size: a.size, sig: `../${o['release-tag']}/${a.sig}`, manifest: `../${o['release-tag']}/${a.manifest}` };
    }
    const entry = { version: r.version, tag: r.tag, git_sha: r.git_sha, date: r.date, node_engine: r.node_engine, changes, artifacts };
    fs.writeFileSync(o.out, `${JSON.stringify(entry, null, 2)}\n`);
  },

  'manifest-name'() { process.stdout.write(`${MANIFEST_NAME}\n`); },
};

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!commands[cmd]) throw new Error(`Befehl: ${Object.keys(commands).join('|')}`);
  commands[cmd](opts(rest));
} catch (e) {
  process.stderr.write(`release-cli ${cmd || ''}: ${e.message}\n`);
  process.exit(1);
}
