// release-lib.mjs — Bausteine für die signierten Release-Pakete
// (docs/release-pakete.md). Nur node:-Module, damit Bau und Tests ohne
// zusätzliche Abhängigkeiten laufen.
//
//  - Allowlist: welche Dateien aus dem git-Export ins Paket dürfen
//  - Versionen: Paketversion aus Tag/Ref, Vergleich (Semver mit Vorabteil)
//  - tar: deterministischer Schreiber (sortiert, feste Zeiten/Besitzer/Modi)
//    und ein Leser für Tests und Prüfungen
//  - Manifest, Kanal-Index, Abhängigkeits-Prüfung (keine Install-Skripte,
//    keine nativen Module)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const MANIFEST_NAME = '.dvhub-release.json';
export const MANIFEST_FORMAT = 1;
export const INDEX_FORMAT = 1;
export const ARCHES = ['arm64', 'armhf', 'amd64'];
// Go-Zielarchitektur je Paketarchitektur (Debian-Namen).
export const GO_ARCH = { arm64: { goarch: 'arm64' }, armhf: { goarch: 'arm', goarm: '7' }, amd64: { goarch: 'amd64' } };
export const SIG_NAMESPACE_PACKAGE = 'dvhub-release';
export const SIG_NAMESPACE_INDEX = 'dvhub-release-index';
export const SIG_PRINCIPAL = 'dvhub-release';

// ── Allowlist ───────────────────────────────────────────────────────────────
// Zeilen: "+ muster" erlaubt, "- muster" verbietet; die letzte passende Zeile
// gewinnt, ohne Treffer ist die Datei verboten. Muster: "*" = beliebig ohne "/",
// "**" = beliebig auch über "/", "?" = ein Zeichen; ein Muster mit "/" am Ende
// trifft alles darunter.

function globToRegExp(pattern) {
  let p = pattern.trim();
  let dirPrefix = false;
  if (p.endsWith('/')) { dirPrefix = true; p = p.slice(0, -1); }
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // "**/" am Anfang oder in der Mitte darf auch null Ordner treffen.
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}${dirPrefix ? '/.*' : ''}$`);
}

export function parseAllowlist(text) {
  const rules = [];
  String(text).split('\n').forEach((raw, idx) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const m = /^([+-])\s+(\S+)$/.exec(line);
    if (!m) throw new Error(`allowlist Zeile ${idx + 1}: erwartet "+ muster" oder "- muster": ${raw}`);
    rules.push({ include: m[1] === '+', pattern: m[2], re: globToRegExp(m[2]) });
  });
  return rules;
}

export function isAllowed(relPath, rules) {
  let allowed = false;
  for (const r of rules) if (r.re.test(relPath)) allowed = r.include;
  return allowed;
}

// Alle Dateien und Symlinks unter root (relativ, mit "/"), sortiert.
export function walkFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile() || st.isSymbolicLink()) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

// Kopiert die erlaubten Dateien von src nach dest (Modus-x-Bit und Symlinks
// bleiben). Gibt die Liste der übernommenen Pfade zurück.
export function assembleTree(srcRoot, destRoot, rules) {
  const taken = [];
  for (const rel of walkFiles(srcRoot)) {
    if (!isAllowed(rel, rules)) continue;
    const src = path.join(srcRoot, rel);
    const dest = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(src), dest);
    } else {
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, (st.mode & 0o111) ? 0o755 : 0o644);
    }
    taken.push(rel);
  }
  return taken;
}

// Skripte, die post-update.sh/install.sh über "$INSTALL_DIR/<pfad>" oder die
// Hilfsskript-Installation aufrufen — sie müssen im Paket liegen.
export function referencedScripts(shellText) {
  const refs = new Set();
  for (const m of String(shellText).matchAll(/\$\{?INSTALL_DIR\}?\/([A-Za-z0-9._/-]+\.(?:sh|mjs|env))/g)) refs.add(m[1]);
  for (const m of String(shellText).matchAll(/dvhub_install_helper\s+([A-Za-z0-9._-]+)\s/g)) refs.add(m[1]);
  return [...refs].sort();
}

// ── Versionen ───────────────────────────────────────────────────────────────

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v) {
  const m = SEMVER_RE.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

// -1/0/1 nach Semver 2.0 (Vorabteil sortiert vor der Version ohne).
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`ungültige Version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p < +q ? -1 : 1; continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// Zeitstempel JJJJMMTThhmmss (UTC) aus Sekunden seit 1970.
export function utcStamp(epochSec) {
  return new Date(epochSec * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// Paketversion und Kanal: Tag vX.Y.Z → X.Y.Z (stable, muss zu package.json
// passen); alles andere → <pkg>-dev.<Commit-Zeit>.<sha8> (dev).
export function computeReleaseVersion({ tag, pkgVersion, commitTime, sha }) {
  if (!parseVersion(pkgVersion) || parseVersion(pkgVersion).pre.length) {
    throw new Error(`package.json-Version ungeeignet: ${pkgVersion}`);
  }
  if (tag) {
    const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
    if (!m) throw new Error(`kein Release-Tag (vX.Y.Z): ${tag}`);
    if (m[1] !== pkgVersion) throw new Error(`Tag ${tag} passt nicht zu package.json ${pkgVersion}`);
    return { version: m[1], channel: 'stable' };
  }
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error(`Commit-SHA erwartet: ${sha}`);
  return { version: `${pkgVersion}-dev.${utcStamp(commitTime)}.${sha.slice(0, 8)}`, channel: 'dev' };
}

export function assetBaseName(version, arch) {
  return `dvhub-${version}-${arch}`;
}

// ── tar (ustar + PAX für lange Pfade) ───────────────────────────────────────

const BLOCK = 512;
const RECORD = 10240;

function octal(n, width) {
  const s = Math.trunc(n).toString(8);
  if (s.length > width - 1) throw new Error(`Zahl zu groß für tar-Feld: ${n}`);
  return s.padStart(width - 1, '0') + '\0';
}

function splitUstarName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  // An einem "/" teilen: prefix ≤ 155, name ≤ 100 Bytes.
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest) return { name: rest, prefix };
  }
  return null;
}

function header({ name, prefix = '', mode, size, mtime, type, linkname = '' }) {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  h.write(octal(0, 8), 329, 8, 'ascii');
  h.write(octal(0, 8), 337, 8, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

function pad(len) {
  const r = len % BLOCK;
  return r ? Buffer.alloc(BLOCK - r, 0) : Buffer.alloc(0);
}

// entries: [{ path, type: 'file'|'dir'|'symlink', mode, data?, linkname? }]
// Reihenfolge, Zeit, Besitzer und Modi sind fest — gleiche Eingabe, gleiche Bytes.
export function createTar(entries, { mtime }) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks = [];
  for (const e of sorted) {
    if (!e.path || e.path.startsWith('/') || e.path.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      throw new Error(`ungültiger Pfad im Paket: ${e.path}`);
    }
    const isDir = e.type === 'dir';
    const fullName = isDir ? `${e.path}/` : e.path;
    const data = e.type === 'file' ? e.data : Buffer.alloc(0);
    const typeflag = isDir ? '5' : e.type === 'symlink' ? '2' : '0';
    const mode = isDir ? 0o755 : e.type === 'symlink' ? 0o777 : (e.mode & 0o111 ? 0o755 : 0o644);
    const linkname = e.type === 'symlink' ? e.linkname : '';
    let split = splitUstarName(fullName);
    const pax = [];
    if (!split) {
      // Zu lang für ustar: der echte Pfad steht im PAX-Kopf davor, das
      // Namensfeld trägt nur einen gekürzten Platzhalter.
      pax.push(paxRecord('path', fullName));
      split = { name: fullName.slice(0, 100), prefix: '' };
    }
    if (Buffer.byteLength(linkname) > 100) pax.push(paxRecord('linkpath', linkname));
    if (pax.length) {
      const body = Buffer.from(pax.join(''), 'utf8');
      const paxName = `PaxHeaders/${path.posix.basename(e.path)}`.slice(0, 100);
      chunks.push(header({ name: paxName, mode: 0o644, size: body.length, mtime, type: 'x' }), body, pad(body.length));
    }
    chunks.push(header({
      name: split.name,
      prefix: split.prefix,
      mode,
      size: data.length,
      mtime,
      type: typeflag,
      linkname: Buffer.byteLength(linkname) > 100 ? Buffer.from(linkname).subarray(0, 100).toString('utf8') : linkname,
    }));
    if (data.length) chunks.push(data, pad(data.length));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  let tar = Buffer.concat(chunks);
  if (tar.length % RECORD) tar = Buffer.concat([tar, Buffer.alloc(RECORD - (tar.length % RECORD), 0)]);
  return tar;
}

function readStr(buf, off, len) {
  const s = buf.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z === -1 ? s : s.subarray(0, z)).toString('utf8');
}

// Leser für Tests und Prüfungen: [{ path, type, mode, size, mtime, uid, gid, uname, gname, data, linkname }]
export function readTar(buf) {
  const out = [];
  let off = 0;
  let pax = {};
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const stored = parseInt(readStr(h, 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
    if (sum !== stored) throw new Error(`tar-Prüfsumme falsch bei Offset ${off}`);
    const size = parseInt(readStr(h, 124, 12) || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const dataOff = off + BLOCK;
    const data = buf.subarray(dataOff, dataOff + size);
    off = dataOff + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      pax = {};
      let p = 0;
      const s = data.toString('utf8');
      while (p < s.length) {
        const sp = s.indexOf(' ', p);
        const len = parseInt(s.slice(p, sp), 10);
        const rec = s.slice(sp + 1, p + len - 1);
        const eq = rec.indexOf('=');
        pax[rec.slice(0, eq)] = rec.slice(eq + 1);
        p += len;
      }
      continue;
    }
    const prefix = readStr(h, 345, 155);
    let name = prefix ? `${prefix}/${readStr(h, 0, 100)}` : readStr(h, 0, 100);
    if (pax.path) name = pax.path;
    const linkname = pax.linkpath || readStr(h, 157, 100);
    pax = {};
    out.push({
      path: name.replace(/\/$/, ''),
      type: type === '5' ? 'dir' : type === '2' ? 'symlink' : type === '0' ? 'file' : `other:${type}`,
      mode: parseInt(readStr(h, 100, 8), 8),
      uid: parseInt(readStr(h, 108, 8), 8),
      gid: parseInt(readStr(h, 116, 8), 8),
      size,
      mtime: parseInt(readStr(h, 136, 12), 8),
      uname: readStr(h, 265, 32),
      gname: readStr(h, 297, 32),
      linkname,
      data: Buffer.from(data),
    });
  }
  return out;
}

// gzip mit festem Kopf: mtime 0, OS 3 (Unix) — Node schreibt auf macOS 19.
export function gzipDeterministic(buf) {
  const gz = zlib.gzipSync(buf, { level: 9, memLevel: 9 });
  gz.writeUInt32LE(0, 4);
  gz[9] = 3;
  return gz;
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

// Einträge (Dateien, Symlinks, alle Ordner) aus einem Baum.
export function collectEntries(root) {
  const entries = [];
  const dirs = new Set();
  for (const rel of walkFiles(root)) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      const linkname = fs.readlinkSync(abs);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), linkname));
      if (path.posix.isAbsolute(linkname) || resolved.startsWith('../') || resolved === '..') {
        throw new Error(`Symlink zeigt aus dem Paket: ${rel} -> ${linkname}`);
      }
      entries.push({ path: rel, type: 'symlink', linkname, mode: 0o777 });
    } else {
      entries.push({ path: rel, type: 'file', mode: st.mode & 0o777, data: fs.readFileSync(abs) });
    }
  }
  for (const d of dirs) entries.push({ path: d, type: 'dir', mode: 0o755 });
  return entries;
}

// Manifest: alles außer dem Manifest selbst, sortiert.
export function buildManifest({ entries, meta }) {
  const files = entries
    .filter((e) => e.type !== 'dir' && e.path !== MANIFEST_NAME)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => (e.type === 'symlink'
      ? { path: e.path, type: 'symlink', target: e.linkname }
      : { path: e.path, sha256: sha256(e.data), size: e.data.length, mode: e.mode & 0o111 ? '0755' : '0644' }));
  return { format: MANIFEST_FORMAT, ...meta, files };
}

export function packTree(root, { mtime, meta }) {
  const entries = collectEntries(root).filter((e) => e.path !== MANIFEST_NAME);
  const manifest = buildManifest({ entries, meta });
  const manifestBuf = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  entries.push({ path: MANIFEST_NAME, type: 'file', mode: 0o644, data: manifestBuf });
  const tar = createTar(entries, { mtime });
  return { tar, gz: gzipDeterministic(tar), manifest, manifestBuf };
}

// ── Abhängigkeiten ──────────────────────────────────────────────────────────
// node_modules muss architekturneutral sein: keine Lifecycle-Skripte, kein
// node-gyp, keine .node-Binaries, keine os/cpu-Einschränkungen im Lockfile.
const LIFECYCLE = ['preinstall', 'install', 'postinstall'];

export function checkDependencies(appDir) {
  const problems = [];
  const lock = JSON.parse(fs.readFileSync(path.join(appDir, 'package-lock.json'), 'utf8'));
  for (const [key, pkg] of Object.entries(lock.packages || {})) {
    if (!key || pkg.dev) continue;
    if (pkg.hasInstallScript) problems.push(`${key}: hasInstallScript`);
    if (pkg.os || pkg.cpu) problems.push(`${key}: os/cpu-Einschränkung (${JSON.stringify({ os: pkg.os, cpu: pkg.cpu })})`);
  }
  const nm = path.join(appDir, 'node_modules');
  if (fs.existsSync(nm)) {
    for (const rel of walkFiles(nm)) {
      const base = path.posix.basename(rel);
      if (base === 'binding.gyp') problems.push(`node_modules/${rel}: binding.gyp`);
      if (base.endsWith('.node')) problems.push(`node_modules/${rel}: natives Modul`);
      if (base === 'package.json' && !rel.includes('/test/')) {
        let pj;
        try { pj = JSON.parse(fs.readFileSync(path.join(nm, rel), 'utf8')); } catch { continue; }
        for (const s of LIFECYCLE) if (pj?.scripts?.[s] && pj.name) problems.push(`node_modules/${rel}: scripts.${s}`);
      }
    }
  }
  return problems;
}

// Abschnitt einer Version aus CHANGELOG.md: oberste Aufzählungspunkte ohne
// Markdown, gekürzt — für die Änderungsliste im Index.
export function changelogSection(text, version) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## [')) break;
    const m = /^- (.+)$/.exec(l);
    if (!m) continue;
    const t = m[1].replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
    out.push(t.length > 160 ? `${t.slice(0, 157)}…` : t);
  }
  return out;
}

// ── Kanal-Index ─────────────────────────────────────────────────────────────

const MAX_INDEX_RELEASES = 10;

// Fügt ein Release (mit Artefakten je Architektur) in einen Index ein; ältere
// Einträge bleiben, die Liste ist absteigend nach Version sortiert.
export function mergeIndex(prev, { channel, release, keep = MAX_INDEX_RELEASES }) {
  const base = prev && prev.format === INDEX_FORMAT && prev.channel === channel ? prev : { format: INDEX_FORMAT, channel, releases: [] };
  const others = (base.releases || []).filter((r) => r.version !== release.version);
  const releases = [release, ...others].sort((a, b) => compareVersions(b.version, a.version)).slice(0, keep);
  return { format: INDEX_FORMAT, channel, latest: releases[0].version, generated: release.date, releases };
}

export function validateIndex(idx, channel) {
  if (!idx || idx.format !== INDEX_FORMAT) throw new Error('Index: unbekanntes Format');
  if (idx.channel !== channel) throw new Error(`Index: Kanal ${idx.channel} statt ${channel}`);
  if (!Array.isArray(idx.releases) || !idx.releases.length) throw new Error('Index: keine Releases');
  for (const r of idx.releases) {
    if (!parseVersion(r.version)) throw new Error(`Index: ungültige Version ${r.version}`);
    for (const [arch, a] of Object.entries(r.artifacts || {})) {
      if (!ARCHES.includes(arch)) throw new Error(`Index: unbekannte Architektur ${arch}`);
      if (!/^[0-9a-f]{64}$/.test(a.sha256 || '')) throw new Error(`Index: sha256 fehlt (${r.version}/${arch})`);
      if (!Number.isInteger(a.size) || a.size <= 0) throw new Error(`Index: Größe fehlt (${r.version}/${arch})`);
      if (typeof a.url !== 'string' || typeof a.sig !== 'string') throw new Error(`Index: url/sig fehlt (${r.version}/${arch})`);
    }
  }
  return idx;
}
