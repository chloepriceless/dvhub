// services/container-shared.js — Adresse von DVhub für andere Container (2026-10-18).
//
// Der EOS-Wächter (docker/compose.yml, configs dvhub-eos-watch) muss DVhub über
// 127.0.0.1 erreichen. DVHUB_HTTP_PORT gilt nur beim ersten Start; wer den Port
// später in der Oberfläche ändert, hört woanders. Deshalb schreibt DVhub beim
// Start die tatsächliche Adresse in ein gemeinsames Volume (DVHUB_SHARED_DIR),
// der Wächter liest sie dort.
import fs from 'node:fs';
import path from 'node:path';

export const DVHUB_URL_FILE = 'dvhub-url';

/** Schreibt http://127.0.0.1:<port> nach <dir>/dvhub-url. Wirft nie; true bei Erfolg. */
export function writeSharedDvhubUrl(dir, port, fsImpl = fs) {
  const p = Number(port);
  if (!dir || !Number.isInteger(p) || p <= 0 || p > 65535) return false;
  try {
    const target = path.join(dir, DVHUB_URL_FILE);
    const tmp = `${target}.tmp-${process.pid}`;
    fsImpl.writeFileSync(tmp, `http://127.0.0.1:${p}\n`, { mode: 0o644 });
    fsImpl.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}
