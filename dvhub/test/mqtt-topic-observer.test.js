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

    hub._fire('big/topic', 'x'.repeat(1000));

    const entry = observer.getTopics().find(t => t.topic === 'big/topic');
    assert.ok(entry, 'big/topic observed');
    assert.equal(entry.lastPayload.length, 512, 'lastPayload truncated to 512 chars');
  });

  it('getTopics sorts by lastAt descending', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.start();

    hub._fire('old', '1');
    hub._fire('new', '2');

    const topics = observer.getTopics();
    assert.equal(topics[0].topic, 'new', 'most recent topic sorts first');
  });

  it('evicts the oldest topic when MAX_TOPICS exceeded', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.start();

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

    hub._fire('a/b', 'payload');
    observer.close();

    assert.deepEqual(observer.getTopics(), [], 'close() empties the topic Map');
  });

  it('observedSince is set after start()', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.start();

    assert.equal(typeof observer.observedSince, 'number', 'observedSince is a number after start()');
    assert.ok(observer.observedSince > 0, 'observedSince is a positive timestamp');
  });

  it('subscribes to the # wildcard on start()', () => {
    const hub = makeMockHub();
    const observer = createMqttTopicObserver(hub, makeMockCtx());
    observer.start();

    assert.ok(
      hub._subs.some(s => s.pattern === '#'),
      "start() subscribes to the '#' multi-level wildcard"
    );
  });
});
