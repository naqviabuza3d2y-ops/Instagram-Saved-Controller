(() => {
  const UNAVAILABLE_PHRASES = ["this page isn't available"];
  const UNAVAILABLE_POLL_MS = 300;
  const UNAVAILABLE_CONFIRM_MS = 1200;
  const UNAVAILABLE_TIMEOUT_MS = 10000;
  const NOTICE_SIDE = "left";
  const NOTICE_OFFSET_PX = 96;
  const NOTICE_DURATION_MS = 4000;
  let current = false;
  let canUndo = false;
  let restoring = false;
  let attemptedRestore = false;
  let busy = false;
  let muted = false;
  let audioBusy = false;
  let drag;
  let page = location.href;
  let detection;
  let pendingNotice = 0;
  let noticeBusy = false;
  let noticeTimer;
  let noticeHideTimer;
  let finished = false;
  let finishedNote = "";
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      section { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        width: max-content; max-width: calc(100vw - 24px); pointer-events: auto;
        background: #192420; color: #f2f8f4; border: 1px solid #53665b; border-radius: 14px;
        box-shadow: 0 6px 24px #0006; padding: 12px; font: 14px system-ui; text-align: center; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      nav { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 8px; }
      button { color: inherit; background: #304239; border: 0; border-radius: 8px;
        padding: 8px 10px; font: inherit; white-space: nowrap; cursor: pointer; }
      button:hover { background: #435d50; }
      button[data-action="unsaved"] { background: #783e36; }
      #grip { cursor: grab; touch-action: none; user-select: none; padding: 4px 8px; }
      #grip:active { cursor: grabbing; }
      #audio { padding: 4px 8px; }
      button:disabled { opacity: .55; cursor: wait; }
      [role="status"]:empty { display: none; }
      [role="status"] { margin-top: 8px; }
      #unavailable-notice { position: fixed; ${NOTICE_SIDE}: ${NOTICE_OFFSET_PX}px; top: 50%;
        transform: translateY(-50%); max-width: 260px; margin: 0; padding: 12px 14px;
        border: 1px solid #53665b; border-radius: 10px; background: #192420; color: #f2f8f4;
        box-shadow: 0 6px 24px #0006; font: 14px system-ui; pointer-events: none;
        opacity: 0; transition: opacity 160ms ease; }
      #unavailable-notice[data-visible] { opacity: 1; }
      @media (prefers-reduced-motion: reduce) { #unavailable-notice { transition: none; } }
      [hidden] { display: none !important; }
    </style>
    <section id="bar" aria-label="Instagram saved review">
      <header>
        <button id="grip" aria-label="Move review bar" title="Drag to move, or use arrow keys">⠿</button>
        <div id="progress"></div>
        <button id="audio" aria-keyshortcuts="M" aria-label="Mute video" title="Mute video (M)">Mute</button>
      </header>
      <nav aria-label="Review actions">
        <button data-action="kept">Keep · K</button>
        <button data-action="unsaved">Unsave · D</button>
        <button data-action="later">Review later · J</button>
        <button id="undo" aria-keyshortcuts="Control+Z" title="Undo last unsave (Ctrl+Z)" disabled>Undo</button>
      </nav>
      <button id="restore" hidden>Retry save</button>
      <div role="status"></div>
    </section>
    <div id="unavailable-notice" role="status" aria-live="polite" hidden></div>`;
  const bar = shadow.querySelector("#bar");
  const notice = shadow.querySelector("#unavailable-notice");
  const buttons = [...shadow.querySelectorAll("[data-action]")];
  const grip = shadow.querySelector("#grip");
  const audio = shadow.querySelector("#audio");
  const undo = shadow.querySelector("#undo");
  const restore = shadow.querySelector("#restore");
  const nav = shadow.querySelector("nav");
  const progress = shadow.querySelector("#progress");
  const status = bar.querySelector('[role="status"]');
  const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, page: location.href, ...extra });
  const positionKey = "reviewBarPosition";

  function place(position) {
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
    const x = Math.min(1, Math.max(0, position.x)) * 100;
    const y = Math.min(1, Math.max(0, position.y)) * 100;
    bar.style.left = `${x}%`;
    bar.style.top = `${y}%`;
    bar.style.bottom = "auto";
    bar.style.transform = `translate(-${x}%, -${y}%)`;
  }

  function move(left, top) {
    const rect = bar.getBoundingClientRect();
    const position = {
      x: Math.min(1, Math.max(0, left / Math.max(1, innerWidth - rect.width))),
      y: Math.min(1, Math.max(0, top / Math.max(1, innerHeight - rect.height)))
    };
    place(position);
    return position;
  }

  function savePosition(position) {
    chrome.storage.local.set({ [positionKey]: position }).catch(console.error);
  }

  chrome.storage.local.get(positionKey).then(values => {
    if (!drag) place(values[positionKey]);
  }).catch(console.error);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && !drag && changes[positionKey]) place(changes[positionKey].newValue);
  });

  grip.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = bar.getBoundingClientRect();
    drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener("pointermove", event => {
    if (!drag || !grip.hasPointerCapture(event.pointerId)) return;
    drag.position = move(event.clientX - drag.x, event.clientY - drag.y);
  });
  grip.addEventListener("lostpointercapture", () => {
    if (drag?.position) savePosition(drag.position);
    drag = undefined;
  });
  grip.addEventListener("keydown", event => {
    const offset = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
    if (!offset) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = bar.getBoundingClientRect();
    savePosition(move(rect.left + offset[0], rect.top + offset[1]));
  });

  function showActions(reviewing) {
    for (const button of buttons) button.hidden = !reviewing;
    undo.disabled = !canUndo;
    undo.hidden = !reviewing && !canUndo;
    nav.style.display = reviewing || canUndo ? "" : "none";
    audio.hidden = !reviewing;
    restore.hidden = true;
  }

  function hideReview() {
    bar.hidden = true;
    if (notice.hidden) host.remove();
  }

  const noticeText = count => count === 1
    ? "The previous saved item was unavailable and was skipped."
    : `${count} saved items were unavailable and were skipped.`;

  function showNotice(count) {
    clearTimeout(noticeTimer);
    clearTimeout(noticeHideTimer);
    notice.textContent = noticeText(count);
    notice.hidden = false;
    notice.setAttribute("data-visible", "");
    if (!host.isConnected) document.documentElement.append(host);
    noticeTimer = setTimeout(() => {
      notice.removeAttribute("data-visible");
      noticeHideTimer = setTimeout(() => {
        notice.hidden = true;
        if (bar.hidden) host.remove();
      }, 160);
    }, NOTICE_DURATION_MS - 160);
  }

  async function deliverNotice() {
    if (!pendingNotice || noticeBusy || document.hidden ||
        (!finished && (!current || !detection?.available))) return;
    const count = pendingNotice;
    const expectedPage = location.href;
    pendingNotice = 0;
    noticeBusy = true;
    if (finished) status.textContent = finishedNote = noticeText(count);
    else showNotice(count);
    try {
      const result = await send("noticeShown", { notice: count });
      if (location.href === expectedPage) pendingNotice = result?.notice ?? 0;
    } finally {
      noticeBusy = false;
    }
    if (pendingNotice && location.href === expectedPage) await deliverNotice();
  }

  function showFinished(count = 0) {
    finished = true;
    bar.hidden = false;
    if (count > 0) pendingNotice = count;
    showActions(false);
    progress.textContent = "Review queue complete";
    status.textContent = finishedNote;
    if (!host.isConnected) document.documentElement.append(host);
    deliverNotice().catch(console.error);
  }

  function showReviewError(message) {
    current = false;
    canUndo = false;
    finished = false;
    stopDetection();
    showActions(false);
    bar.hidden = false;
    progress.textContent = "Review interrupted";
    status.textContent = `${message} Open the extension and choose Return to review.`;
    if (!host.isConnected) document.documentElement.append(host);
  }

  async function sync() {
    const requestedPage = location.href;
    const wasReviewing = current || Boolean(detection) || finished;
    try {
      const state = await send("state");
      if (requestedPage !== location.href) return;
      if (state?.error) throw new Error(state.error);
      if (state?.reviewError) {
        showReviewError(state.reviewError);
        return;
      }
      if (state?.restoring) {
        stopDetection();
        finished = false;
        bar.hidden = false;
        current = false;
        canUndo = false;
        restoring = true;
        nav.style.display = "none";
        audio.hidden = true;
        progress.textContent = "Undo unsave";
        if (!host.isConnected) document.documentElement.append(host);
        if (!attemptedRestore && !document.hidden) restoreItem();
        return;
      }
      restoring = false;
      current = Boolean(state?.current);
      canUndo = Boolean(state?.canUndo);
      finished = Boolean(state?.finished);
      pendingNotice = state?.notice ?? 0;
      configureDetection(state);
      if (state?.finished) {
        showFinished();
        return;
      }
      if (!current) {
        hideReview();
        return;
      }
      showActions(true);
      bar.hidden = false;
      const { total, decided, later } = state.progress;
      progress.textContent = `${decided} / ${total} decided · ${later} review later`;
      if (state.rereviewing && !busy && !status.textContent) {
        status.textContent = "Reopened item. Choose Keep, Unsave, or Review later.";
      }
      if (!host.isConnected) document.documentElement.append(host);
      if (!audioBusy) setAudio(Boolean(state.muted));
    } catch (error) {
      current = false;
      canUndo = false;
      stopDetection();
      if (wasReviewing && requestedPage === location.href) showReviewError(error.message);
      else hideReview();
    }
  }

  function visible(element) {
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 &&
      bounds.top < innerHeight && bounds.right > 0 && bounds.left < innerWidth &&
      getComputedStyle(element).visibility === "visible";
  }

  function applyAudio() {
    if (!current) return;
    let video;
    let largestArea = 0;
    for (const candidate of document.querySelectorAll("video")) {
      if (!visible(candidate)) continue;
      const rect = candidate.getBoundingClientRect();
      const area = (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) *
        (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
      if (area <= largestArea) continue;
      video = candidate;
      largestArea = area;
    }
    if (!video) return;
    const silent = muted || document.hidden;
    if (video.muted !== silent) video.muted = silent;
    if (!silent && video.volume === 0) video.volume = 1;
  }

  function setAudio(value) {
    muted = value;
    const label = muted ? "Unmute" : "Mute";
    audio.textContent = label;
    audio.setAttribute("aria-label", `${label} video`);
    audio.title = `${label} video (M)`;
    applyAudio();
  }

  async function toggleAudio() {
    if (!current || audioBusy || document.hidden) return;
    audioBusy = true;
    const previous = muted;
    setAudio(!previous);
    try {
      const result = await send("audio", { muted });
      if (typeof result?.muted !== "boolean") throw new Error(result?.error || "Return to the current review item.");
    } catch (error) {
      setAudio(previous);
      status.textContent = error.message;
    } finally {
      audioBusy = false;
    }
  }

  audio.addEventListener("click", event => {
    if (event.isTrusted) toggleAudio();
  });
  document.addEventListener("visibilitychange", applyAudio);
  for (const event of ["loadedmetadata", "play", "playing"]) {
    document.addEventListener(event, event => {
      if (event.target instanceof HTMLVideoElement) {
        applyAudio();
        availableMedia(detection);
      }
    }, true);
  }
  document.addEventListener("load", event => {
    if (event.target.localName === "img") availableMedia(detection);
  }, true);

  const permalink = /^\/(?:p|reels?|tv)\/([\w-]+)\/?$/;
  const bookmarkLabels = new Map([
    ["save", false], ["save post", false], ["save reel", false],
    ["unsave", true], ["unsave post", true], ["unsave reel", true], ["remove from saved", true]
  ]);

  document.addEventListener("click", event => {
    if (!event.isTrusted || !detection || detection.page !== location.href ||
        event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || anchor.target === "_blank" || anchor.origin !== location.origin ||
        permalink.test(anchor.pathname)) return;
    // A deliberate profile detour must never become an unavailable decision for the saved item.
    send("browse").catch(() => {});
  }, true);

  function hasMedia(scope) {
    return [...scope.querySelectorAll("video, img, canvas")].some(element => {
      if (!visible(element)) return false;
      if (element.localName === "video") return true;
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height >= 120 * 120;
    });
  }

  function bookmarkScope() {
    const shortcode = permalink.exec(location.pathname)?.[1];
    if (!shortcode) return null;
    const dialogs = [...document.querySelectorAll('dialog, [role="dialog"]')]
      .filter(dialog => visible(dialog) && hasMedia(dialog));
    if (dialogs.length > 1) return null;
    const root = dialogs[0] ?? document.querySelector("main, [role='main']") ?? document;
    const articles = [...root.querySelectorAll('article, [role="article"]')].filter(visible);
    const exact = articles.filter(article => {
      const links = [...article.querySelectorAll("a[href]")].filter(anchor => permalink.test(anchor.pathname));
      return links.some(anchor => anchor.origin === location.origin && permalink.exec(anchor.pathname)[1] === shortcode) &&
        links.every(anchor => permalink.exec(anchor.pathname)[1] === shortcode);
    });
    return exact.length === 1 ? exact[0] : null;
  }

  function bookmark() {
    const scope = bookmarkScope();
    if (!scope) return null;
    const controls = new Map();
    const clickable = 'button, [role="button"], [tabindex="0"]';
    for (const labelElement of scope.querySelectorAll('[aria-label], [title], svg title')) {
      const label = (labelElement.getAttribute("aria-label") ||
        labelElement.getAttribute("title") || labelElement.textContent).trim().toLowerCase();
      const svg = labelElement.closest("svg") ?? labelElement.querySelector("svg");
      const state = label === "remove" && svg ? true : bookmarkLabels.get(label);
      if (state === undefined) continue;
      const button = svg?.closest(clickable) ?? labelElement.closest(clickable);
      if (!button || typeof button.click !== "function" || !scope.contains(button)) continue;
      if (!visible(button) || button.matches(':disabled, [aria-disabled="true"]')) continue;
      if (svg && !visible(svg)) continue;
      if (!svg && labelElement !== button) continue;
      const signals = controls.get(button) ?? { icon: new Set(), button: new Set() };
      if (svg && labelElement !== button) {
        signals.icon.add(state);
      } else {
        signals.button.add(state);
      }
      controls.set(button, signals);
    }
    if (controls.size !== 1) return null;
    const [[button, signals]] = controls;
    const states = signals.icon.size ? signals.icon : signals.button;
    if (states.size !== 1) return null;
    const saved = states.has(true) || button.getAttribute("aria-pressed") === "true";
    return { button, saved };
  }

  function stopDetection() {
    if (detection) {
      clearTimeout(detection.timer);
      clearTimeout(detection.renderTimer);
      detection.observer.disconnect();
    }
    detection = undefined;
  }

  async function availableShown(check) {
    if (check !== detection || !check.available || !current || document.hidden) return;
    if (!check.acknowledged) {
      check.acknowledged = true;
      try {
        const result = await send("available");
        if (result?.ignored || result?.current === false || result?.error) return;
      } catch {
        check.acknowledged = false;
        return;
      }
    }
    if (check === detection && check.page === location.href) await deliverNotice();
  }

  async function reportUnavailable(check, signals) {
    console.debug("[Instagram Saved Review] Unavailable item:", signals.join(", "));
    try {
      const result = await send("unavailable");
      if (location.href !== check.page || result?.ignored) return;
      if (result?.error) throw new Error(result.error);
      if (check !== detection) return;
      current = false;
      canUndo = Boolean(result?.canUndo);
      if (result?.paused) {
        stopDetection();
        showActions(false);
        bar.hidden = false;
        progress.textContent = "Review paused";
        status.textContent = result.message;
        if (!host.isConnected) document.documentElement.append(host);
      } else if (result?.done) {
        stopDetection();
        showFinished(result.notice);
      } else {
        hideReview();
      }
    } catch (error) {
      if (location.href === check.page) showReviewError(error.message);
    }
  }

  function availableMedia(check) {
    if (!check || check !== detection || check.page !== location.href || check.reporting) return false;
    if (!bookmark() && !hasMedia(document)) return false;
    clearTimeout(check.timer);
    check.available = true;
    check.stopped = true;
    if (!check.readinessSent) {
      check.readinessSent = true;
      send("pageAvailable").catch(() => { check.readinessSent = false; });
    }
    availableShown(check).catch(console.error);
    return true;
  }

  function unavailableSignals() {
    const text = (document.body?.innerText ?? "").slice(0, 3000)
      .replace(/’/g, "'").replace(/\s+/g, " ").toLowerCase();
    const signals = UNAVAILABLE_PHRASES.filter(phrase => text.includes(phrase)).map(phrase => `text: ${phrase}`);
    const navigation = performance.getEntriesByType("navigation")[0];
    // A navigation entry can outlive a page change made by Instagram's SPA.
    if (navigation?.responseStatus === 404 &&
        (!navigation.name || new URL(navigation.name, location.href).pathname === location.pathname)) {
      signals.push("navigation: 404");
    }
    return signals;
  }

  function resumeDetection(check) {
    if (check !== detection || check.page !== location.href || !check.stopped || check.reporting) return false;
    if (!unavailableSignals().length || bookmark() || hasMedia(document)) return false;
    check.available = false;
    check.stopped = false;
    check.since = null;
    check.deadline = Date.now() + UNAVAILABLE_TIMEOUT_MS;
    checkUnavailable(check);
    return true;
  }

  function checkUnavailable(check) {
    if (check !== detection || check.page !== location.href || check.stopped) return;
    if (availableMedia(check)) return;
    const now = Date.now();
    // Finish confirming evidence first seen near the end of the polling window.
    if (now > check.deadline && check.since === null) {
      check.stopped = true;
      return;
    }
    const signals = unavailableSignals();
    if (signals.length) {
      check.since ??= now;
      if (now - check.since >= UNAVAILABLE_CONFIRM_MS) {
        check.stopped = true;
        check.reporting = true;
        reportUnavailable(check, signals);
        return;
      }
    } else {
      check.since = null;
    }
    check.timer = setTimeout(() => checkUnavailable(check), UNAVAILABLE_POLL_MS);
  }

  function configureDetection(state) {
    if (!state?.detectUnavailable || state.restoring || state.rereviewing) {
      stopDetection();
      return;
    }
    if (detection?.page !== location.href) {
      stopDetection();
      const check = { page: location.href, deadline: Date.now() + UNAVAILABLE_TIMEOUT_MS, since: null };
      check.observer = new MutationObserver(() => {
        if (check !== detection || !check.stopped || check.reporting || check.renderTimer !== undefined) return;
        // Instagram may replace the initial render with an error at the same URL.
        check.renderTimer = setTimeout(() => {
          check.renderTimer = undefined;
          resumeDetection(check);
        }, UNAVAILABLE_POLL_MS);
      });
      detection = check;
      check.observer.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["class", "style", "hidden", "src"]
      });
      checkUnavailable(check);
    } else if (resumeDetection(detection)) {
      return;
    } else if (detection.available) {
      availableShown(detection).catch(console.error);
    } else if (detection.stopped) {
      availableMedia(detection);
    }
  }

  async function setBookmark(saved, expectedPage) {
    let control = bookmark();
    for (let attempt = 0; !control && attempt < (saved ? 30 : 15); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (location.href !== expectedPage || document.hidden) throw new Error("Return to the item and try again.");
      control = bookmark();
    }
    if (!control) {
      throw new Error(saved
        ? "Bookmark unavailable. Try saving in Instagram, then choose Retry save."
        : "Bookmark unavailable. Try Instagram’s bookmark directly, then press Unsave here if it can be verified, or Review later.");
    }
    if (control.saved === saved) return;
    control.button.click();
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 160));
      if (location.href !== expectedPage) break;
      if (bookmark()?.saved === saved) return;
    }
    throw new Error("Couldn’t verify the bookmark changed. Check Instagram before trying again.");
  }

  async function restoreItem() {
    if (!restoring || busy || document.hidden) return;
    attemptedRestore = true;
    busy = true;
    restore.hidden = true;
    status.textContent = "Saving this item again…";
    const expectedPage = location.href;
    try {
      await setBookmark(true, expectedPage);
      if (location.href !== expectedPage) throw new Error("Return to the item to finish restoring it.");
      const result = await send("restored");
      if (!result?.restored) throw new Error(result?.error || "The undo tab changed. Try Undo again.");
      restoring = false;
      attemptedRestore = false;
      status.textContent = "Saved again. Choose Keep, Unsave, or Review later.";
      await sync();
    } catch (error) {
      status.textContent = error.message;
      restore.hidden = false;
    } finally {
      busy = false;
    }
  }

  async function beginUndo() {
    if (!canUndo || busy || document.hidden) return;
    busy = true;
    try {
      const result = await send("undo");
      if (result?.error) throw new Error(result.error);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      if (restoring && !attemptedRestore) restoreItem();
    }
  }

  undo.addEventListener("click", event => { if (event.isTrusted) beginUndo(); });
  restore.addEventListener("click", event => { if (event.isTrusted) restoreItem(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (restoring && !attemptedRestore) restoreItem();
    else if (!busy && (current || canUndo || detection || finished)) sync();
  });

  async function decide(decision) {
    if (!current || busy || document.hidden) return;
    busy = true;
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = decision === "unsaved" ? "Checking Instagram’s bookmark…" : "";
    const expectedPage = location.href;
    try {
      const state = await send("state");
      if (!state?.current || location.href !== expectedPage || document.hidden) {
        throw new Error("Return to the current review item.");
      }
      if (state.undoInProgress) throw new Error("Finish restoring the item before continuing.");
      if (decision === "unsaved") await setBookmark(false, expectedPage);
      const result = await send("decision", { decision });
      if (result?.error) throw new Error(result.error);
      if (result?.current === false) throw new Error("The review item changed. Open the extension to resume.");
      current = false;
      canUndo = false;
      if (result?.done) {
        canUndo = Boolean(result.canUndo);
        showFinished(result.notice);
      } else {
        hideReview();
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  for (const button of buttons) {
    button.addEventListener("click", event => {
      if (event.isTrusted) decide(button.dataset.action);
    });
  }
  window.addEventListener("keydown", event => {
    if (busy || !event.isTrusted || event.repeat || event.altKey || event.shiftKey ||
        event.target.closest?.('input, textarea, select, [contenteditable], [role="textbox"]')) return;
    const key = event.key.toLowerCase();
    if (canUndo && event.ctrlKey && !event.metaKey && key === "z") {
      event.preventDefault();
      event.stopImmediatePropagation();
      beginUndo();
      return;
    }
    if (!current || event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    const decision = { k: "kept", d: "unsaved", j: "later" }[key];
    const audioKey = key === "m";
    if (!decision && !audioKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (audioKey) toggleAudio();
    else decide(decision);
  }, true);
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "refresh") sync();
  });
  window.addEventListener("popstate", sync);
  window.addEventListener("pageshow", sync);
  // Instagram can change pages without reloading the content script.
  setInterval(() => {
    if (location.href === page) return;
    page = location.href;
    current = false;
    canUndo = false;
    restoring = false;
    attemptedRestore = false;
    stopDetection();
    finished = false;
    finishedNote = "";
    pendingNotice = 0;
    status.textContent = "";
    hideReview();
    sync();
  }, 500);
  sync();
})();
