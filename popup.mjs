import { parseExport } from "./export.mjs";

const byId = id => document.getElementById(id);
const start = byId("start");
const restart = byId("restart");
const recheck = byId("recheck");
const pause = byId("pause");
const undo = byId("undo");
const file = byId("file");
const mode = byId("mode");
const status = byId("status");

async function send(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (result.error) throw new Error(result.error);
  return result;
}

async function showSummary() {
  const summary = await send("summary");
  byId("summary").textContent = summary.total
    ? `${summary.pending.toLocaleString()} new · ${summary.later.toLocaleString()} review later · ${summary.kept.toLocaleString()} kept · ${summary.unsaved.toLocaleString()} unsaved`
    : "Import your saved_posts.json to begin.";
  if (summary.replayProgress) {
    const { total, decided, later } = summary.replayProgress;
    byId("summary").textContent = `${decided.toLocaleString()} / ${total.toLocaleString()} decided · ${later.toLocaleString()} review later`;
  }
  const unavailable = summary.unavailable ?? 0;
  if (unavailable > 0) byId("summary").textContent += ` · ${unavailable.toLocaleString()} unavailable`;
  recheck.hidden = summary.running || unavailable === 0;
  recheck.textContent = `Recheck unavailable items (${unavailable.toLocaleString()})`;
  if (summary.reviewError) status.textContent = `${summary.reviewError} Choose Return to review to retry.`;
  else if (!summary.running && summary.pauseMessage) status.textContent = summary.pauseMessage;
  if (summary.size) mode.value = String(summary.size);
  byId("import-label").hidden = summary.running;
  byId("mode-label").hidden = summary.running;
  start.textContent = summary.running ? "Return to review" : summary.replaying ? "Resume review" : "Start review";
  start.disabled = !summary.running && !(summary.pending + summary.later > 0) && !summary.replaying;
  restart.hidden = summary.total === summary.unsaved + unavailable;
  pause.hidden = !summary.running;
  undo.hidden = !summary.undoCount;
}

let busy = false;
async function run(operation) {
  if (busy) return;
  busy = true;
  status.textContent = "";
  try {
    await operation();
    await showSummary();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    busy = false;
  }
}

file.addEventListener("change", () => run(async () => {
  const selected = file.files[0];
  if (!selected) return;
  try {
    const { ids, types, excluded } = parseExport(JSON.parse(await selected.text()));
    await send("import", { ids, types });
    status.textContent = `Loaded ${ids.length.toLocaleString()} unique saved items.` +
      (excluded ? ` ${excluded.toLocaleString()} unsupported or duplicate entries omitted.` : "");
  } finally {
    file.value = "";
  }
}));

function begin(fromBeginning = false) {
  return run(async () => {
    const window = await chrome.windows.getCurrent();
    await send(fromBeginning ? "restart" : "start", { windowId: window.id, size: Number(mode.value) });
    globalThis.close();
  });
}

start.addEventListener("click", () => begin());
restart.addEventListener("click", () => begin(true));
pause.addEventListener("click", () => run(() => send("pause")));
recheck.addEventListener("click", () => run(() => send("recheckUnavailable")));

function undoLast() {
  return run(async () => {
    const window = await chrome.windows.getCurrent();
    await send("undo", { windowId: window.id });
    globalThis.close();
  });
}

undo.addEventListener("click", undoLast);
window.addEventListener("keydown", event => {
  if (undo.hidden || !event.ctrlKey || event.altKey || event.shiftKey || event.metaKey ||
      event.repeat || event.key.toLowerCase() !== "z") return;
  event.preventDefault();
  undoLast();
});
run(() => {});
