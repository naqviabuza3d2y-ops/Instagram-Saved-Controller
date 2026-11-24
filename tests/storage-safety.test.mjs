import assert from "node:assert/strict";
import test from "node:test";
import { extensionId, fixture, popupUrl } from "./helpers/receive-harness.mjs";

export const unsupportedMessage = "Saved data is from an unsupported version. Re-import your export to continue.";
const valid = () => ({ schema: 1, ids: ["a"], types: { a: "p" }, decisions: {}, deferred: [], undoHistory: [] });
export const invalidDataCases = [
  ["missing schema", { ids: ["a"], decisions: {}, deferred: [] }],
  ["future schema", { ...valid(), schema: 2 }],
  ["old schema", { ...valid(), schema: 0 }],
  ["null", null],
  ["array", []],
  ["primitive", "corrupt"],
  ["missing IDs", { ...valid(), ids: undefined }],
  ["invalid IDs", { ...valid(), ids: ["bad.id"] }],
  ["duplicate IDs", { ...valid(), ids: ["a", "a"] }],
  ["invalid decisions", { ...valid(), decisions: [] }],
  ["invalid decision value", { ...valid(), decisions: { a: "skipped" } }],
  ["missing deferred list", { ...valid(), deferred: undefined }],
  ["invalid deferred IDs", { ...valid(), deferred: [null] }],
  ["invalid types", { ...valid(), types: { a: "unsupported" } }],
  ["invalid history", { ...valid(), undoHistory: {} }],
  ["old Undo previous value", { ...valid(), undoHistory: [{ id: "a", url: "https://www.instagram.com/p/a/", previous: "skipped" }] }],
  ["mismatched Undo URL", { ...valid(), undoHistory: [{ id: "a", url: "https://www.instagram.com/p/b/", previous: null }] }],
  ["cursor without counters", { ...valid(), replayIndex: 0 }],
  ["missing replay counters", { ...valid(), replayIndex: 0, replayId: "pass", replayDeferred: [] }],
  ["invalid replay counter", { ...valid(), replayIndex: 0, replayId: "pass", replayDeferred: [],
    replayProgress: { decided: -1, total: 1 } }],
  ["invalid replay list", { ...valid(), replayIndex: 0, replayId: "pass", replayDeferred: null,
    replayProgress: { decided: 0, total: 1 } }],
  ["invalid replay cursor", { ...valid(), replayIndex: 2, replayId: "pass", replayDeferred: [],
    replayProgress: { decided: 0, total: 1 } }]
];
export const mutations = effects => effects.filter(effect => /^(local|session)\.(set|remove)$|^(tabs|windows)\./.test(effect.op));

for (const [name, data] of invalidDataCases) {
  test("Unsupported storage: " + name + " is rejected without writes or tab operations", async () => {
    const messages = [
      ["summary", false], ["start", false], ["restart", false], ["pause", false],
      ["undo", false], ["recheckUnavailable", false],
      ["state", true], ["audio", true], ["decision", true], ["pageAvailable", true],
      ["browse", true], ["available", true], ["noticeShown", true], ["restored", true], ["unavailable", true]
    ];
    for (const [type, content] of messages) {
      const f = fixture();
      f.local.data = structuredClone(data);
      const before = f.snapshot();
      const result = await (content ? f.content(type, { decision: "kept" }) : f.popup(type));
      await f.drain();
      assert.deepEqual(result, { error: unsupportedMessage }, type);
      assert.deepEqual(mutations(f.effects), [], type);
      assert.deepEqual(f.snapshot(), before, type);
    }
  });
}

test("Fresh installs have an empty in-memory schema 1 state and can import without initialization writes", async () => {
  const f = fixture();
  delete f.local.data;
  for (const key of Object.keys(f.session)) delete f.session[key];
  const summary = await f.popup("summary");
  assert.deepEqual([summary.total, summary.pending, summary.later, summary.kept, summary.unsaved, summary.unavailable],
    [0, 0, 0, 0, 0, 0]);
  assert.equal(Object.hasOwn(f.local, "data"), false);
  assert.deepEqual(mutations(f.effects), []);
  assert.deepEqual(await f.popup("import", { ids: ["a"], types: { a: "p" } }), {});
  assert.deepEqual(f.local.data, valid());
});

test("Unsupported storage is replaced only by an explicit, valid popup import", async () => {
  for (const [, data] of invalidDataCases) {
    const f = fixture();
    f.local.data = structuredClone(data);
    delete f.session.run;
    const before = f.snapshot();
    assert.ok((await f.popup("import", { ids: ["bad.id"], types: {} })).error);
    assert.deepEqual(mutations(f.effects), []);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(await f.popup("import", { ids: ["a"], types: { a: "p" } }), {});
    assert.deepEqual(f.local.data, valid());
    assert.deepEqual(mutations(f.effects).map(effect => effect.op), ["local.set", "session.remove"]);
    assert.deepEqual(f.session, before.session);
  }
});

function staleReview(f) {
  // Keep the active run from fixture(); recovery must not depend on an idle setup.
  f.session.run.size = 5;
  f.session.run.slots.push({ id: "b", tab: 2, navigation: { url: "https://www.instagram.com/reel/b/" } });
  f.session.undo = { id: "c", tab: 3, url: "https://www.instagram.com/tv/c/", previous: "kept" };
  f.session.undoContext = { id: "a", tab: 1, kind: "complete" };
}

const recoveryCases = invalidDataCases.filter(([name]) =>
  ["missing schema", "future schema", "invalid decisions"].includes(name));
for (const [name, data] of recoveryCases) {
  test("Recovery import replaces " + name + " with an active run, Undo, and completion context", async () => {
    const f = fixture();
    f.local.data = structuredClone(data);
    staleReview(f);
    const before = f.snapshot();
    assert.ok(before.session.run.slots.length > 0);
    assert.deepEqual(await f.popup("import", { ids: ["a"], types: { a: "p" } }), {});
    assert.deepEqual(f.local.data, valid());
    const { run, undo, undoContext, ...unrelated } = before.session;
    assert.deepEqual(f.session, unrelated);
    assert.deepEqual(f.snapshot().tabs, before.tabs, "Release stale ownership without operating on tabs");
    assert.deepEqual(mutations(f.effects), [
      { op: "local.set", args: [{ data: valid() }] },
      { op: "session.remove", args: [["run", "undo", "undoContext"]] }
    ]);
    const summary = await f.popup("summary");
    assert.equal(summary.running, false);
    assert.equal(summary.total, 1);
    assert.deepEqual(await f.content("state"), inactive);
  });
}

test("Invalid recovery imports preserve unsupported data and all stale session state", async () => {
  for (const [, data] of recoveryCases) {
    for (const input of [
      { ids: [], types: {} }, { ids: ["bad.id"], types: {} },
      { ids: ["a"], types: {} }, { ids: ["a"], types: { a: "unsupported" } }
    ]) {
      const f = fixture();
      f.local.data = structuredClone(data);
      staleReview(f);
      const before = f.snapshot();
      assert.ok((await f.popup("import", input)).error);
      assert.deepEqual(mutations(f.effects), []);
      assert.deepEqual(f.snapshot(), before);
    }
  }
});

test("Non-import messages cannot replace unsupported data or release a stale review", async () => {
  for (const [, data] of recoveryCases) {
    const f = fixture();
    f.local.data = structuredClone(data);
    staleReview(f);
    const before = f.snapshot();
    for (const type of ["summary", "pause", "start", "restart", "undo", "recheckUnavailable"]) {
      assert.deepEqual(await f.popup(type), { error: unsupportedMessage });
    }
    for (const type of ["state", "decision", "restored", "unavailable", "import"]) {
      assert.deepEqual(await f.content(type, { decision: "kept", ids: ["a"], types: { a: "p" } }),
        { error: unsupportedMessage });
    }
    assert.deepEqual(mutations(f.effects), []);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("Supported imports still require pausing and leave active run, Undo, and context untouched", async () => {
  const f = fixture();
  staleReview(f);
  const before = f.snapshot();
  assert.deepEqual(await f.popup("import", { ids: ["a"], types: { a: "p" } }),
    { error: "Pause the current review before importing." });
  assert.deepEqual(mutations(f.effects), []);
  assert.deepEqual(f.snapshot(), before);
});

// Every command shares the same trust/ownership boundary, including popup-only
// commands and unknown or invalid content messages.
const authorizationMessages = [
  ...["state", "audio", "pageAvailable", "browse", "available", "noticeShown", "undo",
    "restored", "unavailable", "recheckUnavailable", "summary", "import", "start",
    "restart", "pause", "unknown"].map(type => ({ type })),
  ...["kept", "unsaved", "later", "skipped"].map(decision => ({ type: "decision", decision }))
].map(message => ({ page: "https://www.instagram.com/p/a/", muted: true, notice: 1,
  ids: ["a"], types: { a: "p" }, size: 5, windowId: 1, ...message }));

const authorizationDataCases = [
  ["schema 1", valid()],
  ["schema 1 replay", { ...valid(), replayIndex: 0, replayId: "existing-pass",
    replayDeferred: ["a"], replayReviewed: [], replayProgress: { decided: 0, total: 1 } }],
  ["empty schema 1", { ...valid(), ids: [], types: {} }],
  ["fresh install", undefined],
  ...invalidDataCases
];
const inactive = { current: false, canUndo: false, finished: null, detectUnavailable: false };
function rejectedResponse(type) {
  if (type === "unavailable") return { error: "Return to a queued review item and try again." };
  if (type === "recheckUnavailable") return { error: "Recheck unavailable items from the extension popup." };
  if (type === "undo") return { error: "Undo is unavailable in this tab." };
  if (["pageAvailable", "browse", "noticeShown"].includes(type)) return { ignored: true };
  return inactive;
}
function setStoredData(f, data) {
  if (data === undefined) delete f.local.data;
  else f.local.data = structuredClone(data);
}

for (const [name, data] of authorizationDataCases) {
  test("Tier 1: " + name + " rejects untrusted senders before all storage access", async () => {
    const content = { id: extensionId, tab: { id: 1, active: true },
      url: "https://www.instagram.com/p/a/" };
    const senders = [
      { ...content, id: undefined }, { ...content, id: "foreign-extension" },
      ...[undefined, "invalid URL", "https://example.com/p/a/", "http://www.instagram.com/p/a/",
        "https://instagram.com/p/a/", "https://www.instagram.com.evil.test/p/a/",
        "https://sub.www.instagram.com/p/a/"].map(url => ({ ...content, url })),
      { id: "foreign-extension", url: popupUrl },
      { url: popupUrl },
      { id: extensionId, url: "chrome-extension://" + extensionId + "/other.html" },
      { id: extensionId, url: "https://www.instagram.com/p/a/" }
    ];
    for (const sender of senders) {
      const f = fixture();
      setStoredData(f, data);
      // Even an owned tab with stale session fields must not be read or scrubbed.
      Object.assign(f.session.run, { retry: true, reviewed: ["b"] });
      const before = f.snapshot();
      for (const message of authorizationMessages) {
        f.effects.length = 0;
        assert.deepEqual(await f.request(message, sender), rejectedResponse(message.type), message.type);
        await f.drain();
        assert.deepEqual(f.effects.map(effect => effect.op), ["response"], message.type);
        assert.deepEqual(f.snapshot(), before, message.type);
      }
    }
  });

  test("Tier 2: " + name + " rejects unrelated trusted tabs using session reads only", async () => {
    for (const mode of ["run", "Undo", "completed", "empty run", "idle", "all"]) {
      const f = fixture();
      setStoredData(f, data);
      const slot = { id: "a", tab: 1, url: "https://www.instagram.com/p/a/", previous: null };
      if (mode !== "run" && mode !== "all" && mode !== "empty run") delete f.session.run;
      if (mode === "empty run") f.session.run.slots = [];
      if (mode === "Undo" || mode === "all") f.session.undo = { ...slot, reviewing: false };
      if (mode === "completed" || mode === "all") f.session.undoContext = { ...slot, kind: "complete" };
      const before = f.snapshot();
      for (const message of authorizationMessages) {
        f.effects.length = 0;
        assert.deepEqual(await f.unauthorized(message.type, message), rejectedResponse(message.type), mode + "/" + message.type);
        await f.drain();
        assert.deepEqual(f.effects.filter(effect => effect.op !== "response"), [
          { op: "session.get", args: ["run"] },
          { op: "session.get", args: ["undo"] },
          { op: "session.get", args: ["undoContext"] }
        ], mode + "/" + message.type);
        assert.deepEqual(f.snapshot(), before, mode + "/" + message.type);
      }
    }
  });
}

test("Tier 2 uses the existing run, Undo, and completion identities without replacing URL authorization", async () => {
  for (const owner of ["first", "waiting", "Undo", "completed", "redirect"]) {
    const f = fixture();
    if (owner === "waiting") f.session.run.slots.unshift({ id: "b", tab: 2 });
    if (owner === "Undo") {
      delete f.session.run;
      f.local.data.decisions.a = "unsaved";
      f.session.undo = { id: "a", tab: 1, url: f.tabs.get(1).url, previous: null };
    }
    if (owner === "completed") {
      delete f.session.run;
      f.session.undoContext = { id: "a", tab: 1, kind: "complete" };
    }
    if (owner === "redirect") {
      const profile = "https://www.instagram.com/creator/";
      f.session.run.slots[0].navigation.redirect = profile;
      f.tabs.get(1).url = profile;
    }
    const response = await f.content("state");
    assert.equal(response.error, undefined, owner);
    assert.equal(f.effects.some(effect => effect.op === "local.get"), true, owner);
    if (owner === "first") assert.equal(response.current, true);
    if (owner === "waiting" || owner === "redirect") assert.equal(response.detectUnavailable, true);
    if (owner === "Undo") assert.deepEqual(response, { restoring: true });
    if (owner === "completed") assert.equal(response.finished, "complete");
  }
});
