import fs from 'node:fs';

// Item 25-03 — atomare NOT-HALT-State-Persistenz.
//
// Dediziertes, server-freies Modul: importiert NUR `node:fs`, exportiert einen
// reinen Helper und bootet KEINEN HTTP-Server. Damit kann sowohl server.js
// (persistControlState) als auch der Unit-Test den Helper importieren, ohne dass
// server.js' Top-Level-`web.listen(...)` ausgelöst wird. server-utils.js bleibt
// bewusst importfrei ("ZERO imports") — deshalb ein eigenes Modul statt dort.
//
// Pattern: tmp-Datei schreiben → atomarer rename auf das Ziel (POSIX-atomar auf
// demselben Filesystem). Ein abgebrochener Write (Crash/Stromausfall) hinterlässt
// damit entweder die alte vollständige oder die neue vollständige Datei — nie eine
// halbe/korrupte. loadControlState() sieht so nie eine Partial-Write-Datei und
// fällt nicht stillschweigend in den Normalbetrieb (= aktiver NOT-HALT bliebe
// erhalten). KEIN fs.fsync — konsistent zu den 6 vorhandenen Repo-Patterns
// (config-model.js:3542-3545, migration-runner.js:110-112 u. a.; RESEARCH Befund 3).

/**
 * Schreibt `stateObj` atomar als JSON nach `filePath` (tmp + rename).
 * @param {string} filePath Zielpfad (z. B. <DATA_DIR>/control_state.json)
 * @param {object} stateObj Serialisierbarer Control-State
 */
export function atomicWriteControlState(filePath, stateObj) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(stateObj) + '\n');
  fs.renameSync(tmpPath, filePath);
}
