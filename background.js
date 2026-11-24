import { mediaId } from "./export.mjs";

const link = (data, id) => `https://www.instagram.com/${Object.hasOwn(data.types ?? {}, id) ? data.types[id] : "reel"}/${id}/`;
const schema = 1;
const UNSUPPORTED_DATA_MESSAGE = "Saved data is from an unsupported version. Re-import your export to continue.";
const UNAVAILABLE_STREAK_LIMIT = 10;
const UNAVAILABLE_PAUSE_MESSAGE = "10 items in a row looked unavailable. You may be logged out or Instagram may be limiting this account. Check Instagram, then resume.";
const NON_PROFILE_PATHS = new Set([
  "accounts", "challenge", "checkpoint", "direct", "explore", "reels", "reel", "p", "tv",
  "stories", "about", "legal", "web", "api", "graphql", "oauth", "login", "notifications"
]);

function profileDestination(value) {
  try {
    const url = new URL(value);
    const match = /^\/([\w.]+)\/?$/.exec(url.pathname);
    return url.origin === "https://www.instagram.com" && match &&
      !NON_PROFILE_PATHS.has(match[1].toLowerCase()) ? url.href : null;
  } catch {
    return null;
  }
}

function reviewSlot(data, id, tab) {
  return { tab, id, navigation: { url: link(data, id) } };
}

function ownsSlotUrl(slot, value) {
  if (!slot) return false;
  if (mediaId(value) === slot.id) return true;
  const navigation = slot.navigation;
  return Boolean(navigation && !navigation.ready && !navigation.browsing &&
    mediaId(navigation.url) === slot.id && navigation.redirect === value && profileDestination(value));
}

function matchesRedirect(slot, sender, page) {
  return Boolean(slot && sender.tab?.id === slot.tab && sender.url === page &&
    mediaId(page) === null && ownsSlotUrl(slot, page));
}

function normalizeStoredData(data) {
  // Future schema conversions and validation belong at this single boundary.
  // Reads never rewrite unsupported or corrupted storage.
  if (data === undefined) return { schema, ids: [], types: {}, decisions: {}, deferred: [], undoHistory: [] };
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const id = value => typeof value === "string" && /^[\w-]+$/.test(value);
  const ids = value => Array.isArray(value) && value.every(id);
  const counter = value => Number.isInteger(value) && value >= 0;
  const decision = value => ["kept", "unsaved", "unavailable"].includes(value);
  const unsupported = () => { throw new Error(UNSUPPORTED_DATA_MESSAGE); };
  if (!record(data) || data.schema !== schema || !ids(data.ids) ||
      new Set(data.ids).size !== data.ids.length || !record(data.decisions) ||
      !Object.values(data.decisions).every(decision) || !ids(data.deferred)) unsupported();
  if (data.types !== undefined && (!record(data.types) ||
      !Object.values(data.types).every(value => ["p", "reel", "tv"].includes(value)))) unsupported();
  if (data.undoHistory !== undefined && (!Array.isArray(data.undoHistory) ||
      !data.undoHistory.every(entry => record(entry) && id(entry.id) && mediaId(entry.url) === entry.id &&
        (entry.previous === null || decision(entry.previous)) &&
        (entry.replayId === undefined || typeof entry.replayId === "string")))) unsupported();
  const replayFields = ["replayIndex", "replayId", "replayDeferred", "replayReviewed", "replayProgress"];
  if (replayFields.some(key => Object.hasOwn(data, key))) {
    if (!counter(data.replayIndex) || data.replayIndex > data.ids.length ||
        typeof data.replayId !== "string" || !data.replayId || !ids(data.replayDeferred) ||
        (data.replayReviewed !== undefined && !ids(data.replayReviewed)) ||
        !record(data.replayProgress) || !counter(data.replayProgress.decided) ||
        !counter(data.replayProgress.total)) unsupported();
  }
  return data;
}

async function getData() {
  const data = normalizeStoredData((await chrome.storage.local.get("data")).data);
  if (data.replayProgress) delete data.replayProgress.later;
  return data;
}
async function getRun() {
  return (await chrome.storage.session.get("run")).run;
}
const getUndo = async () => (await chrome.storage.session.get("undo")).undo;
const getUndoContext = async () => (await chrome.storage.session.get("undoContext")).undoContext;
const saveRun = run => chrome.storage.session.set({ run });
let tasks = Promise.resolve();

function serial(task) {
  const result = tasks.then(task);
  tasks = result.catch(() => {});
  return result;
}

function decisionFor(data, id) {
  return Object.hasOwn(data.decisions, id) ? data.decisions[id] : null;
}

function isTerminalDecision(decision) {
  return decision === "kept" || decision === "unsaved";
}

function isUnavailable(decision) {
  return decision === "unavailable";
}

function isQueueEligible(data, id, replay = false) {
  const decision = decisionFor(data, id);
  if (isUnavailable(decision)) return false;
  if (isTerminalDecision(decision)) return replay && decision === "kept";
  // Normal review requires an absent decision, including for unrecognized stored values.
  return replay || !Object.hasOwn(data.decisions, id);
}

function isDeferred(data, id, deferred) {
  return deferred.has(id) && isQueueEligible(data, id, true);
}

function isPending(data, id, deferred) {
  const decision = decisionFor(data, id);
  return !isTerminalDecision(decision) && !isUnavailable(decision) && !isDeferred(data, id, deferred);
}

function counts(data) {
  const deferred = new Set(data.deferred.filter(id => isQueueEligible(data, id, true)));
  const result = { total: data.ids.length, pending: 0, later: deferred.size, kept: 0, unsaved: 0, unavailable: 0 };
  for (const id of data.ids) {
    // Summary categories are disjoint; deferral preserves Keep but takes precedence in the counts.
    if (isDeferred(data, id, deferred)) continue;
    const decision = decisionFor(data, id);
    if (isTerminalDecision(decision) || isUnavailable(decision)) result[decision]++;
    else if (isPending(data, id, deferred)) result.pending++;
  }
  return result;
}

function replayProgress(data) {
  if (!Number.isInteger(data.replayIndex)) return null;
  return {
    ...data.replayProgress,
    later: data.replayDeferred.length
  };
}

async function closeSlot(slot, keepPinned = false) {
  const tab = await chrome.tabs.get(slot.tab).catch(() => null);
  if (!tab || !ownsSlotUrl(slot, tab.pendingUrl || tab.url)) return;
  if (keepPinned && tab.pinned) await chrome.tabs.update(slot.tab, { muted: false }).catch(() => {});
  else await chrome.tabs.remove(slot.tab).catch(() => {});
}

async function pause(run, undo) {
  if (undo) await chrome.storage.session.remove("undo");
  if (!run) {
    if (undo) await chrome.tabs.sendMessage(undo.tab, { type: "refresh" }).catch(() => {});
    return;
  }
  await chrome.storage.session.remove("run");
  await chrome.tabs.sendMessage(run.slots[0]?.tab, { type: "refresh" }).catch(() => {});
  await Promise.all(run.slots.map(slot => closeSlot(slot, true)));
  if (undo && run.slots.some(slot => slot.tab === undo.tab)) await closeSlot(undo, true);
}

function replayIds(data) {
  const deferred = new Set(data.replayDeferred);
  return data.ids.slice(data.replayIndex).filter(id =>
    isQueueEligible(data, id, true) && !data.replayReviewed?.includes(id) && !isDeferred(data, id, deferred)
  ).concat(data.replayDeferred.filter(id => isDeferred(data, id, deferred)));
}

function pendingIds(data) {
  const deferred = new Set(data.deferred);
  return data.ids.filter(id => isPending(data, id, deferred) && isQueueEligible(data, id))
    .concat(data.deferred.filter(id => isDeferred(data, id, deferred)));
}

function saveReplayProgress(data, progress) {
  if (replayIds(data).length) {
    data.replayProgress = { ...progress };
    delete data.replayProgress.later;
  } else {
    delete data.replayIndex;
    delete data.replayProgress;
    delete data.replayId;
    delete data.replayReviewed;
    delete data.replayDeferred;
  }
}

function nextId(run, data) {
  const ids = Number.isInteger(data.replayIndex) ? replayIds(data) : pendingIds(data);
  return ids.find(id => !run.slots.some(slot => slot.id === id));
}

async function fill(run, data, reuse) {
  while (run.slots.length < run.size) {
    const id = nextId(run, data);
    if (!id) break;
    const active = !run.slots.length;
    let tab;
    if (reuse !== undefined) {
      tab = await chrome.tabs.update(reuse, { url: link(data, id), active: true, muted: false });
      reuse = undefined;
    } else if (active) {
      tab = await chrome.tabs.create({ windowId: run.windowId, url: link(data, id), active: true });
    } else {
      // Mute before starting the Instagram navigation so preloads cannot leak audio.
      tab = await chrome.tabs.create({ windowId: run.windowId, url: "about:blank", active: false });
      try {
        await chrome.tabs.update(tab.id, { muted: true });
        tab = await chrome.tabs.update(tab.id, { url: link(data, id) });
      } catch (error) {
        await chrome.tabs.remove(tab.id).catch(() => {});
        throw error;
      }
    }
    run.slots.push(reviewSlot(data, id, tab.id));
    await saveRun(run);
  }
}

async function refresh(run, focus = false) {
  if (!run.slots.length) {
    await chrome.storage.session.remove("run");
    return;
  }
  const first = run.slots[0];
  if (focus) await chrome.tabs.update(first.tab, { active: true, muted: Boolean(run.muted) }).catch(() => {});
  await chrome.tabs.sendMessage(first.tab, { type: "refresh" }).catch(() => {});
}

function matches(slot, sender, page) {
  return slot && sender.tab?.id === slot.tab && mediaId(sender.url) === slot.id && mediaId(page) === slot.id;
}

async function startUndo(data, tab) {
  if (!tab?.active) throw new Error("Open the tab you want to use for Undo and try again.");
  const existing = await getUndo();
  if (existing) throw new Error("Decide on the reopened item before undoing another.");
  const entry = data.undoHistory?.at(-1);
  if (!entry) throw new Error("There are no recent unsaves to undo.");
  const returnUrl = tab.pendingUrl || tab.url;
  await chrome.storage.session.set({ undo: { ...entry, tab: tab.id, returnUrl } });
  try {
    if (mediaId(tab.pendingUrl || tab.url) === entry.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "refresh" });
        return {};
      } catch {
        // Reload the permalink if the content script is not available yet.
      }
    }
    await chrome.tabs.update(tab.id, { url: entry.url, muted: false });
  } catch (error) {
    await chrome.storage.session.remove("undo");
    throw error;
  }
  return {};
}

function recordDecision(data, slot, url, decision, replayId) {
  if (decision === "unsaved") {
    const previous = Object.hasOwn(data.decisions, slot.id) ? data.decisions[slot.id] : null;
    const { origin, pathname } = new URL(url);
    const entry = { id: slot.id, url: origin + pathname, previous };
    if (replayId) entry.replayId = replayId;
    data.undoHistory = [...(data.undoHistory ?? []), entry].slice(-5);
  }
  Object.defineProperty(data.decisions, slot.id, {
    value: decision, enumerable: true, configurable: true, writable: true
  });
}

async function noticeCount() {
  return (await chrome.storage.session.get("notice")).notice ?? 0;
}

async function advance(run, data, first, keepFinished = false) {
  if (run.size === 1 && keepFinished) {
    const next = nextId({ ...run, slots: [] }, data);
    if (next) {
      // Keep a tracked slot throughout the handoff, including a failed navigation.
      run.slots = [reviewSlot(data, next, first.tab)];
      await saveRun(run);
      try {
        await chrome.tabs.update(first.tab, { url: link(data, next), active: true, muted: false });
      } catch (error) {
        run.slots = [first];
        run.reviewError = `Couldn’t open the next review item: ${error.message}`;
        await saveRun(run);
        throw new Error(run.reviewError);
      }
      run.muted = false;
      delete run.reviewError;
      await saveRun(run);
      await refresh(run);
      return { done: false, canUndo: Boolean(data.undoHistory?.length) };
    }
  }
  if (run.size > 1) await chrome.tabs.update(first.tab, { muted: true }).catch(() => {});
  run.slots.shift();
  run.muted = false;
  await saveRun(run);
  const next = nextId(run, data);
  const done = !run.slots.length && !next;
  const canUndo = Boolean(data.undoHistory?.length);
  const notice = await noticeCount();
  const showFinished = keepFinished || notice > 0;
  if (done && (run.size === 1 || canUndo || showFinished)) {
    await chrome.storage.session.set({ undoContext: { kind: "complete", ...first } });
    await chrome.tabs.update(first.tab, { muted: false }).catch(() => {});
  }
  if (run.size === 1 && next) {
    await fill(run, data, first.tab);
  } else if (run.size > 1) {
    if (run.slots.length) {
      await chrome.tabs.update(run.slots[0].tab, { active: true, muted: Boolean(run.muted) }).catch(() => {});
    }
    if (!done || (!canUndo && !showFinished)) await closeSlot(first);
    await fill(run, data);
  }
  await refresh(run);
  return { done, canUndo, ...(done && notice > 0 ? { notice } : {}) };
}

async function markUnavailable(message, sender, run, data, undo) {
  if (undo?.tab === sender.tab.id) return { ignored: true };
  const slot = run?.slots.find(item => item.tab === sender.tab.id);
  if (!matches(slot, sender, message.page) && !matchesRedirect(slot, sender, message.page)) {
    throw new Error("Return to a queued review item and try again.");
  }
  const tab = await chrome.tabs.get(slot.tab);
  const url = tab.pendingUrl || tab.url;
  if (!ownsSlotUrl(slot, url) || (matchesRedirect(slot, sender, message.page) && url !== message.page)) {
    throw new Error("Return to a queued review item and try again.");
  }
  if (Object.hasOwn(data.decisions, slot.id) && data.decisions[slot.id] === "unsaved") return { ignored: true };
  const first = run.slots[0] === slot;
  if (first && Object.hasOwn(data.decisions, slot.id) && data.decisions[slot.id] === "unavailable") {
    return advance(run, data, slot, true);
  }
  const progress = replayProgress(data);
  const wasDeferred = progress && data.replayDeferred.includes(slot.id);
  recordDecision(data, slot, url, "unavailable");
  data.deferred = data.deferred.filter(id => id !== slot.id);
  if (progress) {
    data.replayDeferred = data.replayDeferred.filter(id => id !== slot.id);
    progress.decided++;
    // A waiting slot may finish out of order; never advance past earlier slots.
    if (first && !wasDeferred) {
      const index = data.ids.indexOf(slot.id, data.replayIndex);
      if (index !== -1) data.replayIndex = index + 1;
    }
    saveReplayProgress(data, progress);
  }
  await chrome.storage.local.set({ data });
  const notice = await noticeCount() + 1;
  const streak = ((await chrome.storage.session.get("unavailableStreak")).unavailableStreak ?? 0) + 1;
  await chrome.storage.session.set({ notice, unavailableStreak: streak });
  if (streak >= UNAVAILABLE_STREAK_LIMIT) {
    run.slots = run.slots.filter(item => item !== slot);
    await saveRun(run);
    await chrome.storage.session.set({ pauseMessage: UNAVAILABLE_PAUSE_MESSAGE });
    await pause(run, undo);
    await closeSlot(slot, true);
    return { paused: true, message: UNAVAILABLE_PAUSE_MESSAGE };
  }
  if (first) return advance(run, data, slot, true);
  run.slots = run.slots.filter(item => item !== slot);
  // Remove the slot from session storage before onRemoved can run abandon().
  await saveRun(run);
  await closeSlot(slot);
  await fill(run, data);
  await refresh(run);
  return { done: false };
}

async function handleAudio(message, { item, onUndoItem, undo, run }) {
  const muted = Boolean(message.muted);
  await chrome.tabs.update(item.tab, { muted });
  if (onUndoItem) await chrome.storage.session.set({ undo: { ...undo, muted } });
  else await saveRun({ ...run, muted });
  return { muted };
}

async function handleImport(message, { run, undo, data }) {
  if (run || undo) throw new Error("Pause the current review before importing.");
  const ids = [...new Set(message.ids)];
  if (!ids.length || ids.some(id => typeof id !== "string" || !/^[\w-]+$/.test(id))) {
    throw new Error("The export contains invalid media IDs.");
  }
  if (!message.types || ids.some(id => !Object.hasOwn(message.types, id) ||
    !["p", "reel", "tv"].includes(message.types[id]))) {
    throw new Error("The export contains an unsupported Instagram link.");
  }
  const types = Object.fromEntries(ids.map(id => [id, message.types[id]]));
  const decisions = Object.fromEntries(ids.filter(id => Object.hasOwn(data.decisions, id))
    .map(id => [id, data.decisions[id]]));
  const imported = new Set(ids);
  const deferred = data.deferred.filter(id => imported.has(id) && !Object.hasOwn(decisions, id));
  await chrome.storage.local.set({ data: { schema, ids, types, decisions, deferred,
    undoHistory: data.undoHistory ?? [] } });
  return {};
}

async function handleNavigation(message, sender, { undo, run, data }) {
  if (undo?.tab === sender.tab.id) return { ignored: true };
  const slot = run?.slots.find(item => matches(item, sender, message.page));
  if (!slot) return { ignored: true };
  if (message.type === "pageAvailable") {
    const tab = await chrome.tabs.get(slot.tab);
    if (mediaId(tab.pendingUrl || tab.url) !== slot.id) return { ignored: true };
  }
  slot.navigation ??= { url: link(data, slot.id) };
  // Readiness applies to preloads too; only the separate active 'available' message resets the streak.
  if (message.type === "pageAvailable") slot.navigation.ready = true;
  else slot.navigation.browsing = true;
  delete slot.navigation.redirect;
  await saveRun(run);
  return {};
}

async function handleStart(message, { run, undo, data }) {
  const restart = message.type === "restart";
  if (undo) return resumeUndo(undo, restart);
  if (run && !restart) {
    await chrome.windows.update(run.windowId, { focused: true }).catch(() => {});
    if (!run.slots.length) {
      // Recover a run saved by an older version between removing and refilling its slot.
      await fill(run, data);
      if (!run.slots.length) {
        await refresh(run);
        throw new Error("No saved items in this queue.");
      }
      delete run.reviewError;
      await saveRun(run);
    }
    const first = run.slots[0];
    if (first) {
      if (Object.hasOwn(data.decisions, first.id) && data.decisions[first.id] === "unavailable") {
        return advance(run, data, first, true);
      }
      const tab = await chrome.tabs.get(first.tab);
      if (mediaId(tab.pendingUrl || tab.url) !== first.id) {
        first.navigation = { url: link(data, first.id) };
        await saveRun(run);
        await chrome.tabs.update(first.tab, { url: link(data, first.id) });
      }
    }
    await refresh(run, true);
    return {};
  }
  if (restart) await startReplay(data);
  const current = { size: message.size === 5 ? 5 : 1, windowId: message.windowId,
    slots: [] };
  await chrome.storage.session.set({ unavailableStreak: 0 });
  await chrome.storage.session.remove("pauseMessage");
  if (restart && run) {
    // Open the first item before closing the old queue so its window stays open.
    const first = run.slots[0];
    if (first) {
      const tab = await chrome.tabs.get(first.tab).catch(() => null);
      if (tab && mediaId(tab.pendingUrl || tab.url) === first.id) {
        await chrome.tabs.update(first.tab, { muted: true });
      }
    }
    const size = current.size;
    current.size = 1;
    await fill(current, data);
    current.size = size;
    await saveRun(current);
    await Promise.all(run.slots.map(slot => closeSlot(slot, true)));
  }
  await fill(current, data);
  if (!current.slots.length) throw new Error("No saved items in this queue.");
  return {};
}

async function handleState(sender, { run, data, undo, undoCount, first, onUndoItem }) {
  if (!onUndoItem && run.reviewError) {
    return { current: false, detectUnavailable: false, reviewError: run.reviewError };
  }
  if (!onUndoItem && undo?.tab === first.tab) {
    const tab = await chrome.tabs.get(first.tab);
    if (mediaId(tab.pendingUrl || tab.url) !== undo.id) {
      // Browser Back returns to the interrupted item without recording a second decision.
      await chrome.storage.session.remove("undo");
      undo = null;
    }
  }
  const { total, kept, unsaved, unavailable, later } = counts(data);
  const notice = onUndoItem ? 0 : await noticeCount();
  return { current: true, canUndo: !undo && undoCount > 0,
    detectUnavailable: !onUndoItem && undo?.tab !== sender.tab.id,
    rereviewing: Boolean(onUndoItem), undoInProgress: Boolean(undo && !onUndoItem),
    muted: Boolean(onUndoItem ? undo.muted : run.muted),
    progress: replayProgress(data) ?? { total, decided: kept + unsaved + unavailable, later },
    ...(notice > 0 ? { notice } : {}) };
}

async function otherPageState(message, sender, { run, undo, canUndo, finished }) {
  const redirected = run?.slots.some(slot => matchesRedirect(slot, sender, message.page)) ?? false;
  const queued = redirected || (run?.slots.some(slot => matches(slot, sender, message.page)) ?? false);
  if (redirected && run.reviewError) {
    return { current: false, detectUnavailable: false, reviewError: run.reviewError };
  }
  const notice = finished ? await noticeCount() : 0;
  return { current: false, canUndo, finished,
    detectUnavailable: queued && undo?.tab !== sender.tab.id,
    ...(notice > 0 ? { notice } : {}) };
}

async function handleSummary({ run, data, undo, undoCount }) {
  return { ...counts(data), running: Boolean(run || undo), size: run?.size, undoCount: undo ? 0 : undoCount,
    replaying: Number.isInteger(data.replayIndex), replayProgress: replayProgress(data),
    reviewError: run?.reviewError,
    pauseMessage: (await chrome.storage.session.get("pauseMessage")).pauseMessage };
}

async function handleDecision(message, { run, data, undo, onUndoItem, item, first, tab, url }) {
  if (undo && !onUndoItem) throw new Error("Decide on the reopened item before continuing.");
  const progress = replayProgress(data);
  const decision = message.decision;
  const samePass = progress && undo?.replayId && undo.replayId === data.replayId;
  const wasDeferred = progress && data.replayDeferred.includes(item.id);
  if (decision === "later") {
    const remaining = progress ? replayIds(data) : pendingIds(data);
    if (!remaining.some(id => id !== item.id) && !run?.slots.some(slot => slot.id !== item.id)) {
      throw new Error("This is the last item left. Choose Keep or Unsave.");
    }
    if (progress) {
      data.replayDeferred = data.replayDeferred.filter(id => id !== item.id).concat(item.id);
      data.replayReviewed = (data.replayReviewed ?? []).filter(id => id !== item.id);
    } else {
      data.deferred = data.deferred.filter(id => id !== item.id).concat(item.id);
    }
  } else {
    recordDecision(data, item, url, decision, progress && (!onUndoItem || samePass) ? data.replayId : null);
    data.deferred = data.deferred.filter(id => id !== item.id);
    if (progress) data.replayDeferred = data.replayDeferred.filter(id => id !== item.id);
  }
  await chrome.storage.session.set({ unavailableStreak: 0 });
  if (onUndoItem) return handleUndoDecision(decision, { progress, samePass, data, item, first, undo, run, tab });

  if (progress) updateReplayDecision(data, progress, decision, wasDeferred, first);

  await chrome.storage.local.set({ data });
  return advance(run, data, first);
}

async function handleUndoRestore(message, { data, undo }) {
  if (message.type === "state") return { restoring: true };
  if (message.type === "restored") {
    // Only the tab showing the tracked item can confirm its restoration.
    if (data.undoHistory?.at(-1)?.id !== undo.id) throw new Error("The undo history changed.");
    data.undoHistory.pop();
    if (Object.hasOwn(data.decisions, undo.id) && data.decisions[undo.id] === "unsaved") {
      if (undo.previous === "kept") data.decisions[undo.id] = undo.previous;
      else delete data.decisions[undo.id];
    }
    await chrome.storage.local.set({ data });
    await chrome.storage.session.set({ undo: { ...undo, reviewing: true, muted: false } });
    await chrome.tabs.update(undo.tab, { muted: false }).catch(() => {});
    return { restored: true };
  }
  return {};
}

async function handleContentUndo(sender, { canUndo, data }) {
  if (!canUndo || !sender.tab.active) throw new Error("Undo is unavailable in this tab.");
  return startUndo(data, await chrome.tabs.get(sender.tab.id));
}

async function handlePopupUndo(message, { run, undo, data }) {
  const first = run?.slots[0];
  if (undo) throw new Error("Decide on the reopened item before undoing another.");
  if (first) {
    await chrome.windows.update(run.windowId, { focused: true }).catch(() => {});
    return startUndo(data, await chrome.tabs.update(first.tab, { active: true }));
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId: message.windowId });
  return startUndo(data, tab);
}

async function resumeUndo(undo, restart) {
  if (restart) throw new Error("Decide on the reopened item or pause before restarting.");
  const tab = await chrome.tabs.get(undo.tab);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  const properties = { active: true, muted: Boolean(undo.muted) };
  if (mediaId(tab.pendingUrl || tab.url) !== undo.id) properties.url = undo.url;
  await chrome.tabs.update(undo.tab, properties);
  await chrome.tabs.sendMessage(undo.tab, { type: "refresh" }).catch(() => {});
  return {};
}

async function handleUndoDecision(decision, { progress, samePass, data, item, first, undo, run, tab }) {
  if (progress) updateUndoReplayDecision(data, progress, samePass, decision, item);

  await chrome.storage.local.set({ data });
  await chrome.storage.session.remove("undo");
  if (first) {
    const returnUrl = mediaId(undo.returnUrl) === first.id ? undo.returnUrl : link(data, first.id);
    await chrome.tabs.update(first.tab, { url: returnUrl, active: true, muted: Boolean(run.muted) });
    return { done: false };
  }
  if (decision === "later") {
    const current = { size: 1, windowId: tab.windowId, slots: [] };
    await fill(current, data, item.tab);
    await refresh(current);
    return { done: false };
  }
  await chrome.storage.session.set({ undoContext: { kind: "complete", id: item.id, tab: item.tab } });
  return { done: true, canUndo: Boolean(data.undoHistory?.length) };
}

async function startReplay(data) {
  const totals = counts(data);
  const saved = totals.total - totals.unsaved - totals.unavailable;
  if (!saved) {
    throw new Error("There are no saved items to review again.");
  }
  data.replayIndex = 0;
  data.replayId = crypto.randomUUID();
  delete data.replayReviewed;
  data.replayDeferred = [];
  data.replayProgress = { decided: 0, total: saved };
  await chrome.storage.local.set({ data });
}

function updateReplayDecision(data, progress, decision, wasDeferred, first) {
  if (decision !== "later") progress.decided++;
  if (!wasDeferred) {
    const index = data.ids.indexOf(first.id, data.replayIndex);
    if (index !== -1) data.replayIndex = index + 1;
  }
  saveReplayProgress(data, progress);
}

function updateUndoReplayDecision(data, progress, samePass, decision, item) {
  if (samePass && decision === "later") {
    progress.decided--;
  }
  if (decision !== "later" && data.ids.indexOf(item.id, data.replayIndex) !== -1) {
    data.replayReviewed = [...(data.replayReviewed ?? []), item.id];
  }
  saveReplayProgress(data, progress);
}

async function handleNoticeShown(message, sender, { onUndoItem, undo, first, finished }) {
  if (onUndoItem || undo?.tab === sender.tab.id ||
      (!matches(first, sender, message.page) && !matchesRedirect(first, sender, message.page) && !finished)) {
    return { ignored: true };
  }
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!tab.active || mediaId(tab.pendingUrl || tab.url) !== mediaId(message.page)) return { ignored: true };
  const count = await noticeCount();
  const shown = Number.isInteger(message.notice) && message.notice > 0 ? message.notice : count;
  const notice = Math.max(0, count - shown);
  await chrome.storage.session.set({ notice });
  return { notice };
}

async function handleAvailable(sender, { onUndoItem, undo, item, run, data }) {
  if (onUndoItem || undo?.tab === sender.tab.id) return { ignored: true };
  const tab = await chrome.tabs.get(item.tab);
  if (!tab.active || mediaId(tab.pendingUrl || tab.url) !== item.id) return { ignored: true };
  item.navigation ??= { url: link(data, item.id) };
  item.navigation.ready = true;
  delete item.navigation.redirect;
  await saveRun(run);
  await chrome.storage.session.set({ unavailableStreak: 0 });
  return {};
}

async function handleRecheckUnavailable({ run, undo, data }) {
  if (run || undo) throw new Error("Pause the current review and finish Undo before rechecking unavailable items.");
  for (const id of data.ids) {
    if (Object.hasOwn(data.decisions, id) && data.decisions[id] === "unavailable") {
      delete data.decisions[id];
    }
  }
  await chrome.storage.local.set({ data });
  return {};
}

function isTrustedSender(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  if (!sender.tab) return sender.url === chrome.runtime.getURL("popup.html");
  try {
    return new URL(sender.url).origin === "https://www.instagram.com";
  } catch {
    return false;
  }
}

function rejectReviewMessage(message) {
  // Keep the existing unowned-tab responses without reading stored decisions.
  if (message.type === "unavailable") throw new Error("Return to a queued review item and try again.");
  if (message.type === "recheckUnavailable") throw new Error("Recheck unavailable items from the extension popup.");
  if (message.type === "undo") throw new Error("Undo is unavailable in this tab.");
  if (["pageAvailable", "browse", "noticeShown"].includes(message.type)) return { ignored: true };
  return { current: false, canUndo: false, finished: null, detectUnavailable: false };
}

async function receive(message, sender) {
  // Tier 1: extension identity and allowed page, before any storage access.
  if (!isTrustedSender(sender)) return rejectReviewMessage(message);
  const run = await getRun();
  let undo, undoContext;
  if (sender.tab) {
    undo = await getUndo();
    undoContext = await getUndoContext();
    // Tier 2: use the existing session identities only. The detailed queue/URL
    // authorization remains in receiveContent and its handlers.
    if (!run?.slots.some(slot => slot.tab === sender.tab.id) &&
        undo?.tab !== sender.tab.id && undoContext?.tab !== sender.tab.id) {
      return rejectReviewMessage(message);
    }
  }
  let data;
  try {
    data = await getData();
  } catch (error) {
    // Only an explicit popup import may replace unsupported data, after normal import validation.
    if (sender.tab || message.type !== "import" || error.message !== UNSUPPORTED_DATA_MESSAGE) throw error;
    data = normalizeStoredData(undefined);
  }
  if (!sender.tab) undo = await getUndo();
  const undoCount = data.undoHistory?.length ?? 0;
  const context = { run, data, undo, undoCount, undoContext };
  if (sender.tab) return receiveContent(message, sender, context);
  return receivePopup(message, context);
}

async function receiveContent(message, sender, { run, data, undo, undoCount, undoContext: context }) {
  if (message.type === "unavailable") return markUnavailable(message, sender, run, data, undo);
  if (message.type === "recheckUnavailable") throw new Error("Recheck unavailable items from the extension popup.");
  if (message.type === "pageAvailable" || message.type === "browse") {
    return handleNavigation(message, sender, { undo, run, data });
  }
  const onUndoItem = matches(undo, sender, message.page);
  if (onUndoItem && !undo.reviewing) return handleUndoRestore(message, { data, undo });
  const first = run?.slots[0];
  const item = onUndoItem ? undo : first;
  const ownsTab = first?.tab === sender.tab.id;
  const finished = matches(context, sender, message.page) || matchesRedirect(context, sender, message.page)
    ? context.kind : null;
  const canUndo = !undo && (ownsTab || Boolean(finished)) && undoCount > 0;
  if (message.type === "noticeShown") {
    return handleNoticeShown(message, sender, { onUndoItem, undo, first, finished });
  }
  if (message.type === "undo") return handleContentUndo(sender, { canUndo, data });
  if (!onUndoItem && !matches(first, sender, message.page)) {
    return otherPageState(message, sender, { run, undo, canUndo, finished });
  }
  if (message.type === "state") return handleState(sender, { run, data, undo, undoCount, first, onUndoItem });
  if (message.type === "available") return handleAvailable(sender, { onUndoItem, undo, item, run, data });
  if (message.type !== "audio" &&
      (message.type !== "decision" || !["kept", "later", "unsaved"].includes(message.decision))) return {};
  const tab = await chrome.tabs.get(item.tab);
  const url = tab.pendingUrl || tab.url;
  if (!tab.active || mediaId(url) !== item.id) {
    throw new Error("Return to the active review item and try again.");
  }
  if (message.type === "audio") return handleAudio(message, { item, onUndoItem, undo, run });
  return handleDecision(message, { run, data, undo, onUndoItem, item, first, tab, url });
}

async function receivePopup(message, { run, data, undo, undoCount }) {
  switch (message.type) {
    case "summary":
      return handleSummary({ run, data, undo, undoCount });
    case "recheckUnavailable":
      return handleRecheckUnavailable({ run, undo, data });
    case "undo":
      return handlePopupUndo(message, { run, undo, data });
    case "import":
      return handleImport(message, { run, undo, data });
    case "restart":
    case "start":
      return handleStart(message, { run, undo, data });
    case "pause":
      await pause(run, undo);
      return {};
    default:
      return {};
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serial(() => receive(message, sender)).then(
    respond,
    error => respond({ error: error.message })
  );
  return true;
});

function abandon(tabId) {
  return serial(async () => {
    const undo = await getUndo();
    if (undo?.tab === tabId) await chrome.storage.session.remove("undo");
    const context = await getUndoContext();
    if (context?.tab === tabId) await chrome.storage.session.remove("undoContext");
    const run = await getRun();
    const slot = run?.slots.find(item => item.tab === tabId);
    if (!slot) return;
    // Keep the item pending and let the user resume explicitly.
    await pause(run, undo?.tab === tabId ? null : undo);
  });
}

chrome.tabs.onRemoved.addListener(tabId => { abandon(tabId).catch(console.error); });

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  serial(async () => {
    const run = await getRun();
    const slot = run?.slots.find(item => item.tab === tabId);
    const navigation = slot?.navigation;
    if (!navigation || navigation.ready || navigation.browsing || mediaId(navigation.url) !== slot.id) return;
    if ((await getUndo())?.tab === tabId) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const actual = tab.pendingUrl || tab.url;
    if (mediaId(actual) === slot.id) {
      if (!navigation.redirect) return;
      delete navigation.redirect;
    } else {
      const destination = profileDestination(actual);
      if (destination && (!navigation.redirect || navigation.redirect === destination)) {
        if (navigation.redirect === destination) return;
        navigation.redirect = destination;
      } else {
        // Login/challenge pages and a second detour are ordinary browsing, never automatic decisions.
        navigation.browsing = true;
        delete navigation.redirect;
      }
    }
    await saveRun(run);
    await chrome.tabs.sendMessage(tabId, { type: "refresh" }).catch(() => {});
  }).catch(console.error);
});
