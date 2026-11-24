import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { mediaId } from "../export.mjs";

// Evaluate the real worker without exporting internals or changing its entry point.
const source = (await readFile(new URL("../background.js", import.meta.url), "utf8"))
  .replace('import { mediaId } from "./export.mjs";', "");
const rules = runInNewContext(`${source}\n({ counts, pendingIds, replayIds, nextId });`, {
  mediaId, URL,
  chrome: {
    runtime: { onMessage: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } }
  }
});

// Frozen copies of the pre-Phase-4a rules, including Phase 2's disjoint counting fix.
// Keep these independent of production predicates so the comparisons detect drift.
function referenceCounts(data) {
  const deferred = new Set(data.deferred.filter(id =>
    !Object.hasOwn(data.decisions, id) || !["unsaved", "unavailable"].includes(data.decisions[id])
  ));
  const result = { total: data.ids.length, pending: 0, later: deferred.size, kept: 0, unsaved: 0, unavailable: 0 };
  for (const id of data.ids) {
    if (deferred.has(id)) continue;
    const decision = Object.hasOwn(data.decisions, id) ? data.decisions[id] : null;
    if (decision === "kept" || decision === "unsaved" || decision === "unavailable") result[decision]++;
    else if (!deferred.has(id)) result.pending++;
  }
  return result;
}

function referencePendingIds(data) {
  const deferred = new Set(data.deferred);
  return data.ids.filter(id => !Object.hasOwn(data.decisions, id) && !deferred.has(id))
    .concat(data.deferred.filter(id =>
      !Object.hasOwn(data.decisions, id) || !["unsaved", "unavailable"].includes(data.decisions[id])
    ));
}

function referenceReplayIds(data) {
  const deferred = new Set(data.replayDeferred);
  return data.ids.slice(data.replayIndex).filter(id =>
    (!Object.hasOwn(data.decisions, id) || !["unsaved", "unavailable"].includes(data.decisions[id])) &&
    !data.replayReviewed?.includes(id) && !deferred.has(id)
  ).concat(data.replayDeferred.filter(id =>
    !Object.hasOwn(data.decisions, id) || !["unsaved", "unavailable"].includes(data.decisions[id])
  ));
}

function assertCounts(data, label) {
  const actual = structuredClone(rules.counts(data));
  assert.deepEqual(actual, referenceCounts(data), label);
  assert.equal(actual.pending + actual.later + actual.kept + actual.unsaved + actual.unavailable,
    actual.total, label);
}

function* orderedSubsets(ids, prefix = []) {
  yield prefix;
  for (const id of ids) yield* orderedSubsets(ids.filter(candidate => candidate !== id), [...prefix, id]);
}

const ids = ["__proto__", "constructor", "toString"];
const decisions = [null, "kept", "unsaved", "unavailable"];
const deferrals = [...orderedSubsets(ids)];
function decisionMap(code) {
  return Object.fromEntries(ids.flatMap((id, index) => {
    const decision = decisions[Math.floor(code / 4 ** index) % 4];
    return decision === null ? [] : [[id, decision]];
  }));
}

test("All 1024 normal state/deferral combinations keep disjoint counts and the old queue order", () => {
  let checked = 0;
  for (let code = 0; code < 4 ** ids.length; code++) {
    for (const deferred of deferrals) {
      const data = { ids, decisions: decisionMap(code), deferred };
      const label = `normal states=${code} deferred=${deferred.join(",")}`;
      assertCounts(data, label);
      const expected = referencePendingIds(data);
      assert.deepEqual(structuredClone(rules.pendingIds(data)), expected, label);
      const run = { slots: expected.slice(0, 2).map(id => ({ id })) };
      assert.equal(rules.nextId(run, data), expected.find(id => !run.slots.some(slot => slot.id === id)), label);
      checked++;
    }
  }
  assert.equal(checked, 1024);
});

test("All 32768 replay state/deferral/cursor/reviewed combinations match the old queue", () => {
  let checked = 0;
  for (let code = 0; code < 4 ** ids.length; code++) {
    for (const replayDeferred of deferrals) {
      for (let replayIndex = 0; replayIndex <= ids.length; replayIndex++) {
        for (let mask = 0; mask < 2 ** ids.length; mask++) {
          const data = { ids, decisions: decisionMap(code), deferred: [...replayDeferred].reverse(),
            replayDeferred, replayIndex, replayReviewed: ids.filter((_, index) => mask & (1 << index)) };
          const label = `replay states=${code} deferred=${replayDeferred.join(",")} cursor=${replayIndex} reviewed=${mask}`;
          assertCounts(data, label);
          const expected = referenceReplayIds(data);
          assert.deepEqual(structuredClone(rules.replayIds(data)), expected, label);
          const run = { slots: expected.filter((_, index) => index % 2 === 0).map(id => ({ id })) };
          assert.equal(rules.nextId(run, data), expected.find(id => !run.slots.some(slot => slot.id === id)), label);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 32768);
});

test("2000 seeded larger snapshots preserve both queues, counts, and input data", () => {
  let seed = 0x4a2026;
  const random = limit => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 0x100000000) * limit);
  };
  const shuffle = values => {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index--) {
      const other = random(index + 1);
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  };
  const deferredIds = values => {
    const result = shuffle(values).filter(() => random(2));
    // Preserve the old behavior even for duplicate deferrals in stored snapshots.
    if (result.length && random(5) === 0) result.push(result[0]);
    return Object.freeze(result);
  };
  for (let index = 0; index < 2000; index++) {
    const itemIds = shuffle(Array.from({ length: random(31) }, (_, item) => ids[item] ?? `item${item}`));
    const recorded = Object.fromEntries(itemIds.flatMap(id => {
      const state = random(7);
      // Include own undefined/null/legacy values to preserve hasOwn semantics.
      return state === 0 ? [] : [[id, [undefined, "kept", "unsaved", "unavailable", undefined, null, "skipped"][state]]];
    }));
    const data = Object.freeze({ ids: Object.freeze(itemIds), decisions: Object.freeze(recorded),
      deferred: deferredIds(itemIds), replayDeferred: deferredIds(itemIds),
      replayIndex: random(itemIds.length + 1),
      replayReviewed: index % 2 ? undefined : Object.freeze(shuffle(itemIds).filter(() => random(2))) });
    const before = structuredClone(data);
    const label = `seeded snapshot ${index}`;
    assertCounts(data, label);
    assert.deepEqual(structuredClone(rules.pendingIds(data)), referencePendingIds(data), label);
    assert.deepEqual(structuredClone(rules.replayIds(data)), referenceReplayIds(data), label);
    assert.deepEqual(data, before, label);
  }
});
