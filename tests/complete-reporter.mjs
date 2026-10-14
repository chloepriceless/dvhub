/*
 * tests/complete-reporter.mjs — erkennt Testdateien, die mitten im Lauf still
 * enden (2026-10-15).
 *
 * Fund: Endet der Prozess einer Testdatei vorzeitig mit Code 0 (z. B.
 * `process.exit(0)`; im vollen Lauf unter Last zweimal bei
 * family-routes.test.js beobachtet, Ursache ungeklärt), verschwinden die
 * restlichen Tests spurlos — `# fail 0`, Exit 0, die Sperre war grün. Ein
 * hängender Test wird dagegen als „cancelled“ gemeldet.
 *
 * Node meldet jeden Test beim Einreihen (`test:enqueue`) — auch die, die nie
 * zu Ende laufen. Dieser Reporter merkt sich alle eingereihten Tests und zieht
 * die ab, die ein Ergebnis haben (`test:pass`, inkl. skip/todo, oder
 * `test:fail`). Bleibt etwas übrig, nennt er Datei und Test und setzt den
 * Exit-Code auf 1.
 *
 * Läuft neben dem normalen Reporter (dvhub/package.json „test“):
 *   --test-reporter=tap --test-reporter-destination=stdout
 *   --test-reporter=../tests/complete-reporter.mjs --test-reporter-destination=stderr
 */

const keyOf = (d) => `${d.file || '?'}\u0000${d.nesting}\u0000${d.name}\u0000${d.line ?? ''}:${d.column ?? ''}`;

export default async function* completeReporter(source) {
  const open = new Map();
  let total = 0;
  for await (const ev of source) {
    const d = ev.data || {};
    // Der Eintrag für die Datei selbst (Name = Dateiname, Ebene 0) bekommt bei
    // Prozess-Isolation nie ein Ergebnis — nicht mitzählen.
    // (Name ist der Pfad, wie er übergeben wurde — z. B. test/x.test.js.)
    const isFileEntry = d.nesting === 0 && d.file && typeof d.name === 'string'
      && d.file.replace(/\\/g, '/').endsWith(d.name.replace(/\\/g, '/').replace(/^\.\//, ''));
    if (ev.type === 'test:enqueue' && !isFileEntry) {
      open.set(keyOf(d), (open.get(keyOf(d)) || 0) + 1);
      total++;
    } else if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      const k = keyOf(d);
      const n = open.get(k) || 0;
      if (n <= 1) open.delete(k); else open.set(k, n - 1);
    }
  }
  const missing = [...open.keys()].map((k) => k.split('\u0000'));
  if (!missing.length) {
    yield `complete-reporter: OK (${total} eingereiht, alle mit Ergebnis)\n`;
    return;
  }
  const byFile = new Map();
  for (const [file, , name] of missing) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(name);
  }
  yield `complete-reporter: FEHLER — ${missing.length} Tests eingereiht, aber ohne Ergebnis (Prozess vorzeitig beendet?):\n`;
  for (const [file, names] of byFile) {
    yield `  ${file}\n`;
    for (const n of names.slice(0, 12)) yield `    - ${n}\n`;
    if (names.length > 12) yield `    … und ${names.length - 12} weitere\n`;
  }
  process.exitCode = 1;
}
