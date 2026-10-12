// ==UserScript==
// @name         Page Summary
// @description  Native-looking summary panel with follow-up questions
// @include      main
// ==/UserScript==

(() => {
  const ID = "page-summary";
  const PREF = "mod.page-summary.";
  const NS = "http://www.w3.org/1999/xhtml";
  const MSG = "page-summary:text";
  const MARGIN = 8;
  const MAX_CHARS = 24000;
  const SYSTEM =
    "You summarize web pages. Reply in concise markdown bullet points (5-8 bullets, one or two lines each, " +
    "bold only key terms). No preamble or closing remarks. For follow-up questions, answer briefly using the page.";

  window.__pageSummary?.destroy();

  // ---------- prefs ----------
  const pref = (k, d) => {
    try { return Services.prefs.getStringPref(PREF + k, d) || d; } catch { return d; }
  };
  const provider = () => pref("provider", "anthropic");
  const apiKey = () => pref("apikey", "").trim();
  const baseUrl = () => pref("baseurl", "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = () =>
    pref("model", "") || (provider() === "anthropic" ? "claude-haiku-5-5" : "gpt-4o-mini");
  const llmReady = () =>
    provider() === "anthropic" ? !!apiKey() : !!apiKey() || /localhost|127\.0\.0\.1/.test(baseUrl());

  // ---------- tiny DOM helper ----------
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElementNS(NS, tag);
    Object.assign(el, props);
    el.append(...kids);
    return el;
  };

  // ---------- state ----------
  let panel, logEl, foot, input, favEl, titleEl, domainEl;
  let page = null;
  let messages = [];
  let ctrl = null;
  let lastPageUrl = null;

  const pageUrl = () => {
    const uri = gBrowser.currentURI;
    return /^https?$/.test(uri.scheme) ? uri.spec : null;
  };

  // ---------- page text extraction ----------
  function extractInContent() {
    const doc = content.document;
    const root =
      doc.querySelector("article, main, [role=main], #mw-content-text, #content") || doc.body;
    const skip = "nav, footer, aside, header, form, .navbox, .reflist, .references, .toc, #toc, .mw-editsection";
    const parts = [];
    for (const el of root.querySelectorAll("h1,h2,h3,p,li,blockquote")) {
      if (el.closest(skip)) continue;
      const t = el.textContent.replace(/\s+/g, " ").replace(/\[\d+\]/g, "").trim();
      if (t.length > 1) parts.push(t);
    }
    let text = parts.join("\n");
    if (text.length < 200) text = (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
    sendAsyncMessage("page-summary:text", { title: doc.title, url: doc.location.href, text });
  }

  async function getPageText() {
    const browser = gBrowser.selectedBrowser;
    try {
      const mm = browser.messageManager;
      const data = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          mm.removeMessageListener(MSG, listener);
          reject(new Error("timeout"));
        }, 4000);
        const listener = (m) => {
          clearTimeout(timer);
          mm.removeMessageListener(MSG, listener);
          resolve(m.data);
        };
        mm.addMessageListener(MSG, listener);
        mm.loadFrameScript(
          "data:application/javascript," + encodeURIComponent(`(${extractInContent.toString()})()`),
          false
        );
      });
      if (data?.text) return data;
    } catch (e) {
      console.warn("[page-summary] frame script failed, trying reader mode", e);
    }
    // Fallback: re-download + Readability in the parent process
    const { ReaderMode } = ChromeUtils.importESModule("resource://gre/modules/ReaderMode.sys.mjs");
    const art = await ReaderMode.downloadAndParseDocument(browser.currentURI.spec);
    if (!art?.textContent) throw new Error("couldn't read this page");
    return { title: art.title, url: browser.currentURI.spec, text: art.textContent.replace(/\s+/g, " ") };
  }

  // ---------- offline extractive summarizer ----------
  function extractive(text, n = 6) {
    const sents = (text.replace(/\s+/g, " ").match(/[^.!?。！？]+[.!?。！？]+/g) || [])
      .map((s) => s.trim())
      .filter((s) => s.length > 30 && s.length < 400);
    if (sents.length <= n) return sents.map((s) => "- " + s).join("\n");
    const stop = new Set(
      "the and for with that this from which who his her their has have had not but also than then into over after before are was were been its they you your".split(" ")
    );
    const words = (s) => (s.toLowerCase().match(/[\p{L}']{3,}/gu) || []).filter((w) => !stop.has(w));
    const freq = new Map();
    for (const s of sents) for (const w of words(s)) freq.set(w, (freq.get(w) || 0) + 1);
    return sents
      .map((s, i) => {
        const ws = words(s);
        const score =
          (ws.reduce((a, w) => a + freq.get(w), 0) / Math.sqrt(ws.length || 1)) *
          (i < sents.length * 0.3 ? 1.15 : 1);
        return { s, i, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .sort((a, b) => a.i - b.i)
      .map((x) => "- " + x.s)
      .join("\n");
  }

  // ---------- LLM streaming ----------
  async function* sse(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        try { yield JSON.parse(d); } catch {}
      }
    }
  }

  async function* streamLLM(msgs, signal) {
    let res;
    if (provider() === "anthropic") {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: model(), max_tokens: 1024, stream: true, system: SYSTEM, messages: msgs }),
      });
    } else {
      res = await fetch(baseUrl() + "/chat/completions", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(apiKey() ? { authorization: `Bearer ${apiKey()}` } : {}),
        },
        body: JSON.stringify({
          model: model(),
          stream: true,
          messages: [{ role: "system", content: SYSTEM }, ...msgs],
        }),
      });
    }
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
    for await (const j of sse(res)) {
      const d =
        provider() === "anthropic"
          ? j.type === "content_block_delta" ? j.delta?.text : ""
          : j.choices?.[0]?.delta?.content;
      if (d) yield d;
    }
  }

  // ---------- minimal markdown -> DOM ----------
  const inline = (s) =>
    s.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((t) =>
      t.startsWith("**") && t.endsWith("**") && t.length > 4
        ? h("strong", { textContent: t.slice(2, -2) })
        : document.createTextNode(t)
    );

  function renderMd(el, text) {
    el.replaceChildren();
    let ul = null;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const m = line.match(/^[-*•]\s+(.*)/) || line.match(/^\d+[.)]\s+(.*)/);
      if (m) {
        if (!ul) { ul = h("ul"); el.append(ul); }
        ul.append(h("li", {}, ...inline(m[1])));
      } else if (line) {
        ul = null;
        el.append(h("p", {}, ...inline(line.replace(/^#+\s*/, ""))));
      } else {
        ul = null;
      }
    }
  }

  // ---------- UI ----------
  function position() {
    if (!panel) return;
    const r = gBrowser.selectedBrowser.getBoundingClientRect();
    const w = Math.min(parseInt(pref("width", "400"), 10) || 400, r.width - MARGIN * 2);
    panel.style.top = `${Math.round(r.top + MARGIN)}px`;
    panel.style.right = `${Math.round(window.innerWidth - r.right + MARGIN)}px`;
    panel.style.width = `${Math.round(w)}px`;
    panel.style.maxHeight = `${Math.round(r.height - MARGIN * 2)}px`;
  }

  function build() {
    favEl = h("img", { className: "ps-fav" });
    titleEl = h("div", { className: "ps-title", textContent: "Reading page…" });
    domainEl = h("div", { className: "ps-domain" });
    const closeBtn = h("button", { className: "ps-icon", textContent: "✕", title: "Close (Esc)", onclick: close });
    const head = h("div", { className: "ps-head" }, favEl, h("div", { className: "ps-meta" }, titleEl, domainEl), closeBtn);

    logEl = h("div", { className: "ps-log" });

    input = h("input", { className: "ps-input", placeholder: "Ask about this page…" });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        e.stopPropagation();
        const q = input.value.trim();
        input.value = "";
        ask(q);
      }
    });
    const send = h("button", {
      className: "ps-send", textContent: "↑", title: "Send",
      onclick: () => { if (input.value.trim()) { const q = input.value.trim(); input.value = ""; ask(q); } },
    });
    foot = h("div", { className: "ps-foot", hidden: true }, input, send);

    panel = h("div", { id: `${ID}-panel` }, head, logEl, foot);
    document.documentElement.append(panel);
    position();
  }

  const scrollDown = () => { logEl.scrollTop = logEl.scrollHeight; };

  function actionsRow(getText) {
    const chip = (label, fn) => h("button", { className: "ps-chip", textContent: label, onclick: fn });
    return h(
      "div",
      { className: "ps-actions" },
      chip("Copy", (e) => {
        Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(getText());
        e.target.textContent = "Copied";
        setTimeout(() => (e.target.textContent = "Copy"), 1200);
      }),
      chip("Regenerate", regenerate)
    );
  }

  async function generate() {
    ctrl?.abort();
    ctrl = new AbortController();
    const block = h("div", { className: "ps-msg ps-ai ps-streaming" });
    logEl.append(block);
    let acc = "";
    try {
      if (!llmReady()) {
        acc = extractive(page.text) || "Couldn't find enough text on this page to summarize.";
        renderMd(block, acc);
        block.append(h("div", {
          className: "ps-note",
          textContent: "Offline summary. Add an API key in the mod settings for AI summaries and follow-up questions.",
        }));
      } else {
        for await (const d of streamLLM(messages, ctrl.signal)) {
          acc += d;
          renderMd(block, acc);
          scrollDown();
        }
      }
      if (acc) messages.push({ role: "assistant", content: acc });
    } catch (e) {
      if (e.name !== "AbortError") {
        block.append(h("p", { className: "ps-error", textContent: `Couldn't summarize: ${e.message}` }));
      }
    }
    block.classList.remove("ps-streaming");
    if (acc) block.append(actionsRow(() => acc));
    foot.hidden = !llmReady();
    scrollDown();
  }

  function regenerate() {
    const blocks = logEl.querySelectorAll(".ps-ai");
    blocks[blocks.length - 1]?.remove();
    if (messages.at(-1)?.role === "assistant") messages.pop();
    generate();
  }

  function ask(q) {
    logEl.append(h("div", { className: "ps-msg ps-user", textContent: q }));
    messages.push({ role: "user", content: q });
    generate();
  }

  async function run(url) {
    ctrl?.abort();
    lastPageUrl = url;
    if (!panel) build(); else position();
    logEl.replaceChildren(h("div", { className: "ps-msg ps-status", textContent: "Reading page…" }));
    foot.hidden = true;
    messages = [];

    const tab = gBrowser.selectedTab;
    favEl.src = tab.image || "";
    favEl.hidden = !tab.image;
    titleEl.textContent = tab.label || url;
    domainEl.textContent = new URL(url).hostname.replace(/^www\./, "");

    try {
      page = await getPageText();
    } catch (e) {
      logEl.replaceChildren(h("p", { className: "ps-error", textContent: `Couldn't read this page: ${e.message}` }));
      return;
    }
    if (lastPageUrl !== url || !panel) return; // user moved on
    titleEl.textContent = page.title || titleEl.textContent;
    const text = page.text.slice(0, MAX_CHARS);
    page.text = text;
    logEl.replaceChildren();
    messages = [{
      role: "user",
      content: `${pref("prompt", "Summarize this page into concise bullet points.")}\n\nTitle: ${page.title}\nURL: ${page.url}\n\n${text}`,
    }];
    generate();
  }

  function close() {
    ctrl?.abort();
    panel?.remove();
    panel = logEl = foot = input = null;
    lastPageUrl = null;
    page = null;
    messages = [];
  }

  function toggle() {
    const url = pageUrl();
    if (panel && (!url || url === lastPageUrl)) return close();
    if (url) run(url);
  }

  const onKey = (e) => {
    if (e.key === "Escape" && panel) close();
    else if (e.altKey && e.shiftKey && e.code === "KeyP") { e.preventDefault(); toggle(); }
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", position);

  // ---------- toolbar button (once per session) ----------
  const { CustomizableUI } = ChromeUtils.importESModule("resource:///modules/CustomizableUI.sys.mjs");
  if (!CustomizableUI.getWidget(ID)?.provider) {
    CustomizableUI.createWidget({
      id: ID,
      type: "button",
      label: "Summarize page",
      tooltiptext: "Summarize this page (Alt+Shift+P)",
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(e) { e.target.ownerGlobal.__pageSummary?.toggle(); },
    });
  }

  window.__pageSummary = {
    toggle,
    destroy() {
      close();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", position);
      delete window.__pageSummary;
    },
  };
  console.log("[page-summary] loaded");
})();
