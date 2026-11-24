import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../content.js", import.meta.url), "utf8");
const errorText = "Sorry, this page isn't available. The link you followed may be broken.";

// A small simulated DOM and virtual clock exercise the actual content script.
// They do not validate Instagram's live DOM, browser layout, or real timer throttling.
async function fixture(options = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const messages = [];
  const debug = [];
  const errors = [];
  const elements = new Map();
  const observers = new Set();
  let runtimeListener;
  let navigationReads = 0;
  let clicks = 0;
  class Element {
    constructor(name = "div", width = 500, height = 100) {
      this.localName = name;
      this.width = width;
      this.height = height;
      this.hidden = false;
      this.isConnected = false;
      this.style = {};
      this.dataset = {};
      this.textContent = "";
      this.attributes = new Map();
      this.events = new Map();
    }
    addEventListener(type, callback) {
      if (!this.events.has(type)) this.events.set(type, []);
      this.events.get(type).push(callback);
    }
    getBoundingClientRect() {
      const width = this.hidden ? 0 : this.width;
      const height = this.hidden ? 0 : this.height;
      return { top: 100, left: 200, bottom: 100 + height, right: 200 + width, width, height };
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    querySelector(selector) { return selector === '[role="status"]' ? element("status") : null; }
    querySelectorAll() { return []; }
    remove() { this.isConnected = false; }
    click() { clicks++; }
  }
  class Video extends Element {
    constructor() { super("video", 400, 500); this.muted = false; this.volume = 1; }
  }
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const actions = ["kept", "unsaved", "later"].map(action => {
    const button = new Element("button");
    button.dataset.action = action;
    return button;
  });
  const shadow = {
    innerHTML: "",
    querySelector(selector) {
      if (selector === "nav") return element("nav");
      if (selector === '[role="status"]') return element("status");
      return element(selector.slice(1));
    },
    querySelectorAll(selector) { return selector === "[data-action]" ? actions : []; }
  };
  const host = element("host");
  host.attachShadow = () => shadow;
  element("unavailable-notice").hidden = true;
  const document = new Element("document");
  document.hidden = options.hidden ?? false;
  document.body = { innerText: options.text ?? errorText };
  const media = options.media ? [new Video()] : [];
  // A small DOM tree for the real bookmarkScope()/bookmark() selectors.
  // Clicks change labels, as Instagram does, rather than stubbing bookmark().
  const bookmarkControls = [];
  const bookmarkArticles = [];
  let bookmarkRoot;
  if (options.bookmarks || options.articles) {
    class BookmarkElement extends Element {
      constructor(name, width = 40, height = 40) {
        super(name, width, height);
        this.children = [];
      }
      append(...children) {
        for (const child of children) {
          child.parentElement = this;
          this.children.push(child);
        }
      }
      matches(selector) {
        return selector.split(",").some(part => {
          part = part.trim();
          if (part === ":disabled") return Boolean(this.disabled);
          if (part === "svg title") return this.localName === "title" && this.parentElement?.localName === "svg";
          const match = /^(\w+)?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/.exec(part);
          return Boolean(match && (!match[1] || match[1] === this.localName) &&
            (!match[2] || (this.attributes.has(match[2]) &&
              (match[3] === undefined || this.getAttribute(match[2]) === match[3]))));
        });
      }
      closest(selector) {
        for (let node = this; node; node = node.parentElement) {
          if (node.matches(selector)) return node;
        }
        return null;
      }
      contains(node) {
        for (; node; node = node.parentElement) if (node === this) return true;
        return false;
      }
      querySelectorAll(selector) {
        return this.children.flatMap(child => [
          ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
        ]);
      }
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
      click() { super.click(); this.onClick?.(); }
    }
    bookmarkRoot = new BookmarkElement("main", 800, 600);
    for (const articleConfig of options.articles ?? [options]) {
      const article = new BookmarkElement(articleConfig.noArticle ? "div" : "article", 600, 600);
      bookmarkArticles.push(article);
      for (const href of articleConfig.articleLinks ?? [articleConfig.articleUrl ?? options.url ?? "https://www.instagram.com/reel/a/"]) {
        const anchor = new BookmarkElement("a");
        const permalink = new URL(href);
        anchor.setAttribute("href", permalink.href);
        anchor.origin = permalink.origin;
        anchor.pathname = permalink.pathname;
        article.append(anchor);
      }
      const image = new BookmarkElement("img", 400, 500);
      media.push(image);
      bookmarkRoot.append(article);
      article.append(image);
      for (const config of articleConfig.bookmarks ?? []) {
        const button = new BookmarkElement("button");
        const label = config.icon ? new BookmarkElement("svg", 24, 24) : button;
        if (config.icon) button.append(label);
        let saved = config.saved ?? true;
        const render = () => {
          label.setAttribute("aria-label", saved ? "Unsave" : "Save");
          button.setAttribute("aria-pressed", String(saved));
        };
        render();
        if (config.conflictingLabel) {
          const title = new BookmarkElement("title");
          title.textContent = "Save";
          label.append(title);
        }
        button.onClick = () => {
          if (config.changeOnClick === false) return;
          const change = () => { saved = !saved; render(); };
          if (config.transitionDelayMs) schedule(change, config.transitionDelayMs);
          else change();
        };
        article.append(button);
        bookmarkControls.push({ button, label, get saved() { return saved; } });
      }
    }
  }
  document.createElement = () => host;
  document.documentElement = { append(node) { node.isConnected = true; } };
  document.querySelector = selector => bookmarkRoot && selector === "main, [role='main']" ? bookmarkRoot : null;
  document.querySelectorAll = selector => {
    if (selector === "video, img, canvas") return media;
    if (selector === "video") return media.filter(item => item.localName === "video");
    return [];
  };
  const window = new Element("window");
  const location = new URL(options.url ?? "https://www.instagram.com/reel/a/");
  const state = {
    current: true, queued: true, detectUnavailable: true, muted: false,
    progress: { total: 3, decided: 0, later: 0 }, ...options.state
  };
  const schedule = (callback, delay, interval = false) => {
    const id = ++timerId;
    const period = options.throttle && document.hidden ? Math.max(delay, 1000) : delay;
    timers.set(id, { at: now + period, callback, interval: interval ? period : 0 });
    return id;
  };
  const fakeDate = class extends Date { static now() { return now; } };
  class RenderObserver {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  runInNewContext(source, {
    document, window, location, URL, innerWidth: 1280, innerHeight: 800, HTMLVideoElement: Video,
    getComputedStyle: () => ({ visibility: "visible" }), Date: fakeDate,
    MutationObserver: RenderObserver,
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    performance: { getEntriesByType() {
      navigationReads++;
      return [{ responseStatus: options.responseStatus, name: options.navigationName }];
    } },
    console: { debug(...args) { debug.push(args.join(" ")); }, error(error) { errors.push(error); } },
    chrome: {
      storage: {
        local: { async get() { return { reviewBarPosition: options.position }; }, async set() {} },
        onChanged: { addListener() {} }
      },
      runtime: {
        onMessage: { addListener(callback) { runtimeListener = callback; } },
        async sendMessage(message) {
          messages.push(structuredClone(message));
          if (message.type === "state") return structuredClone(state);
          if (message.type === "decision") return options.decisionResult ?? { done: false };
          if (message.type === "restored") {
            Object.assign(state, { restoring: false, current: true, rereviewing: true, detectUnavailable: false });
            return { restored: true };
          }
          if (message.type === "unavailable") {
            if (options.loseQueueWhileReporting) {
              Object.assign(state, { current: false, queued: false, detectUnavailable: false });
              runtimeListener({ type: "refresh" });
              for (let i = 0; i < 8; i++) await Promise.resolve();
            }
            return options.unavailableResult ?? { done: false };
          }
          if (message.type === "noticeShown") {
            state.notice = Math.max(0, (state.notice ?? 0) - message.notice);
            return { notice: state.notice };
          }
          return {};
        }
      }
    }
  });
  const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  async function tick(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      let selected;
      for (const [id, timer] of timers) {
        if (timer.at <= target && (!selected || timer.at < selected[1].at)) selected = [id, timer];
      }
      if (!selected) break;
      const [id, timer] = selected;
      now = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else timers.delete(id);
      timer.callback();
      await flush();
    }
    now = target;
    await flush();
    assert.deepEqual(errors, []);
  }
  await flush();
  return {
    document, window, state, media, element, shadow, host, location, messages, debug, tick, bookmarkControls, bookmarkArticles,
    get navigationReads() { return navigationReads; }, get clicks() { return clicks; },
    get observerCount() { return observers.size; },
    count(type) { return messages.filter(message => message.type === type).length; },
    async action(decision) {
      const button = actions.find(button => button.dataset.action === decision);
      assert.ok(button, `Unknown action: ${decision}`);
      assert.notEqual(button.disabled, true, "Review actions must be enabled before clicking");
      for (const callback of button.events.get("click") ?? []) callback({ isTrusted: true });
      await flush();
    },
    async retrySave() {
      for (const callback of element("restore").events.get("click") ?? []) callback({ isTrusted: true });
      await flush();
    },
    async refresh() { runtimeListener({ type: "refresh" }); await flush(); },
    async mutate() {
      for (const observer of [...observers]) observer.callback([{ type: "childList", target: document.body }]);
      await flush();
    },
    async visible() {
      document.hidden = false;
      for (const callback of document.events.get("visibilitychange") ?? []) callback({});
      await flush();
    },
    async mediaEvent(type, target) {
      for (const callback of document.events.get(type) ?? []) callback({ target });
      await flush();
    },
    async linkClick(destination, extra = {}) {
      const anchor = new URL(destination);
      anchor.target = extra.target ?? "";
      const event = { isTrusted: true, button: 0, target: { closest() { return anchor; } }, ...extra };
      for (const callback of document.events.get("click") ?? []) callback(event);
      await flush();
    },
    video() { const item = new Video(); media.push(item); return item; },
    image(width, height) { const item = new Element("img", width, height); media.push(item); return item; }
  };
}

test("Unsave refuses the only visible article when its permalink belongs to a different post", async () => {
  const f = await fixture({ url: "https://www.instagram.com/reel/a/",
    articleUrl: "https://www.instagram.com/reel/b/", bookmarks: [{ saved: true, icon: true }] });
  await f.action("unsaved");
  await f.tick(3000);
  assert.equal(f.clicks, 0);
  assert.equal(f.count("decision"), 0);
  assert.equal(f.bookmarkControls[0].saved, true);
  assert.equal(f.location.pathname, "/reel/a/");
  assert.equal(f.element("bar").hidden, false);
  assert.match(f.element("status").textContent, /Bookmark unavailable/);
});

for (const [name, options] of [
  ["no permalink", { articleLinks: [] }],
  ["conflicting post permalinks", { articleLinks: ["https://www.instagram.com/reel/a/", "https://www.instagram.com/p/b/"] }],
  ["no article", { noArticle: true }]
]) {
  test("Unsave requires a positively identified article: " + name, async () => {
    const f = await fixture({ ...options, bookmarks: [{ saved: true }] });
    await f.action("unsaved");
    await f.tick(3000);
    assert.equal(f.clicks, 0);
    assert.equal(f.count("decision"), 0);
    assert.equal(f.element("bar").hidden, false);
  });
}

for (const type of ["p", "reel"]) {
  test("Unsave still verifies a matching " + type + " article", async () => {
    const f = await fixture({ url: "https://www.instagram.com/" + type + "/a/", bookmarks: [{ saved: true, icon: true }] });
    await f.action("unsaved");
    await f.tick(160);
    assert.equal(f.clicks, 1);
    assert.equal(f.bookmarkControls[0].saved, false);
    assert.deepEqual(f.messages.filter(message => message.type === "decision"),
      [{ type: "decision", page: f.location.href, decision: "unsaved" }]);
  });
}

test("Unsave selects only the matching post among several feed articles", async () => {
  const f = await fixture({ url: "https://www.instagram.com/p/a/", articles: [
    { articleUrl: "https://www.instagram.com/p/b/", bookmarks: [{ saved: true }] },
    { articleUrl: "https://www.instagram.com/p/a/", bookmarks: [{ saved: true, icon: true }] },
    { articleUrl: "https://www.instagram.com/reel/c/", bookmarks: [{ saved: true }] }
  ] });
  await f.action("unsaved");
  await f.tick(160);
  assert.equal(f.clicks, 1);
  assert.deepEqual(f.bookmarkControls.map(control => control.saved), [true, false, true]);
  assert.equal(f.count("decision"), 1);
});

test("A refused Unsave can be retried after the matching article loads", async () => {
  const f = await fixture({ articleUrl: "https://www.instagram.com/reel/b/", bookmarks: [{ saved: true }] });
  await f.action("unsaved");
  await f.tick(3000);
  assert.equal(f.clicks, 0);
  const anchor = f.bookmarkArticles[0].querySelector("a[href]");
  anchor.setAttribute("href", f.location.href);
  anchor.pathname = f.location.pathname;
  await f.action("unsaved");
  await f.tick(160);
  assert.equal(f.clicks, 1);
  assert.equal(f.count("decision"), 1);
});

test("Ambiguous bookmark buttons refuse Unsave without clicking or recording a decision", async () => {
  const f = await fixture({ bookmarks: [{ saved: true }, { saved: true, icon: true }] });
  await f.action("unsaved");
  await f.tick(3000);
  assert.equal(f.bookmarkControls.length, 2);
  assert.equal(f.clicks, 0);
  assert.equal(f.count("decision"), 0);
  assert.equal(f.element("bar").hidden, false);
  assert.match(f.element("status").textContent, /Bookmark unavailable/);
});

test("Conflicting saved labels on one bookmark icon also refuse Unsave", async () => {
  const f = await fixture({ bookmarks: [{ saved: true, icon: true, conflictingLabel: true }] });
  await f.action("unsaved");
  await f.tick(3000);
  assert.equal(f.clicks, 0);
  assert.equal(f.count("decision"), 0);
  assert.match(f.element("status").textContent, /Bookmark unavailable/);
});

test("Unsave records a decision only after the saved DOM control changes to unsaved", async () => {
  for (const icon of [false, true]) {
    const f = await fixture({ bookmarks: [{ saved: true, icon, transitionDelayMs: 320 }] });
    await f.action("unsaved");
    assert.equal(f.clicks, 1);
    assert.equal(f.bookmarkControls[0].saved, true);
    assert.equal(f.count("decision"), 0);
    await f.tick(160);
    assert.equal(f.count("decision"), 0);
    await f.tick(160);
    assert.equal(f.bookmarkControls[0].saved, false);
    assert.equal(f.bookmarkControls[0].label.getAttribute("aria-label"), "Save");
    assert.deepEqual(f.messages.filter(message => message.type === "decision"),
      [{ type: "decision", page: f.location.href, decision: "unsaved" }]);
    assert.equal(f.clicks, 1);
    assert.equal(f.element("bar").hidden, true);
  }
});

test("An already-unsaved DOM control is verified without toggling it back to saved", async () => {
  const f = await fixture({ bookmarks: [{ saved: false, icon: true }] });
  await f.action("unsaved");
  assert.equal(f.clicks, 0);
  assert.equal(f.count("decision"), 1);
  assert.equal(f.bookmarkControls[0].saved, false);
});

test("Failed unsave verification keeps the item open and sends no decision", async () => {
  const f = await fixture({ bookmarks: [{ saved: true, icon: true, changeOnClick: false }] });
  await f.action("unsaved");
  await f.tick(4000);
  assert.equal(f.clicks, 1);
  assert.equal(f.bookmarkControls[0].saved, true);
  assert.equal(f.count("decision"), 0);
  assert.equal(f.element("bar").hidden, false);
  assert.match(f.element("status").textContent, /Couldn’t verify the bookmark changed/);
  await f.action("later");
  assert.equal(f.messages.find(message => message.type === "decision").decision, "later");
  assert.equal(f.clicks, 1);
});

test("Restore saves the DOM bookmark, confirms restoration, and allows a review decision", async () => {
  const f = await fixture({ bookmarks: [{ saved: false, icon: true }], state: { restoring: true } });
  assert.equal(f.clicks, 1);
  assert.equal(f.count("restored"), 0);
  assert.equal(f.element("progress").textContent, "Undo unsave");
  await f.tick(160);
  assert.equal(f.bookmarkControls[0].saved, true);
  assert.equal(f.count("restored"), 1);
  assert.equal(f.count("decision"), 0);
  assert.equal(f.element("restore").hidden, true);
  assert.equal(f.element("bar").hidden, false);
  assert.equal(f.element("status").textContent, "Saved again. Choose Keep, Unsave, or Review later.");
  await f.action("kept");
  assert.equal(f.messages.find(message => message.type === "decision").decision, "kept");
  assert.equal(f.clicks, 1);
});

test("Failed restore preserves the retry flow and confirms only after a successful save", async () => {
  const control = { saved: false, changeOnClick: false };
  const f = await fixture({ bookmarks: [control], state: { restoring: true } });
  await f.tick(4000);
  assert.equal(f.count("restored"), 0);
  assert.equal(f.count("decision"), 0);
  assert.equal(f.bookmarkControls[0].saved, false);
  assert.equal(f.element("restore").hidden, false);
  assert.match(f.element("status").textContent, /Couldn’t verify the bookmark changed/);
  control.changeOnClick = true;
  await f.retrySave();
  await f.tick(160);
  assert.equal(f.clicks, 2);
  assert.equal(f.bookmarkControls[0].saved, true);
  assert.equal(f.count("restored"), 1);
  assert.equal(f.element("restore").hidden, true);
});

test("Detection confirms the error phrase for 1200ms, logs its signal once, and never clicks", async () => {
  const f = await fixture();
  await f.tick(1199);
  assert.equal(f.count("unavailable"), 0);
  await f.tick(1);
  assert.equal(f.count("unavailable"), 1);
  await f.tick(10000);
  assert.equal(f.count("unavailable"), 1);
  assert.equal(f.debug.length, 1);
  assert.match(f.debug[0], /text: this page isn't available/);
  assert.equal(f.clicks, 0);
  assert.equal(f.count("decision"), 0);
});

test("Detection normalizes curly apostrophes and case", async () => {
  const f = await fixture({ text: "Sorry, THIS PAGE ISN’T AVAILABLE." });
  await f.tick(1200);
  assert.equal(f.count("unavailable"), 1);
});

test("A navigation 404 is sufficient without error text and logs both signals when present", async () => {
  const f = await fixture({ text: "", responseStatus: 404 });
  await f.tick(1200);
  assert.equal(f.count("unavailable"), 1);
  assert.match(f.debug[0], /navigation: 404/);
  const g = await fixture({ responseStatus: 404 });
  await g.tick(1200);
  assert.match(g.debug[0], /text: this page isn't available, navigation: 404/);
});

test("A merely loading page with no error signal is never marked unavailable", async () => {
  const f = await fixture({ text: "Loading…" });
  await f.tick(11000);
  assert.equal(f.count("unavailable"), 0);
  assert.equal(f.debug.length, 0);
});

test("Transient error signals must persist through a second confirmation window", async () => {
  const f = await fixture();
  await f.tick(900);
  f.document.body.innerText = "Loading…";
  await f.tick(300);
  assert.equal(f.count("unavailable"), 0);
  f.document.body.innerText = errorText;
  await f.tick(1499);
  assert.equal(f.count("unavailable"), 0);
  await f.tick(1);
  assert.equal(f.count("unavailable"), 1);
});

test("Visible video or a large image prevents unavailable detection even with error signals", async () => {
  for (const type of ["video", "image"]) {
    const f = await fixture({ responseStatus: 404 });
    await f.tick(900);
    if (type === "video") f.video();
    else f.image(200, 200);
    await f.tick(11000);
    assert.equal(f.count("unavailable"), 0);
    assert.equal(f.count("available"), 1);
  }
});

test("Small avatars do not count as large media for unavailable detection", async () => {
  const f = await fixture();
  f.image(50, 50);
  await f.tick(1200);
  assert.equal(f.count("unavailable"), 1);
});

test("Ordinary Instagram browsing never starts detection", async () => {
  const f = await fixture({ state: { current: false, queued: false, detectUnavailable: false } });
  await f.tick(11000);
  assert.equal(f.count("unavailable"), 0);
  assert.equal(f.navigationReads, 0);
});

test("Hidden waiting tabs detect errors with timers throttled to one-second intervals", async () => {
  const f = await fixture({ hidden: true, throttle: true, state: { current: false, queued: true } });
  await f.tick(1999);
  assert.equal(f.count("unavailable"), 0);
  await f.tick(1);
  assert.equal(f.count("unavailable"), 1);
  assert.equal(f.count("available"), 0);
});

test("Restoring and re-reviewing Undo tabs ignore unavailable detection", async () => {
  for (const state of [{ restoring: true }, { rereviewing: true, detectUnavailable: false }]) {
    const f = await fixture({ hidden: true, state });
    await f.tick(11000);
    assert.equal(f.count("unavailable"), 0);
    assert.equal(f.navigationReads, 0);
  }
});

test("Detection stops after its ten-second window and checks only the first 3000 text characters", async () => {
  const f = await fixture({ text: "Loading…" });
  await f.tick(11000);
  const reads = f.navigationReads;
  f.document.body.innerText = errorText;
  await f.tick(3000);
  assert.equal(f.count("unavailable"), 0);
  assert.equal(f.navigationReads, reads);
  const g = await fixture({ text: " ".repeat(3001) + errorText });
  await g.tick(11000);
  assert.equal(g.count("unavailable"), 0);
});

test("A visible available item shows the side note for four seconds without moving the bar", async () => {
  const f = await fixture({ text: "A real reel", media: true, state: { notice: 2 }, position: { x: 0.2, y: 0.4 } });
  const note = f.element("unavailable-notice");
  const barStyle = structuredClone(f.element("bar").style);
  assert.equal(note.textContent, "2 saved items were unavailable and were skipped.");
  assert.equal(note.hidden, false);
  assert.equal(f.count("noticeShown"), 1);
  assert.equal(f.count("available"), 1);
  await f.refresh();
  assert.equal(f.count("available"), 1);
  assert.deepEqual(f.element("bar").style, barStyle);
  assert.equal(f.element("bar").hidden, false);
  await f.tick(3999);
  assert.equal(note.hidden, false);
  await f.tick(1);
  assert.equal(note.hidden, true);
  assert.match(f.shadow.innerHTML, /prefers-reduced-motion: reduce/);
  assert.match(f.shadow.innerHTML, /role="status" aria-live="polite"/);
});

test("A second side note replaces its text and restarts the lifetime", async () => {
  const f = await fixture({ media: true, state: { notice: 1 } });
  const note = f.element("unavailable-notice");
  assert.equal(note.textContent, "The previous saved item was unavailable and was skipped.");
  await f.tick(2000);
  f.state.notice = 3;
  await f.refresh();
  assert.equal(note.textContent, "3 saved items were unavailable and were skipped.");
  await f.tick(2000);
  assert.equal(note.hidden, false);
  await f.tick(2000);
  assert.equal(note.hidden, true);
});

test("A hidden available item keeps its notice until it becomes visible", async () => {
  const f = await fixture({ hidden: true, media: true, state: { notice: 1 } });
  assert.equal(f.count("noticeShown"), 0);
  assert.equal(f.count("available"), 0);
  await f.visible();
  assert.equal(f.count("noticeShown"), 1);
  assert.equal(f.count("available"), 1);
  assert.equal(f.element("unavailable-notice").hidden, false);
});

test("Waiting available tabs acknowledge successful display only after becoming current", async () => {
  const f = await fixture({ media: true, state: { current: false, queued: true, notice: 1 } });
  assert.equal(f.count("noticeShown"), 0);
  assert.equal(f.count("available"), 0);
  f.state.current = true;
  await f.refresh();
  assert.equal(f.count("noticeShown"), 1);
  assert.equal(f.count("available"), 1);
});

test("Unavailable pages do not consume notices intended for the next real item", async () => {
  const f = await fixture({ state: { notice: 2 } });
  await f.tick(1200);
  assert.equal(f.count("unavailable"), 1);
  assert.equal(f.count("noticeShown"), 0);
  assert.equal(f.element("unavailable-notice").hidden, true);
});

test("The last automatic skip displays its notice in the finished panel", async () => {
  const f = await fixture({ state: { notice: 1 }, unavailableResult: { done: true, canUndo: false, notice: 2 } });
  await f.tick(1200);
  assert.equal(f.element("progress").textContent, "Review queue complete");
  assert.equal(f.element("status").textContent, "2 saved items were unavailable and were skipped.");
  assert.equal(f.element("unavailable-notice").hidden, true);
  assert.equal(f.count("noticeShown"), 1);
});

test("Circuit-breaker responses display the pause explanation if the tab remains open", async () => {
  const message = "10 items in a row looked unavailable. You may be logged out or Instagram may be limiting this account. Check Instagram, then resume.";
  const f = await fixture({ unavailableResult: { paused: true, message } });
  await f.tick(1200);
  assert.equal(f.element("progress").textContent, "Review paused");
  assert.equal(f.element("status").textContent, message);
});

test("Navigating away invalidates a pending unavailable confirmation", async () => {
  const f = await fixture();
  await f.tick(900);
  f.location.pathname = "/reel/b/";
  f.state.detectUnavailable = false;
  f.state.current = false;
  await f.tick(1000);
  assert.equal(f.count("unavailable"), 0);
});

test("Media arriving after detection times out still counts as successfully shown and receives its notice", async () => {
  const f = await fixture({ text: "Loading…", state: { notice: 1 } });
  await f.tick(11000);
  assert.equal(f.count("unavailable"), 0);
  await f.mediaEvent("loadedmetadata", f.video());
  assert.equal(f.count("available"), 1);
  assert.equal(f.count("noticeShown"), 1);
  assert.equal(f.element("unavailable-notice").hidden, false);
});

test("A stale navigation 404 from another SPA route cannot flag a merely loading item", async () => {
  const f = await fixture({ text: "Loading…", responseStatus: 404, navigationName: "https://www.instagram.com/reel/previous/" });
  await f.tick(11000);
  assert.equal(f.count("unavailable"), 0);
  const g = await fixture({ text: "", responseStatus: 404, navigationName: "https://www.instagram.com/reel/a/" });
  await g.tick(1200);
  assert.equal(g.count("unavailable"), 1);
});

test("An error rendered after the initial ten-second window is still confirmed and skipped", async () => {
  const f = await fixture({ text: "Loading…" });
  await f.tick(11000);
  f.document.body.innerText = errorText;
  await f.mutate();
  await f.tick(1499);
  assert.equal(f.count("unavailable"), 0);
  await f.tick(1);
  assert.equal(f.count("unavailable"), 1);
});

test("An error replacing briefly visible media at the same URL re-arms detection", async () => {
  const f = await fixture({ text: "Loading…", media: true });
  assert.equal(f.count("available"), 1);
  await f.tick(2000);
  f.media.length = 0;
  f.document.body.innerText = errorText;
  await f.mutate();
  await f.tick(1500);
  assert.equal(f.count("unavailable"), 1);
});

test("Line-wrapped error headings are recognized without widening the error phrases", async () => {
  const f = await fixture({ text: "Sorry, this page\nisn’t\u00a0available." });
  await f.tick(1200);
  assert.equal(f.count("unavailable"), 1);
});

test("Render observers remain disabled on ordinary browsing and both Undo states", async () => {
  for (const state of [
    { current: false, queued: false, detectUnavailable: false },
    { restoring: true },
    { rereviewing: true, detectUnavailable: false }
  ]) {
    const f = await fixture({ state, hidden: true });
    assert.equal(f.observerCount, 0);
    await f.mutate();
    await f.tick(12000);
    assert.equal(f.count("unavailable"), 0);
  }
});

test("Render changes cannot override visible-media safeguards", async () => {
  const f = await fixture({ text: "A real reel", media: true });
  f.document.body.innerText = errorText;
  await f.mutate();
  await f.tick(1500);
  assert.equal(f.count("unavailable"), 0);
  assert.equal(f.count("available"), 1);
});

test("Late transient error renders still require persistent confirmation", async () => {
  const f = await fixture({ text: "Loading…" });
  await f.tick(11000);
  f.document.body.innerText = errorText;
  await f.mutate();
  await f.tick(900);
  f.document.body.innerText = "Loading…";
  await f.mutate();
  await f.tick(1500);
  assert.equal(f.count("unavailable"), 0);
});

test("Losing queue authorization disconnects the observer and cancels its pending check", async () => {
  const f = await fixture({ text: "Loading…" });
  await f.tick(11000);
  assert.equal(f.observerCount, 1);
  f.document.body.innerText = errorText;
  await f.mutate();
  f.state.current = false;
  f.state.detectUnavailable = false;
  await f.refresh();
  assert.equal(f.observerCount, 0);
  await f.tick(1500);
  assert.equal(f.count("unavailable"), 0);
});

test("Late-render detection works in hidden waiting tabs with throttled timers", async () => {
  const f = await fixture({ text: "Loading…", hidden: true, throttle: true, state: { current: false, queued: true } });
  await f.tick(12000);
  f.document.body.innerText = errorText;
  await f.mutate();
  await f.tick(3000);
  assert.equal(f.count("unavailable"), 1);
});

test("Evidence arriving near the polling deadline still receives its confirmation check", async () => {
  const f = await fixture({ text: "Loading…" });
  await f.tick(9600);
  f.document.body.innerText = errorText;
  await f.tick(1499);
  assert.equal(f.count("unavailable"), 0);
  await f.tick(1);
  assert.equal(f.count("unavailable"), 1);
});

test("A failed unavailable handoff remains visible even when an intervening state refresh hid the bar", async () => {
  const f = await fixture({ loseQueueWhileReporting: true,
    unavailableResult: { error: "Simulated navigation failure" } });
  await f.tick(1200);
  assert.equal(f.element("bar").hidden, false);
  assert.equal(f.host.isConnected, true);
  assert.match(f.element("status").textContent, /Simulated navigation failure/);
});

test("Reloading a failed review page displays its persisted handoff error instead of hiding the bar", async () => {
  const f = await fixture({ state: { current: false, queued: true, detectUnavailable: false,
    reviewError: "Couldn’t open the next review item: Simulated navigation failure" } });
  assert.equal(f.element("bar").hidden, false);
  assert.equal(f.element("progress").textContent, "Review interrupted");
  assert.match(f.element("status").textContent, /Return to review/);
  await f.tick(2000);
  assert.equal(f.count("unavailable"), 0);
});

test("An authorized redirected profile error uses the same two-check detector without manual review actions", async () => {
  const f = await fixture({ url: "https://www.instagram.com/wholelottawindy/",
    state: { current: false, queued: true, detectUnavailable: true, redirected: true } });
  await f.tick(1199);
  assert.equal(f.count("unavailable"), 0);
  await f.tick(1);
  assert.equal(f.count("unavailable"), 1);
  assert.equal(f.element("bar").hidden, true);
  assert.equal(f.clicks, 0);
});

test("A normal profile page remains excluded without redirect authorization", async () => {
  const f = await fixture({ url: "https://www.instagram.com/wholelottawindy/",
    state: { current: false, queued: false, detectUnavailable: false } });
  await f.tick(3000);
  assert.equal(f.count("unavailable"), 0);
  assert.equal(f.observerCount, 0);
});

test("Visible media reports readiness for hidden preloads before they become the shown item", async () => {
  const f = await fixture({ media: true, hidden: true, state: { current: false, queued: true } });
  assert.equal(f.count("pageAvailable"), 1);
  assert.equal(f.count("available"), 0);
  f.state.current = true;
  await f.visible();
  assert.equal(f.count("pageAvailable"), 1);
  assert.equal(f.count("available"), 1);
});

test("Trusted same-tab profile clicks report a browsing detour, while untrusted and new-tab clicks do not", async () => {
  const destination = "https://www.instagram.com/wholelottawindy/";
  const f = await fixture({ text: "Loading…" });
  await f.linkClick(destination, { isTrusted: false });
  await f.linkClick(destination, { ctrlKey: true });
  await f.linkClick(destination, { target: "_blank" });
  await f.linkClick("https://www.instagram.com/p/another/");
  assert.equal(f.count("browse"), 0);
  await f.linkClick(destination);
  assert.equal(f.count("browse"), 1);
});
