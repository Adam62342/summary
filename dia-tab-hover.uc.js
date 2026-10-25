// ==UserScript==
// @name           Dia Swipe
// @description    Dia-style swipe back/forward bubble; hold to scrub through history
// @include        main
// ==/UserScript==

(function () {
  "use strict";
  if (window.DiaSwipe) return;

  // ---- Tuning -------------------------------------------------------------
  // Firefox's swipe tracker reports `delta` as a fraction of a page width.
  // It commits navigation at 0.25, so that's where the bubble "arms".
  const ARM_AT = 0.25;
  const HOLD_DELAY_MS = 380; // how long you must sit still to open the list
  const STILL_EPS = 0.02; // movement smaller than this counts as "holding"
  const MAX_ROWS = 50;

  // Scrolling the list: the highlight stays put and the list slides under it.
  // Firefox's swipe tracker only reports sideways movement, so the list is
  // scrolled with ordinary two-finger scrolling once you lift your fingers.
  const WHEEL_ROW_PX = 38; // vertical scroll distance per row
  const MAGNET = 0.85; // 0 = no detents, 1 = strong pull toward each row while moving
  const SNAP_SPEED = 6; // rows/sec; below this the list snaps fully onto the nearest row
  const SPEED_SMOOTH_MS = 70; // how quickly the scroll-speed estimate reacts
  const SMOOTH_MS = 55; // how quickly the list catches up with your fingers
  const SNAP_MS = 90; // how quickly it settles onto a row once you slow down
  const RUBBER = 0.85; // how far (in rows) the list stretches past either end
  const OVERSCROLL = 1.5; // rows of scrolling banked past either end at most

  // Sideways movement: a slight shift of the card, or dismissal.
  const NUDGE_MAX = 16; // px the card can shift sideways
  const DISMISS_AT = 0.15; // while holding: swipe back to here (below the arm point) to dismiss
  const DISMISS_PX = 90; // after lifting: sideways scroll toward the edge to dismiss
  const SETTLE_MS = 90; // no scrolling for this long: overscroll and shift spring back
  const SPRING_MS = 120; // how quickly they spring back

  // Card layout
  const BUBBLE = 50; // keep in sync with .dia-swipe-bubble size in CSS
  const ROW_H = 46; // keep in sync with .dia-swipe-row height in CSS
  const PAD = 7;
  const ROWS_ABOVE = 1; // newer entries visible above the highlight
  const ROWS_BELOW = 3; // older entries visible below it

  // While the list is open and your fingers are still down, make Firefox's
  // swipe tracker report the real finger position. Normally it pins the value
  // just under the threshold whenever your fingers move back, and lets speed
  // decide the outcome. With these, lifting your fingers above the threshold
  // always "succeeds" (the list stays up), and below it always springs back
  // (we dismiss). Restored as soon as the swipe ends.
  const SWIPE_PREFS = {
    "widget.swipe.velocity-twitch-tolerance": "1000000",
    "widget.swipe.success-velocity-contribution": "0",
  };

  const BACK = "Browser:BackOrBackDuplicate";
  const FORWARD = "Browser:ForwardOrForwardDuplicate";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const PREF = "mod.diaswipe.";

  const boolPref = (name, def) => {
    try {
      return Services.prefs.getBoolPref(PREF + name, def);
    } catch (e) {
      return def;
    }
  };

  // ---- Haptics ------------------------------------------------------------
  // macOS: call NSHapticFeedbackManager through js-ctypes, since Gecko doesn't
  // expose trackpad haptics to chrome JS. Pattern 1 = "alignment" (a light
  // tick), 2 = "level change". Only fires on a Force Touch trackpad with
  // fingers down.
  const HAPTIC_TICK = 1;
  const HAPTIC_STRONG = 2;

  // Built lazily on first use so a ctypes problem can't affect startup.
  let haptic = null;
  function loadHaptic() {
    if (Services.appinfo.OS !== "Darwin") return () => {};
    try {
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      const objc = ctypes.open("/usr/lib/libobjc.A.dylib");
      const id = ctypes.voidptr_t;
      const getClass = objc.declare("objc_getClass", ctypes.default_abi, id, ctypes.char.ptr);
      const sel = objc.declare("sel_registerName", ctypes.default_abi, id, ctypes.char.ptr);
      const send = objc.declare("objc_msgSend", ctypes.default_abi, id, id, id);
      const sendPerform = objc.declare(
        "objc_msgSend",
        ctypes.default_abi,
        ctypes.void_t,
        id,
        id,
        ctypes.long,
        ctypes.unsigned_long
      );
      const cls = getClass("NSHapticFeedbackManager");
      if (cls.isNull()) return () => {};
      const performer = send(cls, sel("defaultPerformer"));
      const perform = sel("performFeedbackPattern:performanceTime:");
      // performanceTime 1 = NSHapticFeedbackPerformanceTimeNow
      return pattern => sendPerform(performer, perform, pattern, 1);
    } catch (e) {
      console.warn("Dia Swipe: haptics unavailable", e);
      return () => {};
    }
  }

  const buzz = pattern => {
    if (!boolPref("haptics", true)) return;
    try {
      // Zen's own haptic service (used by its split view), when available.
      if (typeof Services.zen?.playHapticFeedback === "function") {
        Services.zen.playHapticFeedback();
        return;
      }
      haptic ??= loadHaptic();
      haptic(pattern);
    } catch (e) {
      console.warn("Dia Swipe: haptic call failed, disabling", e);
      haptic = () => {};
    }
  };

  // ---- Swipe tracker prefs ------------------------------------------------
  const savedSwipePrefs = new Map(); // name -> original string, or null = default

  function overrideSwipePrefs() {
    for (const [name, value] of Object.entries(SWIPE_PREFS)) {
      try {
        if (!savedSwipePrefs.has(name)) {
          savedSwipePrefs.set(
            name,
            Services.prefs.prefHasUserValue(name) ? Services.prefs.getStringPref(name) : null
          );
        }
        Services.prefs.setStringPref(name, value);
      } catch (e) {
        console.warn("Dia Swipe: couldn't adjust", name, e);
      }
    }
  }

  function restoreSwipePrefs() {
    for (const [name, original] of savedSwipePrefs) {
      try {
        if (original === null) Services.prefs.clearUserPref(name);
        else Services.prefs.setStringPref(name, original);
      } catch (e) {}
    }
    savedSwipePrefs.clear();
  }

  // ---- DOM helpers --------------------------------------------------------
  function h(tag, attrs = {}, ...children) {
    const ns = ["svg", "path"].includes(tag) ? SVG_NS : HTML_NS;
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  const arrowIcon = () =>
    h(
      "svg",
      { viewBox: "0 0 24 24", width: "26", height: "26", class: "dia-swipe-arrow" },
      h("path", {
        d: "M14.5 5.5 8 12l6.5 6.5",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2.4",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })
    );

  // ---- History ------------------------------------------------------------
  function historyEntries(dir) {
    const step = dir === "back" ? -1 : 1;
    const out = [];
    const sh = gBrowser.selectedBrowser.browsingContext?.sessionHistory;
    if (sh) {
      for (let i = sh.index + step; i >= 0 && i < sh.count && out.length < MAX_ROWS; i += step) {
        const e = sh.getEntryAtIndex(i);
        const url = e.URI?.spec ?? "";
        out.push({ index: i, title: e.title || url, url });
      }
      return out;
    }
    // Fallback when session history lives in the content process.
    try {
      const state = JSON.parse(SessionStore.getTabState(gBrowser.selectedTab));
      const cur = state.index - 1;
      for (let i = cur + step; i >= 0 && i < state.entries.length && out.length < MAX_ROWS; i += step) {
        const e = state.entries[i];
        out.push({ index: i, title: e.title || e.url, url: e.url });
      }
    } catch (e) {}
    return out;
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return "";
    }
  }

  // Pinned tabs: when one is restored (reopened after being unloaded, after a
  // restart, or reset to its pinned page), start it with no back history.
  function onTabRestored(e) {
    const tab = e.target;
    if (!tab?.pinned || !boolPref("clear_pinned_history", true)) return;
    try {
      const sh = tab.linkedBrowser?.browsingContext?.sessionHistory;
      // Removes the entries before the current one; forward history stays.
      if (sh && sh.index > 0) sh.purgeHistory(sh.index);
    } catch (err) {
      console.warn("Dia Swipe: couldn't clear pinned tab history", err);
    }
  }

  // ---- State ----------------------------------------------------------------
  // `s` is the current swipe gesture.
  let s = null;
  let gestureOutside = false; // current swipe started outside the web page

  // Only swipes over the web page count; the sidebar and toolbars are left to
  // Zen (e.g. its workspace-switching swipe).
  function overContent(e) {
    const panels = document.getElementById("tabbrowser-tabpanels") || gBrowser.tabpanels;
    if (!panels) return true;
    const t = e.target;
    if (t?.nodeType === Node.ELEMENT_NODE && t !== document.documentElement) {
      return panels.contains(t);
    }
    const r = panels.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  function fresh() {
    return {
      root: null,
      bubble: null,
      list: null,
      track: null,
      height: 0,
      dir: null, // "back" | "forward" | null
      side: null, // "left" | "right"
      sign: 1, // sign of delta for the current direction
      mag: 0,
      armed: false,
      stillAt: 0,
      holdTimer: 0,
      width: 0,
      // History list
      open: false, // history list is showing
      parked: false, // fingers lifted; the list stays up and takes scrolling
      dismissed: false, // list was swiped away; ignore the rest of this gesture
      entries: [],
      rows: [],
      anchor: 0, // swipe position when the list opened
      pos: 0, // scroll position, in rows
      display: 0, // where the list is drawn, in rows (eased)
      lastRaw: 0,
      speed: 0, // smoothed scroll speed, rows/sec
      hx: 0, // after lifting: sideways scroll toward the edge, px
      nx: 0, // sideways shift of the card as drawn, px (eased)
      wheelYAt: 0,
      wheelXAt: 0,
      sel: 0,
      raf: 0,
      lastFrame: 0,
      committed: false,
    };
  }

  function directionFor(event, delta) {
    if (!delta) return null;
    const ltr = gHistorySwipeAnimation.isLTR;
    const swipeDir = (delta < 0) === ltr ? "right" : "left";
    const cmd = gGestureSupport._getCommand(event, ["swipe", swipeDir]);
    const nav = gBrowser.webNavigation;
    if (cmd === BACK && nav.canGoBack) return "back";
    if (cmd === FORWARD && nav.canGoForward && boolPref("forward", true)) return "forward";
    return null;
  }

  // ---- Bubble ---------------------------------------------------------------
  // The overlay is a fixed-position box laid exactly over the visible page,
  // so it doesn't depend on how Zen lays out the browser container.
  function mount() {
    const rect = gBrowser.selectedBrowser.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    s.list = h("div", { class: "dia-swipe-list" });
    // Focusable so it can take arrow keys / Return / Escape once parked.
    s.bubble = h("div", { class: "dia-swipe-bubble", tabindex: "-1" }, arrowIcon(), s.list);
    s.root = h("div", { class: "dia-swipe" }, s.bubble);
    Object.assign(s.root.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    s.height = rect.height;
    s.width = rect.width;
    s.bubble.style.top = `${rect.height / 2 - BUBBLE / 2}px`;
    (document.body || document.documentElement).appendChild(s.root);
    return true;
  }

  function setSide(dir) {
    const ltr = gHistorySwipeAnimation.isLTR;
    s.side = (dir === "back") === ltr ? "left" : "right";
    s.root.setAttribute("side", s.side);
    s.root.setAttribute("nav", dir);
  }

  function setProgress(p) {
    // Slide in from just off the edge, growing as it comes.
    const x = -66 + p * 92;
    const scale = 0.55 + p * 0.45;
    const signed = s.side === "right" ? -x : x;
    s.bubble.style.transform = `translateX(${signed}px) scale(${scale})`;
    s.bubble.style.opacity = String(Math.min(1, p * 1.6));
  }

  // ---- Hold: the bubble morphs into the history list ------------------------
  function scheduleHold() {
    clearTimeout(s.holdTimer);
    if (!boolPref("hold_list", true)) return;
    s.holdTimer = setTimeout(openList, HOLD_DELAY_MS);
  }

  // Older pages sit below the highlight and newer ones above. Scrolling up
  // (natural scrolling) pulls older pages into the highlight.
  function openList() {
    if (!s || !s.armed || s.open || s.dismissed) return;
    s.entries = historyEntries(s.dir);
    const n = s.entries.length;
    if (!n) return;

    const below = Math.min(ROWS_BELOW, n - 1);
    const above = n > 1 ? ROWS_ABOVE : 0;
    const cardH = (above + 1 + below) * ROW_H + PAD * 2;
    const slotY = PAD + above * ROW_H;

    s.track = h("div", { class: "dia-swipe-track" });
    s.rows = s.entries.map((entry, i) => {
      const icon = h("img", { class: "dia-swipe-favicon", src: "page-icon:" + entry.url, alt: "" });
      icon.addEventListener("error", () => icon.setAttribute("broken", "true"));
      const row = h(
        "div",
        { class: "dia-swipe-row" },
        icon,
        h(
          "div",
          { class: "dia-swipe-text" },
          h("div", { class: "dia-swipe-title" }, entry.title),
          h("div", { class: "dia-swipe-host" }, hostOf(entry.url))
        )
      );
      row.style.top = `${slotY + i * ROW_H}px`;
      s.track.appendChild(row);
      return row;
    });
    const highlight = h("div", { class: "dia-swipe-highlight" });
    highlight.style.top = `${slotY}px`;
    s.list.replaceChildren(highlight, s.track);

    // Line the highlight up with where the bubble was, kept on screen.
    const top = Math.max(16, Math.min(s.height / 2 - (slotY + ROW_H / 2), s.height - 16 - cardH));
    s.bubble.style.setProperty("--list-h", `${cardH}px`);
    s.bubble.style.top = `${top}px`;

    setProgress(1);
    s.open = true;
    s.anchor = s.mag;
    s.pos = 0;
    s.display = 0;
    s.sel = 0;
    s.rows[0].setAttribute("selected", "true");
    s.root.setAttribute("holding", "true");
    overrideSwipePrefs();
    buzz(HAPTIC_STRONG);

    s.lastFrame = performance.now();
    s.raf = requestAnimationFrame(frame);
  }

  const rubber = d => RUBBER * (1 - 1 / (1 + d / RUBBER));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const approach = (dt, ms) => 1 - Math.exp((-dt * 1000) / ms);

  // Sideways shift: follows your fingers at first, then stiffens.
  const nudge = d => Math.sign(d) * NUDGE_MAX * (1 - 1 / (1 + Math.abs(d) / (NUDGE_MAX / 0.35)));

  // Soft detents: near a row the list moves only slightly, between rows it
  // moves faster, so it settles onto rows without ever jumping.
  function magnet(x) {
    const r = Math.round(x);
    const f = x - r; // -0.5 … 0.5
    return r + (1 - MAGNET) * f + MAGNET * 4 * f * f * f;
  }

  function frame(now) {
    const g = s;
    if (!g || !g.open) return;
    const dt = Math.min(0.05, (now - g.lastFrame) / 1000);
    g.lastFrame = now;
    const last = g.rows.length - 1;

    // Sideways: a slight shift of the card. Toward the edge also fades it,
    // as a hint that going further dismisses.
    let inward, pull;
    if (g.parked) {
      if (now - g.wheelXAt > SETTLE_MS) g.hx -= g.hx * approach(dt, SPRING_MS);
      inward = -g.hx;
      pull = g.hx / DISMISS_PX;
    } else {
      if (g.mag <= DISMISS_AT) {
        dismiss();
        return;
      }
      inward = (g.mag - g.anchor) * g.width;
      pull = (g.anchor - g.mag) / Math.max(0.05, g.anchor - DISMISS_AT);
    }
    g.nx += (nudge(inward) - g.nx) * approach(dt, SMOOTH_MS);
    const away = g.side === "right" ? -1 : 1;
    g.bubble.style.translate = `${(away * g.nx).toFixed(2)}px 0`;
    g.root.style.setProperty("--pull", clamp(pull, 0, 1).toFixed(3));

    // Vertical: once scrolling stops, overscroll springs back inside the list.
    if (now - g.wheelYAt > SETTLE_MS) {
      g.pos += (clamp(g.pos, 0, last) - g.pos) * approach(dt, SPRING_MS);
    }
    const raw = g.pos;

    // Stretch past either end. Inside the list, the magnet pulls toward rows
    // while you scroll, and once scrolling slows it snaps onto the nearest one.
    const speed = Math.abs(raw - g.lastRaw) / Math.max(dt, 0.001);
    g.lastRaw = raw;
    g.speed += (speed - g.speed) * approach(dt, SPEED_SMOOTH_MS);
    const snap = clamp(1 - g.speed / SNAP_SPEED, 0, 1);

    let target;
    if (raw < 0) target = -rubber(-raw);
    else if (raw > last) target = last + rubber(raw - last);
    else target = magnet(raw) + (Math.round(raw) - magnet(raw)) * snap;

    const ease = SMOOTH_MS + (SNAP_MS - SMOOTH_MS) * snap;
    g.display += (target - g.display) * approach(dt, ease);
    g.track.style.transform = `translateY(${(-g.display * ROW_H).toFixed(2)}px)`;

    const sel = clamp(Math.round(raw), 0, last);
    if (sel !== g.sel) {
      g.rows[g.sel]?.removeAttribute("selected");
      g.rows[sel].setAttribute("selected", "true");
      g.sel = sel;
      buzz(HAPTIC_TICK);
    }

    g.raf = requestAnimationFrame(frame);
  }

  // ---- Parked: fingers lifted, the list stays up ----------------------------
  // The swipe tracker never reports vertical movement, so the list waits for
  // your next two-finger scroll. It covers the page so that scroll (and any
  // click) comes to the list rather than the website.
  function park() {
    const g = s;
    if (!g?.open || g.parked) return;
    g.parked = true;
    g.hx = 0;
    restoreSwipePrefs();
    g.root.setAttribute("parked", "true");
    g.root.addEventListener("wheel", onWheel, { passive: false });
    g.root.addEventListener("click", onClick);
    g.root.addEventListener("keydown", onKey);
    g.bubble.focus({ preventScroll: true });
  }

  function onWheel(e) {
    const g = s;
    if (!g?.parked || e.currentTarget !== g.root) return;
    e.preventDefault();
    e.stopPropagation();
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_ROW_PX / 3 // a mouse-wheel notch is 3 lines: one row
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? WHEEL_ROW_PX * 3
          : 1;
    const now = performance.now();
    if (e.deltaY) {
      const last = g.rows.length - 1;
      g.pos = clamp(g.pos + (e.deltaY * unit) / WHEEL_ROW_PX, -OVERSCROLL, last + OVERSCROLL);
      g.wheelYAt = now;
    }
    if (e.deltaX) {
      // With natural scrolling, fingers moving left give a positive deltaX.
      // Toward the edge the bubble came from dismisses; the other way only
      // shifts the card a little.
      const towardEdge = g.side === "right" ? -e.deltaX : e.deltaX;
      g.hx = Math.max(-DISMISS_PX, g.hx + towardEdge * unit);
      g.wheelXAt = now;
      if (g.hx >= DISMISS_PX) dismiss();
    }
  }

  function onClick(e) {
    const g = s;
    if (!g?.parked) return;
    e.preventDefault();
    e.stopPropagation();
    const row = e.target.closest?.(".dia-swipe-row");
    if (row) go(g.rows.indexOf(row));
    else if (g.bubble.contains(e.target)) go();
    else dismiss(); // clicked the page around the list
  }

  function onKey(e) {
    const g = s;
    if (!g?.parked) return;
    const last = g.rows.length - 1;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        g.pos = clamp(Math.round(g.pos) + (e.key === "ArrowDown" ? 1 : -1), 0, last);
        break;
      case "Enter":
      case " ":
        go();
        break;
      case "Escape":
        dismiss();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function stopScrub(g) {
    cancelAnimationFrame(g.raf);
    g.raf = 0;
    g.open = false;
    if (g.parked) {
      g.parked = false;
      g.root.removeAttribute("parked");
      if (g.root.contains(document.activeElement)) gBrowser.selectedBrowser.focus();
    }
    restoreSwipePrefs();
  }

  // Swiped or scrolled away toward the edge: put the list away, keep the page.
  function dismiss() {
    const g = s;
    if (!g || g.dismissed) return;
    const wasParked = g.parked;
    stopScrub(g);
    g.dismissed = true;
    g.bubble.style.translate = ""; // let the dismiss animation take over
    g.root.setAttribute("dismissed", "true");
    buzz(HAPTIC_STRONG);
    // While still holding, the end of the swipe closes it.
    if (wasParked) close(200);
  }

  // Go to the highlighted page, or the one at `index`.
  function go(index) {
    const g = s;
    if (!g) return;
    const entry = g.entries[index ?? g.sel];
    stopScrub(g);
    g.dismissed = true; // nothing else should happen in this gesture
    if (entry) {
      gBrowser.selectedBrowser.gotoIndex(entry.index);
      commit();
    }
    close(120);
  }

  // ---- Lifecycle ------------------------------------------------------------
  function close(delay = 0) {
    const g = s;
    if (!g) return;
    s = null;
    clearTimeout(g.holdTimer);
    if (g.open) stopScrub(g);
    if (!g.root) return;
    setTimeout(() => {
      g.root.setAttribute("leaving", "true");
      setTimeout(() => g.root.remove(), 260);
    }, delay);
  }

  function commit() {
    if (!s || !s.root || s.committed) return;
    s.committed = true;
    s.root.setAttribute("committed", "true");
  }

  function begin() {
    close();
    s = fresh();
  }

  function update(e) {
    if (!s) s = fresh();
    if (gestureOutside || s.dismissed || s.parked) return;

    if (s.open) {
      // Measure along the original direction; only used for the sideways
      // shift and dismissal. The frame loop does the rest.
      s.mag = Math.max(0, e.delta * s.sign);
      return;
    }

    const mag = Math.abs(e.delta);
    s.mag = mag;
    const dir = directionFor(e, e.delta);
    if (dir !== s.dir) {
      s.dir = dir;
      s.armed = false;
      clearTimeout(s.holdTimer);
      if (dir) {
        if (!s.root && !mount()) return;
        s.root.removeAttribute("armed");
        setSide(dir);
      }
    }
    if (!s.root) return;
    if (!dir) {
      setProgress(0);
      return;
    }
    s.sign = Math.sign(e.delta);

    setProgress(Math.min(mag / ARM_AT, 1));

    const armed = mag >= ARM_AT;
    if (armed !== s.armed) {
      s.armed = armed;
      s.root.toggleAttribute("armed", armed);
      if (armed) {
        buzz(HAPTIC_STRONG);
        s.stillAt = mag;
        scheduleHold();
      } else {
        clearTimeout(s.holdTimer);
      }
    } else if (armed && Math.abs(mag - s.stillAt) > STILL_EPS) {
      s.stillAt = mag;
      scheduleHold();
    }
  }

  function end() {
    if (!s || s.parked) return; // a parked list outlives the swipe
    // Lifted below the threshold with the list up: it sprang back, so dismiss.
    if (s.open) dismiss();
    // Leave a moment for a late MozSwipeGesture to mark the swipe committed.
    close(s.committed ? 120 : s.dismissed ? 200 : 60);
  }

  // Firefox's "swipe succeeded" event, sent the moment fingers lift above the
  // threshold. With the list up, it stays up for scrolling instead.
  function onSwipeCommitted(e) {
    if (gestureOutside) return; // Firefox's own Back is blocked separately
    if (s && (s.open || s.dismissed)) {
      e.preventDefault();
      e.stopPropagation();
      if (s.open) park();
      return;
    }
    commit();
  }

  // Never let an error here get in the way of Firefox's own swipe handling.
  function handleEvent(e) {
    try {
      dispatch(e);
    } catch (err) {
      console.error("Dia Swipe:", err);
      close();
    }
  }

  function dispatch(e) {
    // Over a parked list, don't let a new swipe start (nobody accepts it), so
    // sideways scrolling arrives as ordinary scroll events for the list.
    if (e.type.startsWith("MozSwipeGesture") && s?.parked && s.root.contains(e.target)) {
      e.stopPropagation();
      return;
    }
    switch (e.type) {
      case "MozSwipeGestureMayStart":
        gestureOutside = !overContent(e);
        break;
      case "MozSwipeGestureStart":
        gestureOutside = !overContent(e);
        begin();
        break;
      case "MozSwipeGestureUpdate":
        update(e);
        break;
      case "MozSwipeGestureEnd":
        end();
        break;
      case "MozSwipeGesture":
        onSwipeCommitted(e);
        break;
      case "TabSelect":
      case "resize":
        if (s?.open) close();
        break;
      case "SSTabRestored":
        onTabRestored(e);
        break;
    }
  }

  const EVENTS = [
    "MozSwipeGestureMayStart",
    "MozSwipeGestureStart",
    "MozSwipeGestureUpdate",
    "MozSwipeGestureEnd",
    "MozSwipeGesture",
  ];

  // Stop Firefox's own swipe-to-go-back for swipes that started outside the
  // page, or while the list is handling the gesture. Patching this one
  // method, rather than swallowing the swipe events, leaves those events
  // intact for Zen's sidebar gestures.
  let origProcessSwipe = null; // captured in init(), once the browser is ready
  function patchedProcessSwipe(aEvent, aDir) {
    if (gestureOutside || s?.open || s?.dismissed) return;
    return origProcessSwipe.call(this, aEvent, aDir);
  }

  function init() {
    // Window capture runs before Firefox's own handler on gBrowser.tabbox.
    for (const type of EVENTS) window.addEventListener(type, handleEvent, true);
    window.addEventListener("resize", handleEvent);
    gBrowser.tabContainer.addEventListener("TabSelect", handleEvent);
    gBrowser.tabContainer.addEventListener("SSTabRestored", handleEvent);
    origProcessSwipe = gGestureSupport.processSwipeEvent;
    gGestureSupport.processSwipeEvent = patchedProcessSwipe;
    // In case Zen quit mid-gesture last time.
    window.addEventListener("unload", restoreSwipePrefs);
    window.DiaSwipe = {
      buzz,
      uninit() {
        for (const type of EVENTS) window.removeEventListener(type, handleEvent, true);
        window.removeEventListener("resize", handleEvent);
        window.removeEventListener("unload", restoreSwipePrefs);
        gBrowser.tabContainer.removeEventListener("TabSelect", handleEvent);
        gBrowser.tabContainer.removeEventListener("SSTabRestored", handleEvent);
        gGestureSupport.processSwipeEvent = origProcessSwipe;
        close();
        restoreSwipePrefs();
        delete window.DiaSwipe;
      },
    };
  }

  if (window.gBrowserInit?.delayedStartupFinished) {
    init();
  } else {
    const obs = subject => {
      if (subject !== window) return;
      Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
      init();
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();
