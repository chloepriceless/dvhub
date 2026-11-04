// Runtime-Worker-Attrappe für test/support-tunnel-notify-worker.test.js:
// nimmt notify_direct über dasselbe attachRuntimeCommandServer wie server.js an
// und meldet jede Sendung des (Attrappen-)Benachrichtigungsdienstes zurück.
import { attachRuntimeCommandServer, RUNTIME_MESSAGE_TYPES } from '../../runtime-worker-protocol.js';
import { notifyDirectHandler } from '../../services/notifications/direct-relay.js';

const service = { sendDirect: async (msg) => { process.send({ type: 'test_notified', msg }); return { sent: 1 }; } };
attachRuntimeCommandServer({ handlers: { notify_direct: notifyDirectHandler(() => service) } });
process.send({ type: RUNTIME_MESSAGE_TYPES.RUNTIME_READY, pid: process.pid });
