import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parseExport } from "../export.mjs";

const source = (await readFile(new URL("../popup.mjs", import.meta.url), "utf8"))
  .replace('import { parseExport } from "./export.mjs";', "");

async function popup(summary, duringInitialization) {
  const elements = new Map();
  const messages = [];
  let closed = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: id === "mode" ? "1" : "", textContent: "", hidden: false, disabled: false,
      listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }
    });
    return elements.get(id);
  };
  runInNewContext(source, {
    document: { getElementById: element }, parseExport,
    window: { addEventListener() {} }, close() { closed++; },
    chrome: {
      runtime: { async sendMessage(message) {
        messages.push(structuredClone(message));
        return structuredClone(message.type === "summary" ? await summary : {});
      } },
      windows: { async getCurrent() { return { id: 7 }; } }
    }
  });
  await duringInitialization?.({ element, messages });
  await new Promise(resolve => setImmediate(resolve));
  return { element, messages, get closed() { return closed; } };
}

const base = { total: 4, pending: 0, later: 1, kept: 2, unsaved: 1, running: false, undoCount: 0 };

test("Popup initialization requests exactly one summary", async () => {
  const p = await popup(base);
  assert.deepEqual(p.messages, [{ type: "summary" }]);
});

test("Popup initialization keeps the busy guard until its summary settles", async () => {
  let resolveSummary;
  const pending = new Promise(resolve => { resolveSummary = resolve; });
  const p = await popup(pending, async ({ element, messages }) => {
    await element("pause").listeners.click();
    assert.deepEqual(messages, [{ type: "summary" }]);
    resolveSummary(base);
  });
  assert.deepEqual(p.messages, [{ type: "summary" }]);
  await p.element("pause").listeners.click();
  assert.equal(p.messages.filter(message => message.type === "pause").length, 1);
  assert.equal(p.messages.filter(message => message.type === "summary").length, 2);
});

test("Popup shows initial reply and transport errors and releases its busy guard", async () => {
  for (const response of [
    () => ({ error: "Initial summary failed" }),
    () => Promise.reject(new Error("Initial summary failed"))
  ]) {
    const p = await popup(response());
    assert.equal(p.element("status").textContent, "Initial summary failed");
    assert.deepEqual(p.messages, [{ type: "summary" }]);
    await p.element("pause").listeners.click();
    assert.equal(p.messages.filter(message => message.type === "pause").length, 1);
  }
});

test("Popup displays disjoint new/later counts and enables Start for deferred-only work", async () => {
  const p = await popup(base);
  assert.equal(p.element("summary").textContent, "0 new · 1 review later · 2 kept · 1 unsaved");
  assert.equal(p.element("start").disabled, false);
  assert.equal(p.element("start").textContent, "Start review");
});

test("Popup disables Start once no pending or deferred items remain", async () => {
  const p = await popup({ ...base, later: 0, kept: 3 });
  assert.equal(p.element("start").disabled, true);
});

test("Popup resumes a kept-item re-review pass using its deferred counter", async () => {
  const p = await popup({ ...base, later: 0, replaying: true,
    replayProgress: { total: 3, decided: 1, later: 2 } });
  assert.equal(p.element("summary").textContent, "1 / 3 decided · 2 review later");
  assert.equal(p.element("start").disabled, false);
  assert.equal(p.element("start").textContent, "Resume review");
});

test("Popup starts and restarts without the removed retry option", async () => {
  for (const [button, type] of [["start", "start"], ["restart", "restart"]]) {
    const p = await popup(base);
    p.element("mode").value = "5";
    await p.element(button).listeners.click();
    assert.deepEqual(p.messages.find(message => message.type === type), { type, windowId: 7, size: 5 });
    assert.equal(p.closed, 1);
  }
});

test("Popup adds unavailable counts, hides empty totals, and rechecks without confirmation", async () => {
  const p = await popup({ ...base, unavailable: 3 });
  assert.equal(p.element("summary").textContent, "0 new · 1 review later · 2 kept · 1 unsaved · 3 unavailable");
  assert.equal(p.element("recheck").hidden, false);
  assert.equal(p.element("recheck").textContent, "Recheck unavailable items (3)");
  await p.element("recheck").listeners.click();
  assert.deepEqual(p.messages.find(message => message.type === "recheckUnavailable"), { type: "recheckUnavailable" });
  assert.equal((await popup({ ...base, unavailable: 0 })).element("recheck").hidden, true);
  assert.equal((await popup({ ...base, unavailable: 3, running: true })).element("recheck").hidden, true);
});

test("Popup displays the circuit-breaker pause reason when opened", async () => {
  const message = "10 items in a row looked unavailable. You may be logged out or Instagram may be limiting this account. Check Instagram, then resume.";
  const p = await popup({ ...base, pauseMessage: message });
  assert.equal(p.element("status").textContent, message);
});

test("Unavailable-only exports cannot start or restart and show the recheck action", async () => {
  const p = await popup({ ...base, total: 4, pending: 0, later: 0, kept: 0, unsaved: 0, unavailable: 4 });
  assert.equal(p.element("start").disabled, true);
  assert.equal(p.element("restart").hidden, true);
  assert.equal(p.element("recheck").hidden, false);
});

test("The popup exposes a failed handoff while keeping Return to review available", async () => {
  const p = await popup({ ...base, running: true,
    reviewError: "Couldn’t open the next review item: Simulated navigation failure" });
  assert.match(p.element("status").textContent, /Simulated navigation failure/);
  assert.match(p.element("status").textContent, /Return to review/);
  assert.equal(p.element("start").textContent, "Return to review");
  assert.equal(p.element("start").disabled, false);
});

test("Popup displays the exact unsupported-version error without a successful summary", async () => {
  const message = "Saved data is from an unsupported version. Re-import your export to continue.";
  const p = await popup({ error: message });
  assert.equal(p.element("status").textContent, message);
  assert.deepEqual(p.messages, [{ type: "summary" }]);
});
