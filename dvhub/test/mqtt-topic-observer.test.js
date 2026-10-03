// test/mqtt-topic-observer.test.js -- RED tests for the MQTT topic-observer (D-05)
//
// Wave 0 (plan 09.4-01): these tests are written FIRST, against a module that
// does not exist yet. They are EXPECTED TO FAIL with MODULE_NOT_FOUND until
// plan 09.4-02 ships `services/mqtt/topic-observer.js`. RED is correct here.
//
// Contract under test (from 09.4-RESEARCH.md § "MQTT topic-observer"):
//   createMqttTopicObserver(hub, ctx) -> { start, close, getTopics, get observedSince }
//   - start() calls hub.subscribe('#', onMessage)
//   - onMessage(topic, payload): topics.get(topic) -> {count, lastAt, lastPayload}
//     count++; lastAt = Date.now(); lastPayload = String(payload).slice(0, 512)
//   - MAX_TOPICS = 500 — evict oldest by lastAt when a NEW topic exceeds the cap
//   - MAX_PAYLOAD_CHARS = 512
//   - getTopics() -> [{topic,count,lastAt,lastPayload}] sorted by lastAt desc
//   - close() clears the Map
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMqttTopicObserver } from '../services/mqtt/topic-observer.js';

// ---------- mock hub ----------
// Models services/mqtt/index.js subscribe(pattern, handler): the observer
// subscribes to '#' and the hub fans every broker message to matching handlers.
// _fire(topic, payload) invokes every handler whose pattern is '#' with
// (topic, Buffer.from(String(payload))) — the same shape the real hub delivers.
function makeMockHub() {
  const subs = []; // { pattern, handler }
  return {
    subscribe(pattern, handler) { subs.push({ pattern, handler }); },
    unsubscribe(pattern, handler) {
      const i = subs.findIndex((x) => x.pattern === pattern && x.handler === handler);
      if (i >= 0) subs.splice(i, 1);
    },
    _fire(topic, payload) {
      const buf = Buffer.from(String(payload));
      for (const s of subs) {
        if (s.pattern === '#') s.handler(topic, buf);
      }
    },
    _subs: subs
  };
}

function makeMockCtx() {
  return { pushLog: () => {} };
}

describe('createMqttTopicObserver', () => {
  it('counts messages and records lastAt per topic', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.start();
    observer.getTopics(); // erster Abruf (Inspektor geöffnet) setzt das '#'-Abo

    hub._fire('a/b', '1');
    hub._fire('a/b', '2');
    hub._fire('a/b', '3');
    hub._fire('c/d', '9');

    const topics = observer.getTopics();
    const ab = topics.find(t => t.topic === 'a/b');
    const cd = topics.find(t => t.topic === 'c/d');

    assert.ok(ab, "'a/b' topic observed");
    assert.equal(ab.count, 3, "'a/b' counted 3 messages");
    assert.equal(typeof ab.lastAt, 'number');
    assert.ok(ab.lastAt > 0, 'lastAt is a positive timestamp');

    assert.ok(cd, "'c/d' topic observed");
    assert.equal(cd.count, 1, "'c/d' counted 1 message");
  });

  it('stores lastPayload capped at 512 chars', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.start();
    observer.getTopics(); // erster Abruf (Inspektor geöffnet) setzt das '#'-Abo

    hub._fire('big/topic', 'x'.repeat(1000));

    const entry = observer.getTopics().find(t => t.topic === 'big/topic');
    assert.ok(entry, 'big/topic observed');
    assert.equal(entry.lastPayload.length, 512, 'lastPayload truncated to 512 chars');
  });

  it('getTopics sorts by lastAt descending', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.start();
    observer.getTopics(); // erster Abruf (Inspektor geöffnet) setzt das '#'-Abo

    hub._fire('old', '1');
    hub._fire('new', '2');

    const topics = observer.getTopics();
    assert.equal(topics[0].topic, 'new', 'most recent topic sorts first');
  });

  it('evicts the oldest topic when MAX_TOPICS exceeded', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.start();
    observer.getTopics(); // erster Abruf (Inspektor geöffnet) setzt das '#'-Abo

    // 501 distinct topics t0..t500 — exceeds the MAX_TOPICS=500 cap by one.
    // t0 is fired first so it has the oldest lastAt and must be evicted.
    for (let i = 0; i <= 500; i++) {
      hub._fire('t' + i, String(i));
    }

    const topics = observer.getTopics();
    assert.equal(topics.length, 500, 'topic Map capped at 500 entries');
    assert.equal(
      topics.find(t => t.topic === 't0'),
      undefined,
      "oldest topic 't0' was evicted"
    );
  });

  it('close() clears all topics', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.start();
    observer.getTopics(); // erster Abruf (Inspektor geöffnet) setzt das '#'-Abo

    hub._fire('a/b', 'payload');
    observer.close();

    assert.deepEqual(observer.getTopics(), [], 'close() empties the topic Map');
  });

  it('hört erst mit, wenn die Liste gelesen wird (kein Dauer-Abo auf #)', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.start();

    assert.equal(hub._subs.length, 0, 'start() allein abonniert nichts');
    assert.equal(observer.observing, false);
    assert.equal(observer.observedSince, null);

    hub._fire('N/x/system/0/Dc/Battery/Soc', '50'); // niemand hört zu
    assert.deepEqual(observer.getTopics(), [], 'erster Abruf: noch leer, setzt aber das Abo');
    assert.ok(hub._subs.some((x) => x.pattern === '#'), "getTopics() abonniert '#'");
    assert.equal(observer.observing, true);
    assert.equal(typeof observer.observedSince, 'number');

    hub._fire('N/x/system/0/Dc/Battery/Soc', '51');
    assert.equal(observer.getTopics().length, 1);
    assert.equal(hub._subs.length, 1, 'kein zweites Abo bei weiteren Abrufen');
  });

  it('beendet das Abo 10 min nach dem letzten Abruf und setzt es beim nächsten wieder', () => {
    const hub = makeMockHub();
    let t = 1_000_000;
    const observer = createMqttTopicObserver(hub, { pushLog: () => {}, now: () => t });
    observer.start();
    observer.getTopics();
    hub._fire('a/b', '1');

    t += 9 * 60_000; observer.checkIdle();
    assert.equal(observer.observing, true, 'nach 9 min noch aktiv');
    observer.getTopics();                      // Inspektor fragt wieder → Frist neu
    t += 9 * 60_000; observer.checkIdle();
    assert.equal(observer.observing, true);

    t += 60_000; observer.checkIdle();
    assert.equal(observer.observing, false, '10 min ohne Abruf → Abo beendet');
    assert.equal(hub._subs.length, 0, "'#' beim Hub abgemeldet");

    assert.deepEqual(observer.getTopics(), [], 'Liste beginnt neu');
    assert.equal(hub._subs.length, 1, 'nächster Abruf abonniert wieder');
    observer.close();
    assert.equal(hub._subs.length, 0, 'close() meldet ab');
  });

  it('vor start() und nach close() wird nichts abonniert', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.getTopics();
    assert.equal(hub._subs.length, 0);
    observer.start(); observer.getTopics(); observer.close();
    observer.getTopics();
    assert.equal(hub._subs.length, 0);
  });
});
