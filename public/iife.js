/**
 * Buy My Next Car — Embeddable Chat Widget
 * iife.js  |  Vanilla JS, no dependencies, no build step.
 *
 * USAGE — drop these two lines before </body> on any page:
 *
 *   <link rel="stylesheet" href="https://yourcdn.com/iife.css">
 *   <script src="https://yourcdn.com/iife.js"
 *           data-api-url="https://your-backend.com"></script>
 *
 * Optional attributes on the <script> tag:
 *   data-api-url     — backend base URL (required, e.g. "https://api.example.com")
 *   data-auto-open    — "true" to open the widget automatically on load
 *   data-position     — "right" (default) or "left"
 *
 * Or configure programmatically before the script loads:
 *   window.BMNC_CONFIG = { apiUrl: "https://api.example.com", autoOpen: false };
 */
(function () {
  "use strict";

  // ── Guard against double-init ──
  if (window.__bmncWidgetInitialized) return;
  window.__bmncWidgetInitialized = true;

  // ── Resolve config ──
  var currentScript =
    document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();

  var datasetCfg = {};
  if (currentScript) {
    datasetCfg.apiUrl = currentScript.getAttribute("data-api-url") || undefined;
    datasetCfg.autoOpen = currentScript.getAttribute("data-auto-open") === "true";
    datasetCfg.position = currentScript.getAttribute("data-position") || "right";
  }

  var userCfg = window.BMNC_CONFIG || {};

  var CONFIG = {
    apiUrl: (userCfg.apiUrl || datasetCfg.apiUrl || "").replace(/\/$/, ""),
    autoOpen: userCfg.autoOpen !== undefined ? userCfg.autoOpen : !!datasetCfg.autoOpen,
    position: userCfg.position || datasetCfg.position || "right",
  };

  if (!CONFIG.apiUrl) {
    console.error(
      "[BMNC Widget] No API URL configured. Set data-api-url on the <script> tag or window.BMNC_CONFIG.apiUrl."
    );
    return;
  }

  var SESSION_STORAGE_KEY = "bmnc_chat_session_v1";

  var LANGUAGES = [
    { code: "English", label: "English", flag: "🇦🇺" },
    { code: "Mandarin", label: "中文", flag: "🇨🇳" },
    { code: "Arabic", label: "العربية", flag: "🇸🇦" },
    { code: "Hindi", label: "हिन्दी", flag: "🇮🇳" },
  ];

  // ── State ──
  var state = {
    open: false,
    sessionId: null,
    language: null,
    showLanguageSelect: true,
    messages: [], // {id, role, content}
    isLoading: false,
  };

  // ── Load fonts (idempotent) ──
  function ensureFonts() {
    if (document.getElementById("bmnc-fonts")) return;
    var link = document.createElement("link");
    link.id = "bmnc-fonts";
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600&display=swap";
    document.head.appendChild(link);
  }

  // ── Tiny markdown renderer (bold, italics, lists, line breaks, headers) ──
  function renderMarkdown(text) {
    if (!text) return "";
    var escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Headers
    escaped = escaped.replace(/^### (.*$)/gim, "<h3>$1</h3>");
    escaped = escaped.replace(/^## (.*$)/gim, "<h2>$1</h2>");
    escaped = escaped.replace(/^# (.*$)/gim, "<h1>$1</h1>");

    // Bold / italics
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    escaped = escaped.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

    // Inline code
    escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Lists: group consecutive bullet/numbered lines
    var lines = escaped.split("\n");
    var html = [];
    var listBuffer = [];
    var listType = null;

    function flushList() {
      if (listBuffer.length === 0) return;
      var tag = listType === "ol" ? "ol" : "ul";
      html.push("<" + tag + ">" + listBuffer.join("") + "</" + tag + ">");
      listBuffer = [];
      listType = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var bulletMatch = line.match(/^\s*[-*]\s+(.*)/);
      var numberMatch = line.match(/^\s*\d+\.\s+(.*)/);

      if (bulletMatch) {
        if (listType !== "ul") flushList();
        listType = "ul";
        listBuffer.push("<li>" + bulletMatch[1] + "</li>");
      } else if (numberMatch) {
        if (listType !== "ol") flushList();
        listType = "ol";
        listBuffer.push("<li>" + numberMatch[1] + "</li>");
      } else {
        flushList();
        if (line.trim() === "") {
          html.push("");
        } else if (/^<h[1-3]>/.test(line)) {
          html.push(line);
        } else {
          html.push("<p>" + line + "</p>");
        }
      }
    }
    flushList();

    return html.filter(Boolean).join("");
  }

  // ── DOM builders ──
  function el(tag, opts) {
    opts = opts || {};
    var node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.html !== undefined) node.innerHTML = opts.html;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.attrs) {
      for (var k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
    }
    return node;
  }

  var ICONS = {
    chat:
      '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    reset:
      '<svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    bot: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/></svg>',
    user: '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    globe:
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    send: '<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  };

  // ── Build widget skeleton ──
  var root = el("div", { attrs: { "data-bmnc-widget": "" } });

  var launcher = el("button", {
    attrs: { id: "bmnc-launcher", "aria-label": "Open chat" },
    html: ICONS.chat + '<span class="bmnc-badge"></span>',
  });

  var win = el("div", { attrs: { id: "bmnc-window", role: "dialog", "aria-label": "Buy My Next Car AI Assistant" } });

  // Header
  var header = el("div", { className: "bmnc-header" });
  var headerLeft = el("div", { className: "bmnc-header-left" });
  var avatar = el("div", { className: "bmnc-avatar", html: ICONS.bot });
  var headerTitleWrap = el("div");
  var headerTitle = el("p", { className: "bmnc-header-title", text: "Buy My Next Car AI" });
  var headerStatus = el("p", { className: "bmnc-header-status", text: "Online — Ready to help" });
  headerTitleWrap.appendChild(headerTitle);
  headerTitleWrap.appendChild(headerStatus);
  headerLeft.appendChild(avatar);
  headerLeft.appendChild(headerTitleWrap);

  var headerActions = el("div", { className: "bmnc-header-actions" });
  var resetBtn = el("button", {
    className: "bmnc-icon-btn",
    html: ICONS.reset,
    attrs: { "aria-label": "Start over", title: "Start over" },
  });
  var closeBtn = el("button", {
    className: "bmnc-icon-btn",
    html: ICONS.close,
    attrs: { "aria-label": "Close chat" },
  });
  headerActions.appendChild(resetBtn);
  headerActions.appendChild(closeBtn);

  header.appendChild(headerLeft);
  header.appendChild(headerActions);

  // Language select screen
  var langScreen = el("div", { className: "bmnc-lang-screen" });
  langScreen.appendChild(el("div", { className: "bmnc-lang-icon", html: ICONS.globe }));
  langScreen.appendChild(
    el("h3", { className: "bmnc-lang-title", text: "Welcome to Buy My Next Car" })
  );
  langScreen.appendChild(
    el("p", {
      className: "bmnc-lang-subtitle",
      text: "I'm your AI car-finding assistant. Choose your preferred language to get started.",
    })
  );
  var langGrid = el("div", { className: "bmnc-lang-grid" });
  LANGUAGES.forEach(function (lang) {
    var btn = el("button", {
      className: "bmnc-lang-btn",
      html:
        '<span class="bmnc-flag">' +
        lang.flag +
        "</span><span>" +
        lang.label +
        "</span>",
      attrs: { "data-lang": lang.code },
    });
    btn.addEventListener("click", function () {
      selectLanguage(lang.code);
    });
    langGrid.appendChild(btn);
  });
  langScreen.appendChild(langGrid);
  langScreen.appendChild(
    el("p", {
      className: "bmnc-lang-note",
      text: "You can switch languages anytime during the conversation",
    })
  );

  // Chat screen (messages + input)
  var chatScreen = el("div", { className: "bmnc-hidden" });
  chatScreen.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;";

  var messagesEl = el("div", { className: "bmnc-messages" });

  var errorToast = el("div", { className: "bmnc-error-toast bmnc-hidden" });

  var inputBar = el("div", { className: "bmnc-input-bar" });
  var inputRow = el("div", { className: "bmnc-input-row" });
  var inputEl = el("input", {
    className: "bmnc-input",
    attrs: { type: "text", placeholder: "Type your message...", "aria-label": "Message" },
  });
  var sendBtn = el("button", {
    className: "bmnc-send-btn",
    html: ICONS.send,
    attrs: { "aria-label": "Send message", disabled: "disabled" },
  });
  inputRow.appendChild(inputEl);
  inputRow.appendChild(sendBtn);
  inputBar.appendChild(inputRow);
  inputBar.appendChild(
    el("p", {
      className: "bmnc-disclaimer",
      text: "AI provides indicative guidance only. Final approvals by licensed brokers.",
    })
  );

  chatScreen.appendChild(messagesEl);
  chatScreen.appendChild(errorToast);
  chatScreen.appendChild(inputBar);

  win.appendChild(header);
  win.appendChild(langScreen);
  win.appendChild(chatScreen);

  root.appendChild(launcher);
  root.appendChild(win);

  // ── Mount once DOM is ready ──
  function mount() {
    ensureFonts();
    document.body.appendChild(root);
    restoreSession();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // ── Persistence ──
  function saveSession() {
    if (!state.sessionId || state.messages.length === 0) return;
    try {
      localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          sessionId: state.sessionId,
          messages: state.messages,
          language: state.language,
        })
      );
    } catch (e) {
      /* localStorage unavailable — ignore */
    }
  }

  function restoreSession() {
    try {
      var saved = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!saved) return;
      var parsed = JSON.parse(saved);
      if (parsed.sessionId && parsed.messages && parsed.messages.length > 0) {
        state.sessionId = parsed.sessionId;
        state.messages = parsed.messages;
        state.language = parsed.language || "English";
        state.showLanguageSelect = false;
        renderMessages();
        showChatScreen();
      }
    } catch (e) {
      /* invalid saved session — start fresh */
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (e) {}
  }

  // ── Rendering ──
  function showChatScreen() {
    langScreen.classList.add("bmnc-hidden");
    chatScreen.classList.remove("bmnc-hidden");
    chatScreen.style.display = "flex";
  }

  function showLangScreen() {
    chatScreen.classList.add("bmnc-hidden");
    chatScreen.style.display = "none";
    langScreen.classList.remove("bmnc-hidden");
  }

  function appendMessageEl(msg) {
    var row = el("div", {
      className: "bmnc-row " + (msg.role === "user" ? "bmnc-row--user" : "bmnc-row--bot"),
    });
    var msgAvatar = el("div", {
      className: "bmnc-msg-avatar " + (msg.role === "assistant" ? "bmnc-msg-avatar--bot" : "bmnc-msg-avatar--user"),
      html: msg.role === "assistant" ? ICONS.bot : ICONS.user,
    });
    var bubble = el("div", {
      className: "bmnc-bubble " + (msg.role === "assistant" ? "bmnc-bubble--bot" : "bmnc-bubble--user"),
    });

    if (msg.role === "assistant") {
      bubble.innerHTML = renderMarkdown(msg.content);
    } else {
      bubble.textContent = msg.content;
    }

    row.appendChild(msgAvatar);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
  }

  function renderMessages() {
    messagesEl.innerHTML = "";
    state.messages.forEach(appendMessageEl);
    scrollToBottom();
  }

  function scrollToBottom() {
    setTimeout(function () {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, 30);
  }

  var typingRowEl = null;
  function showTyping() {
    if (typingRowEl) return;
    typingRowEl = el("div", { className: "bmnc-typing-row" });
    typingRowEl.appendChild(
      el("div", { className: "bmnc-msg-avatar bmnc-msg-avatar--bot", html: ICONS.bot })
    );
    typingRowEl.appendChild(
      el("div", {
        className: "bmnc-typing-bubble",
        html: '<span class="bmnc-dot"></span><span class="bmnc-dot"></span><span class="bmnc-dot"></span>',
      })
    );
    messagesEl.appendChild(typingRowEl);
    scrollToBottom();
  }

  function hideTyping() {
    if (typingRowEl && typingRowEl.parentNode) {
      typingRowEl.parentNode.removeChild(typingRowEl);
    }
    typingRowEl = null;
  }

  function showError(text) {
    errorToast.textContent = text;
    errorToast.classList.remove("bmnc-hidden");
    setTimeout(function () {
      errorToast.classList.add("bmnc-hidden");
    }, 5000);
  }

  function setLoading(loading) {
    state.isLoading = loading;
    inputEl.disabled = loading;
    inputEl.placeholder = loading ? "AI is thinking..." : "Type your message...";
    sendBtn.disabled = loading || inputEl.value.trim().length === 0;
    headerStatus.textContent = loading ? "Thinking..." : "Online — Ready to help";
    if (loading) showTyping();
    else hideTyping();
  }

  // ── API calls ──
  function sendMessage(text, language) {
    var userMsg = { id: "user-" + Date.now(), role: "user", content: text };
    state.messages.push(userMsg);
    appendMessageEl(userMsg);
    scrollToBottom();
    setLoading(true);

    fetch(CONFIG.apiUrl + "/api/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId || undefined,
        message: text,
        language: language || state.language || "English",
      }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (body) {
            throw new Error(body.error || "Request failed");
          });
        }
        return res.json();
      })
      .then(function (data) {
        if (data.sessionId) state.sessionId = data.sessionId;
        var assistantMsg = {
          id: "assistant-" + Date.now(),
          role: "assistant",
          content: data.message,
        };
        state.messages.push(assistantMsg);
        setLoading(false);
        appendMessageEl(assistantMsg);
        scrollToBottom();
        saveSession();
      })
      .catch(function (err) {
        console.error("[BMNC Widget] Send failed:", err);
        setLoading(false);
        var errorMsg = {
          id: "error-" + Date.now(),
          role: "assistant",
          content:
            "I'm sorry, I'm having trouble connecting right now. Please try again in a moment.",
        };
        state.messages.push(errorMsg);
        appendMessageEl(errorMsg);
        scrollToBottom();
        showError("Connection issue — please try again.");
      });
  }

  function selectLanguage(langCode) {
    state.language = langCode;
    state.showLanguageSelect = false;
    showChatScreen();

    var langLabel = (LANGUAGES.filter(function (l) { return l.code === langCode; })[0] || {}).label || langCode;
    sendMessage(
      "Hi! I'd like to chat in " + langLabel + ". I'm looking for help finding a car.",
      langCode
    );
  }

  function resetConversation() {
    var sid = state.sessionId;
    if (sid) {
      fetch(CONFIG.apiUrl + "/api/chat/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      }).catch(function () {
        /* ignore reset errors */
      });
    }
    state.messages = [];
    state.sessionId = null;
    state.language = null;
    state.showLanguageSelect = true;
    messagesEl.innerHTML = "";
    clearSession();
    showLangScreen();
  }

  function openWidget() {
    state.open = true;
    win.classList.add("bmnc-open");
    launcher.classList.remove("bmnc-has-unread");
    if (!state.showLanguageSelect) {
      setTimeout(function () {
        inputEl.focus();
      }, 350);
    }
  }

  function closeWidget() {
    state.open = false;
    win.classList.remove("bmnc-open");
  }

  function toggleWidget() {
    if (state.open) closeWidget();
    else openWidget();
  }

  // ── Event wiring ──
  launcher.addEventListener("click", toggleWidget);
  closeBtn.addEventListener("click", closeWidget);
  resetBtn.addEventListener("click", resetConversation);

  inputEl.addEventListener("input", function () {
    sendBtn.disabled = state.isLoading || inputEl.value.trim().length === 0;
  });

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") handleSend();
  });

  sendBtn.addEventListener("click", handleSend);

  function handleSend() {
    var text = inputEl.value.trim();
    if (!text || state.isLoading) return;
    inputEl.value = "";
    sendBtn.disabled = true;
    sendMessage(text);
  }

  // ── Position override ──
  if (CONFIG.position === "left") {
    var styleOverride = document.createElement("style");
    styleOverride.textContent =
      "#bmnc-launcher{left:24px;right:auto;}" +
      "@media(min-width:560px){#bmnc-window{left:24px;right:auto;}}" +
      "#bmnc-window{transform-origin:bottom left;}";
    document.head.appendChild(styleOverride);
  }

  // ── Public API ──
  window.BMNCWidget = {
    open: openWidget,
    close: closeWidget,
    toggle: toggleWidget,
    reset: resetConversation,
  };

  // ── Auto-open ──
  if (CONFIG.autoOpen) {
    setTimeout(openWidget, 600);
  }
})();
