import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { mediaId } from "../export.mjs";

// Execute the real worker in isolation; supply its actual imported mediaId helper.
const source = (await readFile(new URL("../background.js", import.meta.url), "utf8"))
  .replace('import { mediaId } from "./export.mjs";', "");
const lastItem = "This is the last item left. Choose Keep or Unsave.";
const url = id => `https://www.instagram.com/reel/${id}/`;

function fixture(ids = ["a", "b", "c", "d"], extra = {}, sessionData = {}, behavior = {}) {
  const local = { data: structuredClone({ schema: 1, ids, types: Object.fromEntries(ids.map(id => [id, "reel"])), decisions: {}, deferred: [], ...extra }) };
  const session = structuredClone(sessionData);
  const tabs = new Map();
  const removed = [];
  const sent = [];
  let localWrites = 0;
  let nextTab = 1;
  let listener;
  let removedListener;
  let updatedListener;
  const area = (state, onWrite = () => {}) => ({
    async get(key) { return structuredClone({ [key]: state[key] }); },
    async set(values) { Object.assign(state, structuredClone(values)); onWrite(); },
    async remove(keys) { for (const key of [keys].flat()) delete state[key]; }
  });
  function activate(tab) {
    for (const other of tabs.values()) {
      if (other.windowId === tab.windowId) other.active = other.id === tab.id;
    }
  }
  const chrome = {
    storage: { local: area(local, () => localWrites++), session: area(session) },
    tabs: {
      async create(properties) {
        const tab = { id: nextTab++, windowId: 1, active: true, pinned: false, muted: false, ...properties };
        tabs.set(tab.id, tab);
        if (tab.active) activate(tab);
        return structuredClone(tab);
      },
      async get(id) {
        assert.ok(tabs.has(id), `Tab ${id} must exist`);
        return structuredClone(tabs.get(id));
      },
      async update(id, properties) {
        assert.ok(tabs.has(id), `Tab ${id} must exist`);
        if (properties.url && behavior.failNextNavigation) {
          behavior.failNextNavigation = false;
          throw new Error("Simulated navigation failure");
        }
        const tab = tabs.get(id);
        Object.assign(tab, structuredClone(properties));
        if (properties.active) activate(tab);
        return structuredClone(tab);
      },
      async remove(id) {
        assert.ok(tabs.delete(id), `Tab ${id} must exist`);
        removed.push(id);
        removedListener?.(id, { windowId: 1, isWindowClosing: false });
      },
      async query(properties) {
        return structuredClone([...tabs.values()].filter(tab =>
          Object.entries(properties).every(([key, value]) => tab[key] === value)));
      },
      async sendMessage(id, message) {
        assert.ok(tabs.has(id), `Tab ${id} must exist`);
        sent.push({ id, message: structuredClone(message) });
        return {};
      },
      onRemoved: { addListener(callback) { removedListener = callback; } },
      onUpdated: { addListener(callback) { updatedListener = callback; } }
    },
    windows: { async update(id, properties) { return { id, ...properties }; } },
    runtime: { id: "a".repeat(32), getURL: path => "chrome-extension://" + "a".repeat(32) + "/" + path,
      onMessage: { addListener(callback) { listener = callback; } } }
  };
  runInNewContext(source, { chrome, mediaId, URL, crypto: webcrypto, console });
  const send = (message, sender = {}) => new Promise(resolve => {
    const trustedSender = sender.tab
      ? { id: chrome.runtime.id, ...sender }
      : { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html"), ...sender };
    assert.equal(listener(message, trustedSender, result => resolve(structuredClone(result))), true);
  });
  const ok = async (message, sender) => {
    const result = await send(message, sender);
    assert.equal(result.error, undefined, result.error);
    return result;
  };
  const from = (tabId, type, extraMessage = {}) => {
    const tab = structuredClone(tabs.get(tabId));
    assert.ok(tab, "The content-script sender must have a tab");
    return send({ type, page: tab.url, ...extraMessage }, { tab, url: tab.url });
  };
  const content = (type, extraMessage) => from(session.undo?.tab ?? session.run?.slots[0]?.tab, type, extraMessage);
  return {
    local, session, tabs, removed, sent, chrome, send, ok, from, content,
    get data() { return local.data; },
    get writes() { return localWrites; },
    get current() { return session.run?.slots[0]?.id; },
    get slots() { return session.run?.slots.map(slot => slot.id) ?? []; },
    restartWorker() {
      // Discard the worker's VM/global state while browser storage and tabs survive.
      runInNewContext(source, { chrome, mediaId, URL, crypto: webcrypto, console });
    },
    async start(size = 1, type = "start") { return ok({ type, size, windowId: 1 }); },
    async redirect(tabId, destination) {
      const tab = tabs.get(tabId);
      tab.url = destination;
      tab.status = "complete";
      updatedListener?.(tabId, { url: destination, status: "complete" }, structuredClone(tab));
      await ok({ type: "summary" });
    },
    async decide(decision) {
      const result = await content("decision", { decision });
      assert.equal(result.error, undefined, result.error);
      return result;
    }
  };
}

async function afterR1() {
  const f = fixture();
  await f.start();
  await f.decide("later");
  return f;
}

test("Schema 1 summary and state reads preserve normal and replay data without local writes", async () => {
  for (const replay of [false, true]) {
    const data = { schema: 1, types: { a: "p", b: "reel", c: "tv" },
      decisions: { a: "kept" }, deferred: ["c"], undoHistory: [],
      ...(replay ? { replayIndex: 0, replayId: "schema-1-pass", replayDeferred: ["c"],
        replayProgress: { decided: 0, total: 3 } } : {}) };
    const f = fixture(["a", "b", "c"], data);
    const stored = structuredClone(f.data);
    await f.start();
    const summary = await f.ok({ type: "summary" });
    const state = await f.content("state");
    assert.deepEqual([summary.total, summary.pending, summary.later, summary.kept, summary.unsaved, summary.unavailable],
      [3, 1, 1, 1, 0, 0]);
    assert.deepEqual(state.progress, replay ? { decided: 0, total: 3, later: 1 } : { total: 3, decided: 1, later: 1 });
    assert.equal(f.current, replay ? "a" : "b");
    assert.deepEqual(f.data, stored);
    assert.equal(f.writes, 0);
  }
});

test("Schema 1 empty-slot recovery survives worker restart without changing persistent progress", async () => {
  const f = fixture(["a", "b", "c"], { schema: 1, decisions: { a: "kept" }, deferred: ["c"],
    types: { a: "p", b: "reel", c: "tv" }, undoHistory: [] },
    { run: { size: 1, windowId: 1, slots: [] } });
  const stored = structuredClone(f.data);
  f.restartWorker();
  await f.start();
  assert.equal(f.current, "b");
  assert.equal(f.slots.length, 1);
  assert.equal(f.tabs.get(f.session.run.slots[0].tab).url, "https://www.instagram.com/reel/b/");
  assert.deepEqual(f.data, stored);
  assert.equal(f.writes, 0);
});

test("R1: Later stores no decision and serves the next new item", async () => {
  const f = await afterR1();
  assert.deepEqual(f.data.decisions, {});
  assert.equal(f.current, "b");
  assert.deepEqual(f.data.deferred, ["a"]);
  assert.deepEqual((await f.content("state")).progress, { total: 4, decided: 0, later: 1 });
});

test("R2: Deferred item returns after every new item", async () => {
  const f = await afterR1();
  for (const id of ["b", "c", "d"]) {
    assert.equal(f.current, id);
    assert.equal((await f.decide("kept")).done, false);
  }
  assert.equal(f.current, "a");
  assert.deepEqual(f.data.deferred, ["a"]);
});

test("R3: Final Unsave clears deferral and completes the queue", async () => {
  const f = await afterR1();
  for (let i = 0; i < 3; i++) await f.decide("kept");
  assert.equal((await f.decide("unsaved")).done, true);
  assert.deepEqual(f.data.deferred, []);
  const summary = await f.ok({ type: "summary" });
  assert.equal(summary.pending, 0);
  assert.equal(summary.later, 0);
  assert.equal(summary.running, false);
});

test("R4: Multiple deferrals return in first-deferred order", async () => {
  const f = fixture(["a", "b", "c"]);
  await f.start();
  await f.decide("later");
  await f.decide("later");
  for (const id of ["c", "a", "b"]) {
    assert.equal(f.current, id);
    await f.decide("kept");
  }
});

test("R5: Last-item refusal leaves pending item and storage unchanged", async () => {
  const f = fixture(["a", "b", "c"]);
  await f.start();
  await f.decide("later");
  await f.decide("kept");
  await f.decide("kept");
  const before = structuredClone(f.data);
  assert.deepEqual(await f.content("decision", { decision: "later" }), { error: lastItem });
  assert.equal(f.current, "a");
  assert.deepEqual(f.data, before);
});

test("R6: Five-tab deferral closes its tab and reopens it after new items", async () => {
  const f = fixture(["a", "b", "c", "d", "e", "f", "g"]);
  await f.start(5);
  const oldTab = f.session.run.slots[0].tab;
  await f.decide("later");
  assert.deepEqual(f.slots, ["b", "c", "d", "e", "f"]);
  assert.ok(f.removed.includes(oldTab));
  assert.deepEqual(f.data.deferred, ["a"]);
  for (const id of ["b", "c", "d", "e", "f", "g"]) {
    assert.equal(f.current, id);
    assert.equal((await f.decide("kept")).done, false);
  }
  assert.equal(f.current, "a");
  assert.notEqual(f.session.run.slots[0].tab, oldTab);
  assert.equal((await f.decide("kept")).done, true);
});

test("R7: Five-tab mode with two items refills the deferred item at the end", async () => {
  const f = fixture(["a", "b"]);
  await f.start(5);
  const oldTab = f.session.run.slots[0].tab;
  await f.decide("later");
  assert.deepEqual(f.slots, ["b", "a"]);
  assert.ok(f.removed.includes(oldTab));
  assert.notEqual(f.session.run.slots[1].tab, oldTab);
});

test("Five-tab advancement activates and unmutes before refill and sends one refresh", async () => {
  for (const action of ["kept", "later", "unsaved", "unavailable"]) {
    const f = fixture(["a", "b", "c", "d", "e", "f"]);
    await f.start(5);
    await f.content("audio", { muted: true });
    const nextTab = f.session.run.slots[1].tab;
    assert.equal(f.tabs.get(nextTab).muted, true);
    const events = [];
    for (const method of ["create", "update", "sendMessage"]) {
      const original = f.chrome.tabs[method];
      f.chrome.tabs[method] = async (...args) => {
        events.push({ method, args: structuredClone(args), next: structuredClone(f.tabs.get(nextTab)) });
        return original(...args);
      };
    }
    if (action === "unavailable") await f.content("unavailable");
    else await f.decide(action);
    const refreshes = events.filter(event => event.method === "sendMessage" && event.args[1].type === "refresh");
    assert.equal(refreshes.length, 1, `Expected one refresh after ${action}`);
    assert.equal(refreshes[0].args[0], nextTab);
    const activation = events.findIndex(event => event.method === "update" && event.args[0] === nextTab &&
      event.args[1].active === true && event.args[1].muted === false);
    const refill = events.findIndex(event => event.method === "create");
    assert.ok(activation >= 0 && activation < refill, "Activate and unmute before refilling");
    assert.equal(events[refill].next.active, true);
    assert.equal(events[refill].next.muted, false);
    assert.deepEqual(f.slots, ["b", "c", "d", "e", "f"]);
  }
});

test("Worker messages omit unused fields while preserving import, recheck, and detection behavior", async () => {
  const f = fixture(["a", "b", "c"], { decisions: { c: "unavailable" } });
  assert.deepEqual(await f.ok({ type: "import", ids: ["a", "b", "c"],
    types: { a: "reel", b: "p", c: "tv" } }), {});
  assert.equal((await f.ok({ type: "summary" })).total, 3);
  assert.equal(f.data.decisions.c, "unavailable");
  assert.deepEqual(await f.ok({ type: "recheckUnavailable" }), {});
  assert.deepEqual(f.data.decisions, {});
  await f.start(5);
  await f.start(5);
  assert.ok(f.sent.length > 0);
  for (const { message } of f.sent) assert.deepEqual(message, { type: "refresh" });
  const assertState = async (tabId, detectUnavailable) => {
    const state = await f.from(tabId, "state");
    assert.equal(Object.hasOwn(state, "queued"), false);
    assert.equal(Object.hasOwn(state, "redirected"), false);
    assert.equal(state.detectUnavailable, detectUnavailable);
    return state;
  };
  const current = f.session.run.slots[0].tab;
  const waiting = f.session.run.slots[1].tab;
  await assertState(current, true);
  await assertState(waiting, true);
  await f.redirect(waiting, "https://www.instagram.com/creator/");
  await assertState(waiting, true);
  f.session.run.reviewError = "Simulated handoff error";
  assert.equal((await assertState(current, false)).reviewError, "Simulated handoff error");
  assert.equal((await assertState(waiting, false)).reviewError, "Simulated handoff error");
});

test("R10: Later after Undo restores the interrupted tab and preserves history", async () => {
  const f = fixture();
  await f.start();
  await f.decide("unsaved");
  const interrupted = structuredClone(f.session.run.slots[0]);
  await f.ok({ type: "undo", windowId: 1 });
  assert.deepEqual(await f.content("state"), { restoring: true });
  assert.deepEqual(await f.content("restored"), { restored: true });
  const history = structuredClone(f.data.undoHistory);
  const decisions = structuredClone(f.data.decisions);
  await f.decide("later");
  assert.deepEqual(f.data.decisions, decisions);
  assert.equal(Object.hasOwn(f.data.decisions, "a"), false);
  assert.deepEqual(f.data.deferred, ["a"]);
  assert.deepEqual(f.data.undoHistory, history);
  assert.deepEqual(f.session.run.slots[0], interrupted);
  assert.equal(f.tabs.get(interrupted.tab).url, url("b"));
  assert.equal(f.session.undo, undefined);
});

test("R11: Re-import preserves only present pending deferrals in their order", async () => {
  const f = fixture(["a", "b", "c"], { deferred: ["a", "b", "c"] });
  await f.ok({ type: "import", ids: ["c", "a", "d"], types: { c: "p", a: "reel", d: "tv" } });
  assert.deepEqual(f.data.deferred, ["a", "c"]);
  await f.start();
  assert.equal(f.current, "d");
});

test("R12: Re-review defers kept items without changing decisions or resetting the cursor", async () => {
  const f = fixture(undefined, { decisions: { a: "kept", b: "kept", c: "kept", d: "kept" } });
  await f.start(1, "restart");
  const decisions = structuredClone(f.data.decisions);
  await f.decide("later");
  assert.deepEqual(f.data.decisions, decisions);
  assert.deepEqual(f.data.replayDeferred, ["a"]);
  assert.deepEqual(f.data.replayProgress, { decided: 0, total: 4 });
  for (const [index, id] of ["b", "c", "d"].entries()) {
    assert.equal(f.current, id);
    assert.equal(f.data.replayIndex, index + 1);
    await f.decide("kept");
  }
  assert.equal(f.current, "a");
  assert.equal(f.data.replayIndex, 4);
  assert.equal(f.data.replayProgress.decided, 3);
  assert.equal((await f.decide("kept")).done, true);
  assert.deepEqual(Object.keys(f.data).filter(key => key.startsWith("replay")), []);
});

test("A 0 / 6796 decided replay screen preserves existing decisions; re-import removes replay progress", async () => {
  const ids = Array.from({ length: 6796 }, (_, index) => `item${index}`);
  const decisions = Object.fromEntries(ids.slice(0, 4).map(id => [id, "kept"]));
  const f = fixture(ids, { decisions });
  const before = await f.ok({ type: "summary" });
  assert.equal(before.kept, 4);
  assert.equal(before.pending, 6792);
  assert.equal(before.replayProgress, null);

  await f.start(1, "restart"); // Popup's Start from beginning command.
  const replay = await f.ok({ type: "summary" });
  assert.equal(replay.replaying, true);
  assert.deepEqual(replay.replayProgress, { decided: 0, total: 6796, later: 0 });
  assert.deepEqual((await f.content("state")).progress, replay.replayProgress);
  assert.equal(replay.kept, before.kept);
  assert.equal(replay.pending, before.pending);
  assert.deepEqual(f.data.decisions, decisions);

  await f.ok({ type: "pause" });
  await f.ok({ type: "import", ids, types: Object.fromEntries(ids.map(id => [id, "reel"])) });
  const imported = await f.ok({ type: "summary" });
  assert.equal(imported.replaying, false);
  assert.equal(imported.replayProgress, null);
  assert.equal(imported.kept, before.kept);
  assert.equal(imported.pending, before.pending);
  assert.deepEqual(f.data.decisions, decisions);
});

test("Replay persists counters without later and derives deferrals in state and summary responses", async () => {
  for (const size of [1, 5]) {
    const f = fixture();
    await f.start(size, "restart");
    assert.deepEqual(f.data.replayProgress, { decided: 0, total: 4 });
    assert.deepEqual((await f.ok({ type: "summary" })).replayProgress, { decided: 0, total: 4, later: 0 });
    await f.decide("later");
    await f.decide("unsaved");
    assert.deepEqual(f.data.replayProgress, { decided: 1, total: 4 });
    assert.deepEqual((await f.content("state")).progress, { decided: 1, total: 4, later: 1 });
    await f.content("unavailable");
    assert.deepEqual(f.data.replayProgress, { decided: 2, total: 4 });
    assert.deepEqual((await f.ok({ type: "summary" })).replayProgress, { decided: 2, total: 4, later: 1 });
  }
});

test("Schema 1 stale later values are ignored across restarts and omitted on the next progress write", async () => {
  for (const schema of [1]) {
    const f = fixture(["a", "b", "c", "d"], {
      schema, deferred: [],
      decisions: { a: "kept", b: "unsaved", c: "kept", d: "kept" },
      replayIndex: 2, replayId: "stored-pass", replayDeferred: ["a"],
      replayProgress: { decided: 1, total: 4, later: 999 },
      undoHistory: [{ id: "b", url: url("b"), previous: "kept", replayId: "stored-pass" }]
    });
    const summary = await f.ok({ type: "summary" });
    assert.deepEqual(summary.replayProgress, { decided: 1, total: 4, later: 1 });
    const stored = structuredClone(f.data);
    f.restartWorker();
    assert.deepEqual(await f.ok({ type: "summary" }), summary);
    const reopened = fixture(stored.ids, stored);
    assert.deepEqual(await reopened.ok({ type: "summary" }), summary);
    await reopened.start();
    assert.equal(reopened.current, "c");
    assert.deepEqual((await reopened.content("state")).progress, summary.replayProgress);
    await reopened.decide("kept");
    assert.equal(reopened.current, "d");
    assert.deepEqual(reopened.data.replayProgress, { decided: 2, total: 4 });
    assert.deepEqual(reopened.data.replayDeferred, ["a"]);
    assert.deepEqual(reopened.data.undoHistory, stored.undoHistory);
  }
});

test("R13: Mixed actions never store later or skipped decisions", async () => {
  const f = fixture(undefined, { deferred: ["b"] });
  const check = () => assert.ok(Object.values(f.data.decisions).every(value => ["kept", "unsaved"].includes(value)));
  await f.start();
  for (const decision of ["later", "kept", "unsaved", "later", "kept", "kept"]) {
    await f.decide(decision);
    check();
  }
  const before = structuredClone(f.data.decisions);
  await f.start(1, "restart");
  assert.deepEqual(await f.content("decision", { decision: "skipped" }), {});
  assert.deepEqual(f.data.decisions, before);
  check();
});

test("R14: Summary separates later from pending and contains no skipped or NaN", async () => {
  const f = await afterR1();
  const summary = await f.ok({ type: "summary" });
  assert.equal(summary.pending, 3);
  assert.equal(summary.later, 1);
  assert.equal(Object.hasOwn(summary, "skipped"), false);
  assert.ok(Object.values(summary).every(value => !Number.isNaN(value)));
});

test("Repeated deferral moves an item to the tail", async () => {
  const f = fixture(["a", "b", "c"]);
  await f.start();
  await f.decide("later");
  await f.decide("later");
  await f.decide("kept");
  assert.equal(f.current, "a");
  await f.decide("later");
  assert.deepEqual(f.data.deferred, ["b", "a"]);
  assert.equal(f.current, "b");
});

test("Worker and browser restarts preserve decisions, deferral order, Undo history, and replay progress", async () => {
  for (const size of [1, 5]) {
    for (const replay of [false, true]) {
      const ids = ["a", "b", "c", "d", "e", "f"];
      const f = fixture(ids, replay ? { decisions: Object.fromEntries(ids.map(id => [id, "kept"])) } : {});
      await f.start(size, replay ? "restart" : "start");
      await f.decide("later");
      await f.decide("unsaved");
      await f.decide("kept");
      const summary = await f.ok({ type: "summary" });
      const progress = (await f.content("state")).progress;
      const stored = structuredClone(f.local.data);
      const slots = structuredClone(f.session.run.slots);
      assert.equal(f.current, "d");
      assert.deepEqual(replay ? stored.replayDeferred : stored.deferred, ["a"]);
      assert.equal(stored.undoHistory.length, 1);
      assert.equal(stored.undoHistory[0].id, "b");
      assert.equal(summary.undoCount, 1);

      f.restartWorker();
      assert.deepEqual(await f.ok({ type: "summary" }), summary);
      assert.deepEqual((await f.content("state")).progress, progress);
      assert.deepEqual(f.session.run.slots, slots);
      await f.start(size); // Return to the stored current item rather than opening a new pass.
      assert.equal(f.current, "d");
      assert.deepEqual(f.data, stored);

      // Closing Chrome clears session storage and tabs, but keeps local storage.
      // A fresh fixture also recreates every worker/global variable from scratch.
      const reopened = fixture(stored.ids, stored);
      assert.deepEqual(await reopened.ok({ type: "summary" }), { ...summary, running: false, size: undefined });
      assert.deepEqual(reopened.data, stored);
      assert.deepEqual(reopened.session, {});
      await reopened.start(size);
      assert.equal(reopened.current, "d");
      assert.deepEqual((await reopened.content("state")).progress, progress);
      assert.deepEqual(reopened.data, stored);
      for (const id of ["d", "e", "f", "a"]) {
        assert.equal(reopened.current, id, "Restart must preserve pending/deferred queue order");
        await reopened.decide("kept");
      }
      const completed = await reopened.ok({ type: "summary" });
      assert.deepEqual([completed.pending, completed.later, completed.kept, completed.unsaved], [0, 0, 5, 1]);
      assert.deepEqual(reopened.data.undoHistory, stored.undoHistory);
    }
  }
});

test("Deferrals survive pause and a new browser session", async () => {
  const f = await afterR1();
  await f.ok({ type: "pause" });
  assert.equal(f.session.run, undefined);
  const resumed = fixture(f.data.ids, f.data);
  await resumed.start();
  assert.equal(resumed.current, "b");
  assert.deepEqual(resumed.data.deferred, ["a"]);
  for (let i = 0; i < 3; i++) await resumed.decide("kept");
  assert.equal(resumed.current, "a");
});

test("Export IDs with prototype names remain safe through decisions, Undo and import", async () => {
  const ids = ["__proto__", "constructor", "toString"];
  const f = fixture(ids, { deferred: ["__proto__"] });
  await f.start();
  assert.equal(f.current, "constructor");
  await f.decide("later");
  assert.equal(f.current, "toString");
  await f.decide("kept");
  assert.equal(f.current, "__proto__");
  await f.decide("unsaved");
  await f.ok({ type: "undo", windowId: 1 });
  await f.content("restored");
  await f.decide("later");
  assert.equal(Object.hasOwn(f.data.decisions, "__proto__"), false);
  await f.ok({ type: "pause" });
  await f.ok({ type: "import", ids, types: Object.fromEntries(ids.map(id => [id, "reel"])) });
  assert.deepEqual(f.data.deferred, ["constructor", "__proto__"]);
  await f.start();
  await f.decide("kept");
  await f.decide("kept");
  assert.equal(Object.hasOwn(f.data.decisions, "__proto__"), true);
  assert.equal(f.data.decisions.__proto__, "kept");
  assert.equal(Object.getPrototypeOf(f.data.decisions), Object.prototype);
});

test("Re-review repeat deferral keeps its cursor and counters, including five-tab mode", async () => {
  for (const size of [1, 5]) {
    const f = fixture(["a", "b", "c"], { decisions: { a: "kept", b: "kept", c: "kept" } });
    await f.start(size, "restart");
    await f.decide("later");
    await f.decide("later");
    await f.decide("kept");
    assert.equal(f.current, "a");
    assert.equal(f.data.replayIndex, 3);
    await f.decide("later");
    assert.equal(f.current, "b");
    assert.equal(f.data.replayIndex, 3);
    assert.deepEqual(f.data.replayDeferred, ["b", "a"]);
    assert.deepEqual(f.data.replayProgress, { total: 3, decided: 1 });
    await f.decide("kept");
    assert.equal(f.current, "a");
    assert.equal(f.data.replayIndex, 3);
    assert.deepEqual(await f.content("decision", { decision: "later" }), { error: lastItem });
    await f.decide("unsaved");
    assert.deepEqual(Object.keys(f.data).filter(key => key.startsWith("replay")), []);
  }
});

test("Re-review resumes deferred items across browser sessions and restart clears them", async () => {
  const f = fixture(undefined, { decisions: { a: "kept", b: "kept", c: "kept", d: "kept" } });
  await f.start(1, "restart");
  await f.decide("later");
  await f.ok({ type: "pause" });
  const resumed = fixture(f.data.ids, f.data);
  await resumed.start();
  assert.equal(resumed.current, "b");
  assert.deepEqual(resumed.data.replayDeferred, ["a"]);
  await resumed.start(1, "restart");
  assert.equal(resumed.current, "a");
  assert.deepEqual(resumed.data.replayDeferred, []);
  assert.equal(resumed.data.replayProgress.decided, 0);
});

test("Import ends a re-review pass and removes all replay fields", async () => {
  const f = fixture();
  await f.start(1, "restart");
  await f.decide("later");
  await f.ok({ type: "pause" });
  await f.ok({ type: "import", ids: ["a", "b"], types: { a: "reel", b: "p" } });
  assert.deepEqual(Object.keys(f.data).filter(key => key.startsWith("replay")), []);
});

test("Later during same-pass Undo preserves kept decision and moves it to the pass tail", async () => {
  const f = fixture(undefined, { decisions: { a: "kept", b: "kept", c: "kept", d: "kept" } });
  await f.start(5, "restart");
  await f.decide("unsaved");
  assert.equal(f.data.replayProgress.decided, 1);
  await f.ok({ type: "undo", windowId: 1 });
  await f.content("restored");
  const history = structuredClone(f.data.undoHistory);
  await f.decide("later");
  assert.equal(f.data.decisions.a, "kept");
  assert.deepEqual(f.data.replayDeferred, ["a"]);
  assert.equal(f.data.replayProgress.decided, 0);
  assert.deepEqual(f.data.undoHistory, history);
  for (const id of ["b", "c", "d"]) {
    assert.equal(f.current, id);
    await f.decide("kept");
  }
  assert.equal(f.current, "a");
  await f.decide("kept");
  assert.equal(f.session.run, undefined);
});

test("Later on a kept Undo item outside a pass leaves its stored decision intact", async () => {
  const f = fixture(["a", "b"], {
    decisions: { a: "unsaved" }, undoHistory: [{ id: "a", url: url("a"), previous: "kept" }]
  });
  await f.start();
  await f.ok({ type: "undo", windowId: 1 });
  await f.content("restored");
  await f.decide("later");
  assert.equal(f.data.decisions.a, "kept");
  assert.deepEqual(f.data.deferred, ["a"]);
  await f.decide("kept");
  assert.equal(f.current, "a");
  await f.decide("kept");
  assert.equal(f.session.run, undefined);
});

test("Summary counts a kept item deferred after Undo only as later", async () => {
  for (const size of [1, 5]) {
    const f = fixture(["a", "b"], {
      decisions: { a: "unsaved" }, undoHistory: [{ id: "a", url: url("a"), previous: "kept" }]
    });
    await f.start(size);
    await f.ok({ type: "undo", windowId: 1 });
    await f.content("restored");
    await f.decide("later");
    const summary = await f.ok({ type: "summary" });
    assert.deepEqual(
      [summary.pending, summary.later, summary.kept, summary.unsaved, summary.unavailable],
      [1, 1, 0, 0, 0]
    );
    assert.equal(summary.pending + summary.later + summary.kept + summary.unsaved + summary.unavailable,
      summary.total);
    assert.equal(f.data.decisions.a, "kept", "Deferral must preserve the stored Keep decision");
    assert.equal(f.current, "b");
    await f.decide("kept");
    assert.equal(f.current, "a", "Normal review must still serve the deferred kept item");
    await f.decide("kept");
    const completed = await f.ok({ type: "summary" });
    assert.equal(completed.later, 0);
    assert.equal(completed.kept, 2);
    assert.equal(completed.running, false);
  }
});

test("Normal review skips kept items while replay includes them and preserves Keep on deferral", async () => {
  for (const size of [1, 5]) {
    const f = fixture(["a", "b", "c"], { decisions: { a: "kept", b: "kept" } });
    await f.start(size);
    assert.equal(f.current, "c");
    assert.equal((await f.decide("kept")).done, true);
    await f.start(size, "restart");
    assert.equal(f.current, "a");
    await f.decide("later");
    assert.equal(f.current, "b");
    assert.equal(f.data.decisions.a, "kept");
    assert.deepEqual(f.data.replayDeferred, ["a"]);
    const summary = await f.ok({ type: "summary" });
    // Replay deferrals have their own pass counter; lifetime categories remain disjoint.
    assert.deepEqual([summary.pending, summary.later, summary.kept, summary.unsaved, summary.unavailable],
      [0, 0, 3, 0, 0]);
    assert.deepEqual(summary.replayProgress, { decided: 0, total: 3, later: 1 });
    for (const id of ["b", "c", "a"]) {
      assert.equal(f.current, id);
      await f.decide("kept");
    }
    assert.equal(f.session.run, undefined);
    assert.deepEqual(f.data.decisions, { a: "kept", b: "kept", c: "kept" });
  }
});

test("Five-tab last-item refusal does not close the tab or create Undo history", async () => {
  const f = fixture(["a"]);
  await f.start(5);
  const tabId = f.session.run.slots[0].tab;
  assert.deepEqual(await f.content("decision", { decision: "later" }), { error: lastItem });
  assert.ok(f.tabs.has(tabId));
  assert.deepEqual(f.data.decisions, {});
  assert.equal(f.data.undoHistory, undefined);
});

test("Obsolete session fields stay inert and are not scrubbed on read", async () => {
  const f = fixture(["a", "b"]);
  await f.start();
  Object.assign(f.session.run, { retry: true, reviewed: ["b"] });
  const storedRun = structuredClone(f.session.run);
  await f.ok({ type: "summary" });
  assert.deepEqual(f.session.run, storedRun);
  await f.decide("kept");
  assert.equal(f.current, "b");
  assert.equal(f.session.run.retry, true);
  assert.deepEqual(f.session.run.reviewed, ["b"]);
});

test("Standalone Undo deferral continues pending review instead of reporting completion", async () => {
  const f = fixture(["a", "b"], {
    decisions: { a: "unsaved" }, undoHistory: [{ id: "a", url: url("a"), previous: null }]
  });
  await f.chrome.tabs.create({ windowId: 1, url: "https://www.instagram.com/", active: true });
  await f.ok({ type: "undo", windowId: 1 });
  await f.content("restored");
  assert.equal((await f.decide("later")).done, false);
  assert.equal(f.current, "b");
  assert.deepEqual(f.data.deferred, ["a"]);
  await f.decide("kept");
  assert.equal(f.current, "a");
});

const pauseMessage = "10 items in a row looked unavailable. You may be logged out or Instagram may be limiting this account. Check Instagram, then resume.";
const manyIds = count => Array.from({ length: count }, (_, index) => `item${index}`);

test("U1: Current unavailable item is recorded and the same tab advances", async () => {
  const f = fixture(["a", "b", "c"]);
  await f.start();
  const tabId = f.session.run.slots[0].tab;
  assert.equal((await f.content("unavailable")).done, false);
  assert.equal(f.data.decisions.a, "unavailable");
  assert.equal(f.current, "b");
  assert.equal(f.session.run.slots[0].tab, tabId);
  assert.equal(f.tabs.get(tabId).url, url("b"));
  assert.equal(f.session.notice, 1);
  assert.equal((await f.ok({ type: "summary" })).unavailable, 1);
  assert.equal((await f.content("state")).progress.decided, 1);
  await f.decide("kept");
  assert.equal(f.current, "c");
});

test("U2: Inactive waiting unavailable slot is removed before close without pausing", async () => {
  const f = fixture(["a", "b", "c", "d", "e", "f", "g", "h"]);
  await f.start(5);
  const slot = structuredClone(f.session.run.slots[2]);
  assert.equal(f.tabs.get(slot.tab).active, false);
  const state = await f.from(slot.tab, "state");
  assert.equal(state.current, false);
  assert.equal(state.detectUnavailable, true);
  await f.from(slot.tab, "unavailable");
  // Drain abandon() through the worker's serialized message queue.
  assert.equal((await f.ok({ type: "summary" })).running, true);
  assert.deepEqual(f.slots, ["a", "b", "d", "e", "f"]);
  assert.deepEqual(f.data.decisions, { c: "unavailable" });
  assert.ok(f.removed.includes(slot.tab));
  const replacement = f.tabs.get(f.session.run.slots.at(-1).tab);
  assert.equal(replacement.active, false);
  assert.equal(replacement.muted, true);
  assert.equal(f.tabs.get(f.session.run.slots[0].tab).active, true);
});

test("U3: First unavailable slot closes and activates the next slot in five-tab mode", async () => {
  const f = fixture(["a", "b", "c", "d", "e", "f"]);
  await f.start(5);
  const tabId = f.session.run.slots[0].tab;
  await f.content("unavailable");
  assert.equal(f.data.decisions.a, "unavailable");
  assert.deepEqual(f.slots, ["b", "c", "d", "e", "f"]);
  assert.ok(f.removed.includes(tabId));
  assert.equal(f.tabs.get(f.session.run.slots[0].tab).active, true);
  assert.equal(f.tabs.get(f.session.run.slots[0].tab).muted, false);
});

test("U4: Unavailable overrides Keep and handles replay progress without resetting its cursor", async () => {
  const f = fixture(undefined, { decisions: { a: "kept", b: "kept", c: "kept", d: "kept" } });
  await f.start(1, "restart");
  await f.decide("later");
  for (let i = 0; i < 3; i++) await f.decide("kept");
  assert.equal(f.current, "a");
  assert.equal(f.data.replayIndex, 4);
  assert.equal((await f.content("unavailable")).done, true);
  assert.equal(f.data.decisions.a, "unavailable");
  assert.deepEqual(Object.keys(f.data).filter(key => key.startsWith("replay")), []);
  const g = fixture(["a", "b"], { decisions: { a: "kept", b: "kept" } });
  await g.start(1, "restart");
  await g.content("unavailable");
  assert.equal(g.current, "b");
  assert.equal(g.data.replayIndex, 1);
  assert.deepEqual(g.data.replayProgress, { total: 2, decided: 1 });
});

test("U5: Wrong tab, sender URL, page URL, and actual tab URL cannot mark an item", async () => {
  const f = fixture();
  await f.start(5);
  const tab = structuredClone(f.tabs.get(f.session.run.slots[0].tab));
  for (const [sender, page] of [
    [{ tab: { ...tab, id: 999 }, url: tab.url }, tab.url],
    [{ tab, url: url("wrong") }, tab.url],
    [{ tab, url: tab.url }, url("wrong")]
  ]) {
    const result = await f.send({ type: "unavailable", page }, sender);
    assert.ok(result.error);
    assert.deepEqual(f.data.decisions, {});
  }
  await f.chrome.tabs.update(tab.id, { url: url("wrong") });
  const result = await f.send({ type: "unavailable", page: tab.url }, { tab, url: tab.url });
  assert.ok(result.error);
  assert.deepEqual(f.data.decisions, {});
  assert.equal(f.session.notice, undefined);
});

test("U6: An already-unsaved item ignores unavailable reports", async () => {
  const f = fixture();
  await f.start();
  Object.defineProperty(f.data.decisions, "a", { value: "unsaved", enumerable: true });
  assert.deepEqual(await f.content("unavailable"), { ignored: true });
  assert.equal(f.data.decisions.a, "unsaved");
  assert.equal(f.current, "a");
  assert.equal(f.session.notice, undefined);
});

test("U7: Unavailable items leave deferral lists and are excluded from every future pass", async () => {
  const f = fixture(["a", "b", "c"]);
  await f.start();
  await f.decide("later");
  await f.decide("kept");
  await f.decide("kept");
  await f.content("unavailable");
  assert.deepEqual(f.data.deferred, []);
  await f.start(1, "restart");
  assert.equal(f.data.replayProgress.total, 2);
  assert.equal(f.current, "b");
  await f.decide("kept");
  assert.equal(f.current, "c");
  await f.decide("kept");
  assert.equal(f.session.run, undefined);
  assert.equal((await f.send({ type: "start", windowId: 1 })).error, "No saved items in this queue.");
});

test("U8: Ten consecutive unavailable reports pause; intervening decisions reset the streak", async () => {
  const f = fixture(manyIds(12));
  await f.start();
  for (let i = 0; i < 9; i++) assert.equal((await f.content("unavailable")).paused, undefined);
  assert.deepEqual(await f.content("unavailable"), { paused: true, message: pauseMessage });
  assert.equal(f.session.run, undefined);
  assert.equal(Object.values(f.data.decisions).filter(value => value === "unavailable").length, 10);
  assert.equal((await f.ok({ type: "summary" })).pauseMessage, pauseMessage);
  await f.start();
  assert.equal(f.session.unavailableStreak, 0);
  assert.equal(f.session.pauseMessage, undefined);
  const g = fixture(manyIds(24));
  await g.start();
  for (let i = 0; i < 9; i++) await g.content("unavailable");
  await g.decide("kept");
  assert.equal(g.session.unavailableStreak, 0);
  for (let i = 0; i < 9; i++) assert.equal((await g.content("unavailable")).paused, undefined);
  assert.equal((await g.content("unavailable")).paused, true);
});

test("U9: Recheck restores ten unavailable items and refuses during review or Undo", async () => {
  const f = fixture(manyIds(12));
  await f.start();
  assert.ok((await f.send({ type: "recheckUnavailable" })).error);
  for (let i = 0; i < 10; i++) await f.content("unavailable");
  assert.deepEqual(await f.ok({ type: "recheckUnavailable" }), {});
  assert.equal((await f.ok({ type: "summary" })).pending, 12);
  assert.deepEqual(f.data.decisions, {});
  await f.start();
  assert.equal(f.current, "item0");
  await f.decide("unsaved");
  await f.ok({ type: "undo", windowId: 1 });
  assert.ok((await f.send({ type: "recheckUnavailable" })).error);
  assert.ok((await f.content("recheckUnavailable")).error);
});

test("U10: Notices accumulate until the current tab acknowledges seeing them", async () => {
  const f = fixture();
  await f.start();
  await f.content("unavailable");
  await f.content("unavailable");
  assert.equal((await f.content("state")).notice, 2);
  assert.deepEqual(await f.content("noticeShown"), { notice: 0 });
  assert.equal(f.session.notice, 0);
  assert.equal((await f.content("state")).notice ?? 0, 0);
});

test("U11: Last unavailable item ends gracefully and keeps a finished-panel notice", async () => {
  for (const size of [1, 5]) {
    const f = fixture(["a"]);
    await f.start(size);
    const tabId = f.session.run.slots[0].tab;
    const result = await f.content("unavailable");
    assert.equal(result.done, true);
    assert.equal(result.notice, 1);
    assert.equal(f.session.run, undefined);
    assert.ok(f.tabs.has(tabId));
    const state = await f.from(tabId, "state");
    assert.equal(state.finished, "complete");
    assert.equal(state.notice, 1);
    assert.equal((await f.from(tabId, "noticeShown")).notice, 0);
  }
});

test("U12: Import preserves matching unavailable decisions and drops removed IDs", async () => {
  const f = fixture(["a", "b", "c"], { decisions: { b: "unavailable", c: "unavailable" } });
  await f.ok({ type: "import", ids: ["a", "b", "d"], types: { a: "reel", b: "p", d: "tv" } });
  assert.deepEqual(f.data.decisions, { b: "unavailable" });
  assert.equal((await f.ok({ type: "summary" })).unavailable, 1);
});

test("U13: Summaries always expose finite unavailable and disjoint pending counts", async () => {
  const f = fixture();
  for (const action of [null, "unavailable", "later", "kept", "unsaved"]) {
    if (action === null) await f.start();
    else if (action === "unavailable") await f.content(action);
    else await f.decide(action);
    const summary = await f.ok({ type: "summary" });
    for (const key of ["total", "pending", "later", "kept", "unsaved", "unavailable"]) assert.ok(Number.isFinite(summary[key]));
    assert.equal(summary.pending + summary.later + summary.kept + summary.unsaved + summary.unavailable, summary.total);
  }
});

test("U14: Unavailable reports never affect a restoring or re-reviewing Undo tab", async () => {
  const f = fixture();
  await f.start(5);
  await f.decide("unsaved");
  await f.ok({ type: "undo", windowId: 1 });
  for (const restoring of [true, false]) {
    if (!restoring) await f.content("restored");
    const data = structuredClone(f.data);
    const undo = structuredClone(f.session.undo);
    assert.deepEqual(await f.content("unavailable"), { ignored: true });
    assert.deepEqual(f.data, data);
    assert.deepEqual(f.session.undo, undo);
    const state = await f.content("state");
    assert.equal(state.detectUnavailable ?? false, false);
  }
});

test("U15: Automatic skip changes only the unavailable decision, with no unsave command or history entry", async () => {
  const history = [{ id: "old", url: url("old"), previous: null }];
  const f = fixture(undefined, { undoHistory: history });
  await f.start(5);
  await f.content("unavailable");
  assert.deepEqual(f.data.decisions, { a: "unavailable" });
  assert.deepEqual(f.data.undoHistory, history);
  assert.ok(f.sent.every(({ message }) => message.type === "refresh"));
});

test("Unavailable waiting replay slots count as handled without jumping past earlier slots", async () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const f = fixture(ids, { decisions: Object.fromEntries(ids.map(id => [id, "kept"])) });
  await f.start(5, "restart");
  await f.from(f.session.run.slots[2].tab, "unavailable");
  assert.equal(f.data.replayIndex, 0);
  assert.equal(f.data.replayProgress.decided, 1);
  for (const id of ["a", "b", "d", "e", "f"]) {
    assert.equal(f.current, id);
    await f.decide("kept");
  }
  assert.equal(f.session.run, undefined);
});

test("A newly shown current item resets the streak; waiting items cannot reset it or clear notices", async () => {
  const f = fixture(manyIds(16));
  await f.start(5);
  for (let i = 0; i < 9; i++) await f.content("unavailable");
  const waitingTab = f.session.run.slots[1].tab;
  await f.from(waitingTab, "available");
  await f.from(waitingTab, "noticeShown");
  assert.equal(f.session.unavailableStreak, 9);
  assert.equal(f.session.notice, 9);
  await f.content("available");
  assert.equal(f.session.unavailableStreak, 0);
  assert.equal((await f.content("unavailable")).paused, undefined);
});

test("Notice acknowledgements preserve skips that arrived after the displayed count", async () => {
  const f = fixture();
  await f.start();
  await f.content("unavailable");
  await f.content("unavailable");
  assert.deepEqual(await f.content("noticeShown", { notice: 1 }), { notice: 1 });
});

test("Prototype-named IDs can be marked unavailable, counted, imported, and rechecked safely", async () => {
  const f = fixture(["__proto__", "constructor", "toString"]);
  await f.start();
  await f.content("unavailable");
  assert.equal(Object.hasOwn(f.data.decisions, "__proto__"), true);
  assert.equal(f.data.decisions.__proto__, "unavailable");
  assert.equal(Object.getPrototypeOf(f.data.decisions), Object.prototype);
  await f.ok({ type: "pause" });
  await f.ok({ type: "import", ids: ["__proto__", "constructor"],
    types: Object.fromEntries([["__proto__", "reel"], ["constructor", "p"]]) });
  assert.equal((await f.ok({ type: "summary" })).unavailable, 1);
  assert.deepEqual(await f.ok({ type: "recheckUnavailable" }), {});
  assert.equal(Object.hasOwn(f.data.decisions, "__proto__"), false);
});

test("One-tab unavailable handoff preserves its slot if navigation fails and Return to review retries it", async () => {
  const behavior = { failNextNavigation: true };
  const f = fixture(["a", "b", "c"], {}, {}, behavior);
  await f.start();
  const first = structuredClone(f.session.run.slots[0]);
  assert.match((await f.content("unavailable")).error, /Simulated navigation failure/);
  assert.deepEqual(f.session.run.slots, [first]);
  assert.equal(f.tabs.get(first.tab).url, url("a"));
  assert.equal(f.data.decisions.a, "unavailable");
  assert.equal(f.session.notice, 1);
  assert.match((await f.ok({ type: "summary" })).reviewError, /Simulated navigation failure/);
  await f.start();
  assert.equal(f.current, "b");
  assert.equal(f.session.run.slots[0].tab, first.tab);
  assert.equal(f.tabs.get(first.tab).url, url("b"));
  assert.equal(f.session.notice, 1);
  assert.equal(f.session.unavailableStreak, 1);
  assert.equal((await f.ok({ type: "summary" })).reviewError, undefined);
});

test("Return to review refills an empty run left by an interrupted unavailable handoff", async () => {
  const f = fixture(["a", "b", "c"], { decisions: { a: "unavailable" } }, {
    run: { size: 1, windowId: 1, slots: [] }, notice: 1
  });
  await f.start();
  assert.equal(f.current, "b");
  assert.equal((await f.ok({ type: "summary" })).running, true);
  assert.equal(f.session.notice, 1);
});

test("Retrying an unavailable handoff does not double-count a re-review pass", async () => {
  const f = fixture(["a", "b", "c"], { decisions: { a: "kept", b: "kept", c: "kept" } }, {},
    { failNextNavigation: true });
  await f.start(1, "restart");
  assert.ok((await f.content("unavailable")).error);
  assert.equal(f.data.replayIndex, 1);
  assert.equal(f.data.replayProgress.decided, 1);
  const state = await f.content("state");
  assert.equal(state.current, false);
  assert.equal(state.detectUnavailable, false);
  assert.match(state.reviewError, /Simulated navigation failure/);
  await f.start();
  assert.equal(f.current, "b");
  assert.equal(f.data.replayIndex, 1);
  assert.equal(f.data.replayProgress.decided, 1);
  assert.equal(f.session.notice, 1);
  await f.decide("kept");
  assert.equal(f.data.replayProgress.decided, 2);
  await f.decide("kept");
  assert.equal(f.session.run, undefined);
});

const redirectedProfile = "https://www.instagram.com/wholelottawindy/";

test("A queued permalink redirected to an error profile remains authorized for unavailable detection", async () => {
  const f = fixture(["DfpXM1MFt4P", "next"], { types: { DfpXM1MFt4P: "p", next: "reel" } });
  await f.start();
  const tabId = f.session.run.slots[0].tab;
  await f.redirect(tabId, redirectedProfile);
  const state = await f.content("state");
  assert.equal(state.current, false);
  assert.equal(state.detectUnavailable, true);
  assert.equal(Object.hasOwn(state, "redirected"), false);
  const response = await f.content("unavailable");
  assert.equal(response.error, undefined);
  assert.equal(response.done, false);
  assert.equal(f.data.decisions.DfpXM1MFt4P, "unavailable");
  assert.equal(f.current, "next");
  assert.equal(f.tabs.get(tabId).url, url("next"));
  assert.equal(f.session.notice, 1);
});

test("A redirected inactive waiting slot closes and refills without pausing the five-tab run", async () => {
  const f = fixture(["a", "b", "c", "d", "e", "f"]);
  await f.start(5);
  const tabId = f.session.run.slots[2].tab;
  await f.redirect(tabId, redirectedProfile);
  assert.equal((await f.from(tabId, "state")).detectUnavailable, true);
  const response = await f.from(tabId, "unavailable");
  assert.equal(response.error, undefined);
  assert.deepEqual(f.slots, ["a", "b", "d", "e", "f"]);
  assert.ok(f.removed.includes(tabId));
  assert.equal((await f.ok({ type: "summary" })).running, true);
});

test("A normally loaded saved item can be browsed to a broken profile without marking the item unavailable", async () => {
  for (const message of ["pageAvailable", "browse", "available"]) {
    const f = fixture(["a", "b"]);
    await f.start();
    await f.content(message);
    const tabId = f.session.run.slots[0].tab;
    await f.redirect(tabId, redirectedProfile);
    const state = await f.content("state");
    assert.equal(state.detectUnavailable, false);
    assert.ok((await f.content("unavailable")).error);
    assert.deepEqual(f.data.decisions, {});
    assert.equal(f.current, "a");
  }
});

test("Redirect authorization requires both reported URLs and the current browser URL to match exactly", async () => {
  const f = fixture(["a", "b"]);
  await f.start();
  const tabId = f.session.run.slots[0].tab;
  await f.redirect(tabId, redirectedProfile);
  const tab = structuredClone(f.tabs.get(tabId));
  for (const [senderUrl, page] of [[redirectedProfile, url("wrong")], [url("wrong"), redirectedProfile]]) {
    assert.ok((await f.send({ type: "unavailable", page }, { tab, url: senderUrl })).error);
  }
  f.tabs.get(tabId).url = "https://www.instagram.com/other_profile/";
  assert.ok((await f.send({ type: "unavailable", page: redirectedProfile }, { tab, url: redirectedProfile })).error);
  assert.deepEqual(f.data.decisions, {});
});

test("Login, challenge, external, and second profile detours do not authorize automatic decisions", async () => {
  for (const destination of [
    "https://www.instagram.com/accounts/login/", "https://www.instagram.com/challenge/",
    "https://www.instagram.com/direct/", "https://example.com/wholelottawindy/"
  ]) {
    const f = fixture(["a", "b"]);
    await f.start();
    await f.redirect(f.session.run.slots[0].tab, destination);
    assert.equal((await f.content("state")).detectUnavailable, false);
    assert.ok((await f.content("unavailable")).error);
    assert.deepEqual(f.data.decisions, {});
  }
  const f = fixture(["a", "b"]);
  await f.start();
  const tabId = f.session.run.slots[0].tab;
  await f.redirect(tabId, redirectedProfile);
  await f.redirect(tabId, "https://www.instagram.com/another_profile/");
  assert.equal((await f.content("state")).detectUnavailable, false);
  assert.deepEqual(f.data.decisions, {});
});

test("A legacy run with no navigation provenance is re-armed only by Return to review", async () => {
  const f = fixture(["a", "b"]);
  await f.start();
  const tabId = f.session.run.slots[0].tab;
  delete f.session.run.slots[0].navigation;
  await f.redirect(tabId, redirectedProfile);
  assert.equal((await f.content("state")).detectUnavailable, false);
  await f.start();
  assert.equal(f.tabs.get(tabId).url, url("a"));
  await f.redirect(tabId, redirectedProfile);
  assert.equal((await f.content("state")).detectUnavailable, true);
});

test("The final redirected unavailable item supports the finished panel and notice acknowledgement", async () => {
  for (const size of [1, 5]) {
    const f = fixture(["a"]);
    await f.start(size);
    const tabId = f.session.run.slots[0].tab;
    await f.redirect(tabId, redirectedProfile);
    assert.equal((await f.content("unavailable")).done, true);
    assert.equal(f.session.run, undefined);
    const state = await f.from(tabId, "state");
    assert.equal(state.finished, "complete");
    assert.equal(state.notice, 1);
    assert.equal((await f.from(tabId, "noticeShown")).notice, 0);
  }
});

test("A current redirected unavailable slot advances a five-tab queue and closes only its own tab", async () => {
  const f = fixture(["a", "b", "c", "d", "e", "f"]);
  await f.start(5);
  const tabId = f.session.run.slots[0].tab;
  await f.redirect(tabId, redirectedProfile);
  await f.content("unavailable");
  assert.deepEqual(f.slots, ["b", "c", "d", "e", "f"]);
  assert.ok(f.removed.includes(tabId));
  assert.equal(f.tabs.get(f.session.run.slots[0].tab).active, true);
  assert.equal(f.session.notice, 1);
});

test("A redirected re-review item counts as handled once and leaves Undo history unchanged", async () => {
  const history = [{ id: "old", url: url("old"), previous: null }];
  const f = fixture(["a", "b"], { decisions: { a: "kept", b: "kept" }, undoHistory: history });
  await f.start(1, "restart");
  await f.redirect(f.session.run.slots[0].tab, redirectedProfile);
  await f.content("unavailable");
  assert.equal(f.data.decisions.a, "unavailable");
  assert.equal(f.data.replayIndex, 1);
  assert.equal(f.data.replayProgress.decided, 1);
  assert.deepEqual(f.data.undoHistory, history);
  assert.equal(f.current, "b");
});

test("Redirected Undo tabs remain ignored and cannot authorize an unavailable decision", async () => {
  const f = fixture();
  await f.start();
  await f.decide("unsaved");
  await f.ok({ type: "undo", windowId: 1 });
  const before = structuredClone(f.data);
  await f.redirect(f.session.undo.tab, redirectedProfile);
  assert.deepEqual(await f.content("unavailable"), { ignored: true });
  assert.deepEqual(f.data, before);
});

test("Hidden preload readiness disables redirect inference without resetting the unavailable streak", async () => {
  const f = fixture();
  await f.start(5);
  f.session.unavailableStreak = 4;
  const tabId = f.session.run.slots[2].tab;
  await f.from(tabId, "pageAvailable");
  assert.equal(f.session.unavailableStreak, 4);
  await f.redirect(tabId, redirectedProfile);
  assert.equal((await f.from(tabId, "state")).detectUnavailable, false);
});

test("A redirected one-tab navigation failure stays visible and retries without double-counting", async () => {
  const f = fixture(["a", "b"], {}, {}, { failNextNavigation: true });
  await f.start();
  await f.redirect(f.session.run.slots[0].tab, redirectedProfile);
  assert.ok((await f.content("unavailable")).error);
  const state = await f.content("state");
  assert.match(state.reviewError, /Simulated navigation failure/);
  assert.equal(state.detectUnavailable, false);
  await f.start();
  assert.equal(f.current, "b");
  assert.equal(f.session.notice, 1);
  assert.equal(f.session.unavailableStreak, 1);
});

test("Ten redirected unavailable items still trigger the existing circuit-breaker", async () => {
  const f = fixture(manyIds(12));
  await f.start();
  for (let i = 0; i < 10; i++) {
    await f.redirect(f.session.run.slots[0].tab, redirectedProfile);
    const result = await f.content("unavailable");
    assert.equal(result.paused ?? false, i === 9);
  }
  assert.equal(f.session.run, undefined);
  assert.equal((await f.ok({ type: "summary" })).unavailable, 10);
});
