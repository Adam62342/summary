// ==UserScript==
// @name           Dia Tab Hover
// @description    Dia-style hover card for sidebar tabs with quick actions
// @include        main
// ==/UserScript==

(function () {
  "use strict";
  if (window.DiaTabHover) return;

  // ---- Tuning -------------------------------------------------------------
  const DEFAULT_DELAY_MS = 450; // hover this long before the card appears
  const HIDE_DELAY_MS = 220; // grace period to move the mouse onto the card
  const WARM_MS = 600; // after hiding, re-show instantly within this window
  const GAP = 6; // space between the tab and the card
  const DROP = 0.55; // card top sits this fraction of the tab's height down
  const EDGE = 8; // keep this far from the window edges

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const PREF = "mod.diatabhover.";

  const pref = (name, def) => {
    try {
      const type = Services.prefs.getPrefType(PREF + name);
      if (type === Services.prefs.PREF_BOOL) return Services.prefs.getBoolPref(PREF + name);
      if (type === Services.prefs.PREF_STRING) return Services.prefs.getStringPref(PREF + name);
      if (type === Services.prefs.PREF_INT) return Services.prefs.getIntPref(PREF + name);
    } catch (e) {}
    return def;
  };
  const delayMs = () => {
    const n = parseInt(pref("delay", DEFAULT_DELAY_MS), 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DELAY_MS;
  };

  const haptic = () => {
    try {
      Services.zen?.playHapticFeedback?.();
    } catch (e) {}
  };

  // ---- DOM helpers --------------------------------------------------------
  function h(tag, attrs = {}, ...children) {
    const ns = ["svg", "path", "rect", "circle"].includes(tag) ? SVG_NS : HTML_NS;
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  const icon = (...shapes) =>
    h(
      "svg",
      {
        viewBox: "0 0 24 24",
        width: "18",
        height: "18",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.8",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      ...shapes.map(([tag, attrs]) => h(tag, attrs))
    );

  const ICONS = {
    pin: () =>
      icon(
        ["path", { class: "dth-fillable", d: "M9 4h6l-1 6 3.5 3.5h-11L10 10z" }],
        ["path", { d: "M12 13.5V20" }]
      ),
    split: () =>
      icon(["rect", { x: "3", y: "4.5", width: "18", height: "15", rx: "3" }], ["path", { d: "M12 4.5v15" }]),
    copy: () =>
      icon(
        ["path", { d: "M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" }],
        ["path", { d: "M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" }]
      ),
  };

  // ---- Tab data -----------------------------------------------------------
  function isEligible(tab) {
    return (
      tab &&
      tab.isConnected &&
      !tab.closing &&
      !tab.hasAttribute("zen-empty-tab") &&
      !tab.hasAttribute("zen-glance-tab")
    );
  }

  function tabURI(tab) {
    const browser = tab.linkedBrowser;
    let uri = browser?.currentURI;
    // Unloaded tabs report about:blank; Firefox keeps the real URL here.
    if ((!uri || uri.spec === "about:blank") && tab._lazyBrowserURI) uri = tab._lazyBrowserURI;
    return uri;
  }

  // The tab to split the hovered tab with: your current tab, or, when you're
  // hovering the current tab, the one you had open before it (like Zen's own
  // "Split tabs" menu item). Essentials can't be split yet in Zen.
  function splitPartner(tab) {
    if (typeof gZenViewSplitter === "undefined") return null;
    const usable = t => isEligible(t) && !t.hidden && !t.hasAttribute("zen-essential");
    if (!usable(tab)) return null;
    const selected = gBrowser.selectedTab;
    const partner = tab === selected ? gZenViewSplitter._lastOpenedTab : selected;
    if (!usable(partner) || partner === tab) return null;
    // Already side by side: nothing to do.
    if (tab.splitView && tab.group && tab.group === partner.group) return null;
    return partner;
  }

  function tabInfo(tab) {
    const uri = tabURI(tab);
    const url = uri?.spec ?? "";
    let host = "";
    try {
      host = uri?.displayHost || "";
    } catch (e) {}
    if (!host) host = url.startsWith("about:") ? url : "";
    return {
      title: tab.label || url,
      host: host.replace(/^www\./, ""),
      url,
      pinned: tab.pinned,
      canSplit: !!splitPartner(tab),
    };
  }

  // ---- Card ---------------------------------------------------------------
  let root, titleEl, hostEl, btns;
  let current = null; // tab the card is showing
  let pending = null; // tab waiting for the hover delay
  let showTimer = 0;
  let hideTimer = 0;
  let lastHiddenAt = 0;
  let overCard = false;

  function build() {
    titleEl = h("div", { class: "dth-title" });
    hostEl = h("div", { class: "dth-host" });

    const button = (name, label, onClick) => {
      const b = h("button", { class: "dth-btn", "data-action": name, title: label, "aria-label": label }, ICONS[name]());
      b.addEventListener("click", e => {
        e.stopPropagation();
        if (!current || b.hasAttribute("disabled")) return;
        haptic();
        onClick(current, b);
      });
      return b;
    };
    btns = {
      pin: button("pin", "Pin tab", togglePin),
      split: button("split", "Open in split view", splitWith),
      copy: button("copy", "Copy link", copyLink),
    };

    const card = h(
      "div",
      { class: "dth-card" },
      titleEl,
      hostEl,
      h("div", { class: "dth-actions" }, ...Object.values(btns))
    );
    root = h("div", { class: "dth-root", hidden: "true" }, card);
    root.addEventListener("mouseenter", () => {
      overCard = true;
      clearTimeout(hideTimer);
    });
    root.addEventListener("mouseleave", () => {
      overCard = false;
      scheduleHide();
    });
    (document.body || document.documentElement).appendChild(root);
  }

  function render(tab) {
    const info = tabInfo(tab);
    titleEl.textContent = info.title;
    hostEl.textContent = info.host;
    hostEl.hidden = !info.host;
    btns.split.toggleAttribute("disabled", !info.canSplit);
    btns.copy.toggleAttribute("disabled", !info.url);
    root.toggleAttribute("pinned", info.pinned);
    const pinLabel = info.pinned ? "Unpin tab" : "Pin tab";
    btns.pin.title = pinLabel;
    btns.pin.setAttribute("aria-label", pinLabel);
  }

  // Like Dia: the card hangs just off the tab's outer edge, its top a little
  // below the tab's top, so the tab itself stays visible above-left of it.
  function position(tab) {
    const tabRect = tab.getBoundingClientRect();
    const winW = document.documentElement.clientWidth;
    const winH = document.documentElement.clientHeight;
    const { width, height } = root.getBoundingClientRect();

    // Open toward whichever side of the window has room.
    const onRight = tabRect.left + tabRect.width / 2 < winW / 2;
    let x = onRight ? tabRect.right + GAP : tabRect.left - GAP - width;
    x = Math.max(EDGE, Math.min(x, winW - EDGE - width));
    let y = tabRect.top + tabRect.height * DROP;
    y = Math.max(EDGE, Math.min(y, winH - EDGE - height));

    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.setAttribute("side", onRight ? "right" : "left");
  }

  function show(tab) {
    clearTimeout(hideTimer);
    if (!root) build();
    current = tab;
    render(tab);
    root.hidden = false;
    position(tab);
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    pending = null;
    if (!root || root.hidden) return;
    current = null;
    overCard = false;
    lastHiddenAt = performance.now();
    root.hidden = true;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!overCard) hide();
    }, HIDE_DELAY_MS);
  }

  // ---- Actions ------------------------------------------------------------
  // The tab moves in the sidebar, so hide rather than leave the card behind.
  function togglePin(tab) {
    try {
      if (tab.pinned) gBrowser.unpinTab(tab);
      else gBrowser.pinTab(tab);
    } catch (e) {
      console.error("Dia Tab Hover: pin failed", e);
    }
    hide();
  }

  function splitWith(tab) {
    const partner = splitPartner(tab);
    if (!partner) return;
    try {
      // Keep your current tab on the left and focused.
      const pair = partner === gBrowser.selectedTab ? [partner, tab] : [tab, partner];
      gZenViewSplitter.splitTabs(pair, "vsep", pair.indexOf(gBrowser.selectedTab));
    } catch (e) {
      console.error("Dia Tab Hover: split view failed", e);
    }
    hide();
  }

  function copyLink(tab, button) {
    const { url } = tabInfo(tab);
    if (!url) return;
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(url);
    button.setAttribute("done", "true");
    hostEl.textContent = "Link copied";
    setTimeout(() => {
      button.removeAttribute("done");
      if (current === tab) render(tab);
    }, 1100);
  }

  // ---- Hover tracking -------------------------------------------------------
  function tabFrom(target) {
    const tab = target?.closest?.(".tabbrowser-tab");
    return isEligible(tab) ? tab : null;
  }

  function onMouseOver(e) {
    if (root?.contains(e.target)) return;
    const tab = tabFrom(e.target);
    if (!tab) return;
    clearTimeout(hideTimer);
    if (tab === current || tab === pending) return;

    // Already showing, or just closed: move straight to the new tab.
    if ((root && !root.hidden) || performance.now() - lastHiddenAt < WARM_MS) {
      clearTimeout(showTimer);
      pending = null;
      show(tab);
      return;
    }
    pending = tab;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      if (pending === tab && isEligible(tab) && tab.matches(":hover")) show(tab);
      pending = null;
    }, delayMs());
  }

  function onMouseOut(e) {
    const tab = tabFrom(e.target);
    if (!tab) return;
    // Still inside the same tab (moving between its child elements).
    if (e.relatedTarget && tab.contains(e.relatedTarget)) return;
    if (tab === pending) {
      clearTimeout(showTimer);
      pending = null;
    }
    if (tab === current) scheduleHide();
  }

  function onMouseDown(e) {
    if (root?.contains(e.target)) return;
    hide();
  }

  function onTabEvent(e) {
    if (!current) return;
    if (e.type === "TabClose" && e.target === current) hide();
    else if (e.type === "TabAttrModified" && e.target === current) render(current);
    else if (e.type === "TabSelect") render(current); // split availability changes
  }

  // Suppress Firefox's own tooltip / preview for tabs while this card is in use.
  function onPopupShowing(e) {
    if (!pref("hide_native", true)) return;
    const id = e.target.id;
    if (id === "tab-preview-panel") {
      e.preventDefault();
    } else if (id === "tabbrowser-tab-tooltip" || e.target.closest?.("#tabbrowser-tab-tooltip")) {
      e.preventDefault();
    }
  }

  // ---- Lifecycle ------------------------------------------------------------
  const listeners = [
    [window, "mouseover", onMouseOver, true],
    [window, "mouseout", onMouseOut, true],
    [window, "mousedown", onMouseDown, true],
    [window, "blur", hide, false],
    [window, "resize", hide, false],
    [window, "dragstart", hide, true],
    [window, "wheel", e => !root?.contains(e.target) && hide(), true],
    [window, "TabClose", onTabEvent, false],
    [window, "TabAttrModified", onTabEvent, false],
    [window, "TabSelect", onTabEvent, false],
    [document, "popupshowing", onPopupShowing, true],
  ];

  function init() {
    for (const [target, type, fn, capture] of listeners) target.addEventListener(type, fn, capture);
    window.DiaTabHover = {
      uninit() {
        for (const [target, type, fn, capture] of listeners) target.removeEventListener(type, fn, capture);
        hide();
        root?.remove();
        root = null;
        delete window.DiaTabHover;
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
