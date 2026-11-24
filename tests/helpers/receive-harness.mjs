import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { mediaId } from "../../export.mjs";

export const extensionId = "a".repeat(32);
export const popupUrl = "chrome-extension://" + extensionId + "/popup.html";

const source = (await readFile(new URL("../../background.js", import.meta.url), "utf8"))
  .replace('import { mediaId } from "./export.mjs";', "");
const url = id => `https://www.instagram.com/${id === "a" ? "p" : id === "c" ? "tv" : "reel"}/${id}/`;
const slot = (id, tab) => ({ id, tab, navigation: { url: url(id) } });

export function fixture() {
  const local = { data: { schema: 1, ids: ["a", "b", "c"], types: { a: "p", b: "reel", c: "tv" },
    decisions: {}, deferred: [], undoHistory: [] } };
  const session = { run: { size: 1, windowId: 1, slots: [slot("a", 1)] },
    notice: 2, unavailableStreak: 3, pauseMessage: "Previous pause" };
  const tabs = new Map(["a", "b", "c"].map((id, index) => [index + 1,
    { id: index + 1, windowId: 1, active: index === 0, pinned: false, muted: index !== 0, url: url(id) }]));
  const effects = [];
  let listener, removedListener, updatedListener;
  let nextTab = 4;
  const record = (op, ...args) => effects.push({ op, args: structuredClone(args) });
  const area = (name, state) => ({
    async get(key) { record(`${name}.get`, key); return structuredClone({ [key]: state[key] }); },
    async set(values) { record(`${name}.set`, values); Object.assign(state, structuredClone(values)); },
    async remove(keys) {
      record(`${name}.remove`, keys);
      for (const key of [keys].flat()) delete state[key];
    }
  });
  const activate = tab => {
    for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = other.id === tab.id;
  };
  const chrome = {
    storage: { local: area("local", local), session: area("session", session) },
    runtime: { id: extensionId, getURL: path => "chrome-extension://" + extensionId + "/" + path,
      onMessage: { addListener(callback) { listener = callback; } } },
    tabs: {
      async get(id) {
        record("tabs.get", id);
        assert.ok(tabs.has(id));
        return structuredClone(tabs.get(id));
      },
      async create(properties) {
        record("tabs.create", properties);
        const tab = { id: nextTab++, windowId: 1, active: true, pinned: false, muted: false, ...properties };
        tabs.set(tab.id, tab);
        if (tab.active) activate(tab);
        return structuredClone(tab);
      },
      async update(id, properties) {
        record("tabs.update", id, properties);
        assert.ok(tabs.has(id));
        Object.assign(tabs.get(id), structuredClone(properties));
        if (properties.active) activate(tabs.get(id));
        return structuredClone(tabs.get(id));
      },
      async remove(id) {
        record("tabs.remove", id);
        assert.ok(tabs.delete(id));
        removedListener(id, { windowId: 1, isWindowClosing: false });
      },
      async query(properties) {
        record("tabs.query", properties);
        return structuredClone([...tabs.values()].filter(tab =>
          Object.entries(properties).every(([key, value]) => tab[key] === value)));
      },
      async sendMessage(id, message) {
        record("tabs.sendMessage", id, message);
        assert.ok(tabs.has(id));
        return {};
      },
      onRemoved: { addListener(callback) { removedListener = callback; } },
      onUpdated: { addListener(callback) { updatedListener = callback; } }
    },
    windows: { async update(id, properties) { record("windows.update", id, properties); return { id, ...properties }; } }
  };
  // A deterministic UUID makes the pre-refactor replay trace reproducible.
  const drain = runInNewContext(`${source}\n(() => serial(async () => {}));`, {
    chrome, mediaId, URL, crypto: { randomUUID: () => "characterization-pass" }, console
  });
  const send = (message, sender = { id: extensionId, url: popupUrl }) => new Promise(resolve => {
    assert.equal(listener(message, sender, response => {
      record("response", response);
      resolve(structuredClone(response));
    }), true);
  });
  return {
    local, session, tabs, effects, drain, request: send,
    snapshot: () => structuredClone({ local, session, tabs: [...tabs.values()] }),
    popup: (type, extra = {}) => send({ type, ...extra }),
    content(type, extra = {}, tabId = 1) {
      const tab = structuredClone(tabs.get(tabId));
      return send({ type, page: tab.url, ...extra }, { id: extensionId, frameId: 0, tab, url: tab.url });
    },
    unauthorized: (type, extra = {}) => send({ type, page: url("a"), ...extra },
      { id: extensionId, frameId: 0, tab: { id: 999, active: true, url: url("a") }, url: url("a") })
  };
}

function idle(f) { delete f.session.run; }
function history(f) {
  f.local.data.undoHistory = [{ id: "b", url: url("b"), previous: null }];
  f.local.data.decisions.b = "unsaved";
}
function replay(f) {
  Object.assign(f.local.data, { replayIndex: 0, replayId: "existing-pass", replayDeferred: [],
    replayProgress: { decided: 0, total: 3 } });
}
function five(f) { f.session.run.size = 5; f.session.run.slots = [slot("a", 1), slot("b", 2), slot("c", 3)]; }
function undo(f, reviewing = false) {
  f.session.run.slots = [slot("b", 1)];
  const entry = { id: "a", url: url("a"), previous: "kept" };
  f.local.data.decisions.a = reviewing ? "kept" : "unsaved";
  f.local.data.undoHistory = reviewing ? [] : [entry];
  f.session.undo = { ...entry, tab: 1, returnUrl: url("b"), reviewing, muted: false };
}

export const scenarios = [
  { name: "content/state", exercise: f => f.content("state") },
  { name: "content/state with review error", prepare: f => { f.session.run.reviewError = "Handoff failed"; }, exercise: f => f.content("state") },
  { name: "content/state on waiting tab", prepare: five, exercise: f => f.content("state", {}, 2) },
  { name: "content/state after returning from Undo", prepare(f) { undo(f); f.tabs.get(1).url = url("b"); }, exercise: f => f.content("state") },
  { name: "content/audio", exercise: f => f.content("audio", { muted: true }) },
  { name: "content/audio during reopened Undo", prepare: f => undo(f, true), exercise: f => f.content("audio", { muted: true }) },
  { name: "content/audio inactive rejection", prepare: f => { f.tabs.get(1).active = false; }, exercise: f => f.content("audio", { muted: true }) },
  { name: "content/pageAvailable", exercise: f => f.content("pageAvailable") },
  { name: "content/pageAvailable waiting", prepare: five, exercise: f => f.content("pageAvailable", {}, 2) },
  { name: "content/pageAvailable during Undo", prepare: f => undo(f), exercise: f => f.content("pageAvailable") },
  { name: "content/browse", exercise: f => f.content("browse") },
  { name: "content/available", exercise: f => f.content("available") },
  { name: "content/available waiting ignored", prepare: five, exercise: f => f.content("available", {}, 2) },
  { name: "content/noticeShown", exercise: f => f.content("noticeShown", { notice: 1 }) },
  { name: "content/noticeShown waiting ignored", prepare: five, exercise: f => f.content("noticeShown", {}, 2) },
  { name: "content/noticeShown finished", prepare(f) { idle(f); history(f); f.session.undoContext = { kind: "complete", id: "a", tab: 1 }; }, exercise: f => f.content("noticeShown", { notice: 1 }) },
  { name: "content/undo", prepare: history, exercise: f => f.content("undo") },
  { name: "content/undo inactive rejection", prepare(f) { history(f); f.tabs.get(1).active = false; }, exercise: f => f.content("undo") },
  { name: "content/state restoring", prepare: f => undo(f), exercise: f => f.content("state") },
  { name: "content/restored", prepare: f => undo(f), exercise: f => f.content("restored") },
  { name: "content/restored history rejection", prepare(f) { undo(f); f.local.data.undoHistory = []; }, exercise: f => f.content("restored") },
  { name: "content/unknown during restoration", prepare: f => undo(f), exercise: f => f.content("unknown") },
  { name: "content/unavailable", exercise: f => f.content("unavailable") },
  { name: "content/unavailable waiting", prepare: five, exercise: f => f.content("unavailable", {}, 2) },
  { name: "content/unavailable circuit breaker", prepare(f) { five(f); f.session.unavailableStreak = 9; }, exercise: f => f.content("unavailable") },
  { name: "content/unavailable during Undo", prepare: f => undo(f), exercise: f => f.content("unavailable") },
  { name: "content/unavailable final item", prepare: f => { f.local.data.ids = ["a"]; }, exercise: f => f.content("unavailable") },
  { name: "content/recheckUnavailable rejection", exercise: f => f.content("recheckUnavailable") },
  { name: "content/invalid decision", exercise: f => f.content("decision", { decision: "skipped" }) },
  { name: "content/unknown", exercise: f => f.content("unknown") },
  { name: "popup/summary", exercise: f => f.popup("summary") },
  { name: "popup/summary idle", prepare: idle, exercise: f => f.popup("summary") },
  { name: "popup/recheckUnavailable", prepare(f) { idle(f); f.local.data.decisions.b = "unavailable"; }, exercise: f => f.popup("recheckUnavailable") },
  { name: "popup/recheckUnavailable running rejection", exercise: f => f.popup("recheckUnavailable") },
  { name: "popup/import", prepare(f) { idle(f); history(f); f.local.data.deferred = ["c"]; },
    exercise: f => f.popup("import", { ids: ["c", "b"], types: { c: "tv", b: "reel" } }) },
  { name: "popup/import running rejection", exercise: f => f.popup("import", { ids: ["a"], types: { a: "p" } }) },
  { name: "popup/import invalid ID", prepare: idle, exercise: f => f.popup("import", { ids: ["bad.id"], types: { "bad.id": "p" } }) },
  { name: "popup/import invalid type", prepare: idle, exercise: f => f.popup("import", { ids: ["a"], types: { a: "bad" } }) },
  { name: "popup/start idle", prepare: idle, exercise: f => f.popup("start", { size: 1, windowId: 1 }) },
  { name: "popup/start five", prepare: idle, exercise: f => f.popup("start", { size: 5, windowId: 1 }) },
  { name: "popup/start return", exercise: f => f.popup("start", { size: 1, windowId: 1 }) },
  { name: "popup/start recover empty run", prepare: f => { f.session.run.slots = []; }, exercise: f => f.popup("start", { windowId: 1 }) },
  { name: "popup/start return from browsing", prepare: f => { f.tabs.get(1).url = "https://www.instagram.com/creator/"; }, exercise: f => f.popup("start", { windowId: 1 }) },
  { name: "popup/start resume Undo", prepare: f => undo(f), exercise: f => f.popup("start", { windowId: 1 }) },
  { name: "popup/restart idle", prepare: idle, exercise: f => f.popup("restart", { size: 1, windowId: 1 }) },
  { name: "popup/restart active five", prepare: five, exercise: f => f.popup("restart", { size: 5, windowId: 1 }) },
  { name: "popup/restart Undo rejection", prepare: f => undo(f), exercise: f => f.popup("restart", { windowId: 1 }) },
  { name: "popup/restart no saved items", prepare(f) { idle(f); f.local.data.decisions = { a: "unsaved", b: "unavailable", c: "unsaved" }; }, exercise: f => f.popup("restart", { windowId: 1 }) },
  { name: "popup/undo running", prepare: history, exercise: f => f.popup("undo", { windowId: 1 }) },
  { name: "popup/undo standalone", prepare(f) { idle(f); history(f); }, exercise: f => f.popup("undo", { windowId: 1 }) },
  { name: "popup/undo in progress rejection", prepare: f => undo(f), exercise: f => f.popup("undo", { windowId: 1 }) },
  { name: "popup/pause", exercise: f => f.popup("pause") },
  { name: "popup/pause Undo", prepare: f => undo(f), exercise: f => f.popup("pause") },
  { name: "popup/unknown", exercise: f => f.popup("unknown") }
];

for (const decision of ["kept", "unsaved", "later"]) {
  for (const [name, prepare] of [
    ["normal", () => {}], ["five", five], ["replay", replay],
    ["Undo", f => undo(f, true)],
    ["standalone Undo", f => { undo(f, true); idle(f); }],
    ["same-pass Undo", f => { replay(f); undo(f, true); f.session.undo.replayId = f.local.data.replayId; f.local.data.replayProgress.decided = 1; }]
  ]) scenarios.push({ name: `decision/${decision}/${name}`, prepare,
    exercise: f => f.content("decision", { decision }) });
}
scenarios.push({ name: "decision/last-item later rejection", prepare: f => { f.local.data.ids = ["a"]; },
  exercise: f => f.content("decision", { decision: "later" }) });
for (const type of ["state", "audio", "pageAvailable", "browse", "available", "noticeShown", "undo", "restored",
  "unavailable", "recheckUnavailable", "summary", "import", "start", "restart", "pause", "unknown"]) {
  scenarios.push({ name: `unauthorized/${type}`, unauthorized: true,
    exercise: f => f.unauthorized(type, { muted: true, notice: 1 }) });
}
for (const decision of ["kept", "unsaved", "later"]) scenarios.push({ name: `unauthorized/decision/${decision}`,
  unauthorized: true, exercise: f => f.unauthorized("decision", { decision }) });

// JSON fixtures preserve own undefined response fields rather than silently dropping them.
const normalize = value => JSON.parse(JSON.stringify(value, (_, item) => item === undefined ? { $undefined: true } : item));
export async function characterize(scenario) {
  const f = fixture();
  scenario.prepare?.(f);
  const before = f.snapshot();
  const response = await scenario.exercise(f);
  await f.drain(); // Include queued onRemoved/abandon effects without sending another message.
  return normalize({ response, effects: f.effects, state: f.snapshot(),
    ...(scenario.unauthorized ? { before } : {}) });
}
