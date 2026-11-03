// Runtime-Worker-Attrappe für test/grid-share-reset-worker.test.js: schreibender
// Netzstrom-Zähler im Datenordner DVHUB_TEST_GS_DIR, Befehle über dasselbe
// attachRuntimeCommandServer wie server.js. DVHUB_TEST_GS_EXIT=1: beendet sich
// beim ersten Befehl ohne Antwort.
import { createGridShareTracker } from '../../services/optimizer/grid-share.js';
import { attachRuntimeCommandServer, RUNTIME_MESSAGE_TYPES } from '../../runtime-worker-protocol.js';

const cfg = { optimizer: { allowGridCharge: true, gridChargeWithoutMispel: true }, schedule: { timezone: 'Europe/Berlin' } };
const gridShare = createGridShareTracker({ getCfg: () => cfg, pushLog: () => {}, dataDir: process.env.DVHUB_TEST_GS_DIR });
if (process.env.DVHUB_TEST_GS_EXIT === '1') {
  process.on('message', (m) => { if (m?.type === RUNTIME_MESSAGE_TYPES.COMMAND_REQUEST) process.exit(3); });
} else {
  attachRuntimeCommandServer({
    handlers: { grid_share_reset: (p) => gridShare.reset({ reason: p.reason || '', actor: p.actor ?? null }) },
  });
}
process.send({ type: RUNTIME_MESSAGE_TYPES.RUNTIME_READY, pid: process.pid });
