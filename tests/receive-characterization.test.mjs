import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { mediaId } from "../export.mjs";
import { characterize, extensionId, popupUrl, scenarios } from "./helpers/receive-harness.mjs";

// Captured from the original receive(), before any handler extraction. Never regenerate
// these expectations to accommodate a refactor failure: the behavior must remain fixed.
const expected = JSON.parse(await readFile(new URL("./fixtures/receive-characterization.json", import.meta.url), "utf8"));
// Phase 6 deliberately moves authorization reads ahead of local data access.
// Preserve frozen responses, ordered writes/tab operations, other reads, and final
// state; storage-safety tests assert the new authorization-read boundary exactly.
const withoutAuthorizationReads = trace => ({ ...trace, effects: trace.effects.filter(effect =>
  !(effect.op === "local.get" && effect.args[0] === "data") &&
  !(effect.op === "session.get" && ["run", "undo", "undoContext"].includes(effect.args[0]))) });
for (const scenario of scenarios) {
  test(`Characterization: ${scenario.name}`, async () => {
    const actual = await characterize(scenario);
    assert.deepEqual(withoutAuthorizationReads(actual), withoutAuthorizationReads(expected[scenario.name]));
    if (scenario.unauthorized) {
      assert.deepEqual(actual.effects.filter(effect => /^(local|session)\.(set|remove)$|^(tabs|windows)\./.test(effect.op)), []);
      assert.deepEqual(actual.state, actual.before);
    }
  });
}

const source = (await readFile(new URL("../background.js", import.meta.url), "utf8"))
  .replace('import { mediaId } from "./export.mjs";', "");
const page = "https://www.instagram.com/reel/a/";

function rejectionFixture(data) {
  const local = { data: structuredClone(data) };
  const session = { run: { size: 1, windowId: 1,
    slots: [{ tab: 1, id: "a", navigation: { url: page } }] } };
  const effects = [];
  const reads = [];
  let listener;
  const area = (name, state) => ({
    async get(key) { reads.push({ type: name + ".get", key }); return structuredClone({ [key]: state[key] }); },
    async set(values) {
      effects.push({ type: `${name}.set`, values: structuredClone(values) });
      Object.assign(state, structuredClone(values));
    },
    async remove(keys) {
      effects.push({ type: `${name}.remove`, keys: structuredClone(keys) });
      for (const key of [keys].flat()) delete state[key];
    }
  });
  const unexpectedOperation = name => async (...args) => {
    effects.push({ type: name, args: structuredClone(args) });
    throw new Error(`Unauthorized message invoked ${name}`);
  };
  runInNewContext(source, {
    mediaId, URL,
    chrome: {
      storage: { local: area("local", local), session: area("session", session) },
      runtime: { id: extensionId, getURL: path => popupUrl.replace("popup.html", path),
        onMessage: { addListener(callback) { listener = callback; } } },
      tabs: {
        ...Object.fromEntries(["get", "create", "update", "remove", "query", "sendMessage"]
          .map(name => [name, unexpectedOperation(`tabs.${name}`)])),
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} }
      },
      windows: { update: unexpectedOperation("windows.update") }
    }
  });
  return {
    effects, reads,
    snapshot: () => structuredClone({ local, session }),
    sendUnauthorizedDecision: () => new Promise(resolve => {
      assert.equal(listener({ type: "decision", decision: "unsaved", page },
        { id: extensionId, tab: { id: 999, active: true, url: page }, url: page },
        response => resolve(structuredClone(response))), true);
    })
  };
}

test("Tier 2 unrelated sender has no effects on current-schema storage", async () => {
  const f = rejectionFixture({ schema: 1, ids: ["a", "b"], decisions: {}, deferred: [] });
  const before = f.snapshot();
  assert.deepEqual(await f.sendUnauthorizedDecision(), {
    current: false, canUndo: false, finished: null, detectUnavailable: false
  });
  assert.deepEqual(f.reads, [
    { type: "session.get", key: "run" },
    { type: "session.get", key: "undo" },
    { type: "session.get", key: "undoContext" }
  ]);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.snapshot(), before);
});

