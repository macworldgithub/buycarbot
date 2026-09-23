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
    datasetCfg.apiUrl           = currentScript.getAttribute("data-api-url") || undefined;
    datasetCfg.autoOpen         = currentScript.getAttribute("data-auto-open") === "true";
    datasetCfg.position         = currentScript.getAttribute("data-position") || "right";
    datasetCfg.privacyPolicyUrl = currentScript.getAttribute("data-privacy-url") || undefined;
    datasetCfg.financeInfoUrl   = currentScript.getAttribute("data-finance-info-url") || undefined;
  }

  var userCfg =
    typeof window !== "undefined" && window.BMNC_CONFIG
      ? window.BMNC_CONFIG
      : {};

  var defaultOrigin =
    typeof window !== "undefined" && window.location && window.location.origin
      ? window.location.origin
      : "";

  var scriptOrigin = (function () {
    try {
      if (currentScript && currentScript.src) {
        var u = new URL(currentScript.src);
        if (u.origin && u.origin !== "null") return u.origin;
      }
    } catch (_e) {}
    return defaultOrigin;
  })();

  var CONFIG = {
    apiUrl:          (userCfg.apiUrl || datasetCfg.apiUrl || scriptOrigin || defaultOrigin).replace(/\/$/, ""),
    autoOpen:        userCfg.autoOpen !== undefined ? userCfg.autoOpen : !!datasetCfg.autoOpen,
    position:        userCfg.position || datasetCfg.position || "right",
    privacyPolicyUrl: userCfg.privacyPolicyUrl || datasetCfg.privacyPolicyUrl || "/privacy-policy",
    // URL for the Finance Referral Information page — set via data-finance-info-url or BMNC_CONFIG
    financeInfoUrl:  userCfg.financeInfoUrl || datasetCfg.financeInfoUrl || "/finance-referral-information",
  };

  if (!CONFIG.apiUrl) {
    console.error(
      "[BMNC Widget] No API URL configured. Set data-api-url on the <script> tag or window.BMNC_CONFIG.apiUrl."
    );
    return;
  }

  var SESSION_STORAGE_KEY    = "bmnc_chat_session_v1";
  var MAX_PHOTOS_PER_UPLOAD  = 6;
  var MAX_PHOTO_SIZE_BYTES   = 8 * 1024 * 1024; // 8MB

  var TAGLINE = "Instant conversation. Human-verified answers.";

  var COMPANY = {
    tradingAs: "Buy My Next Car",
    legalName: "Test Drive Group Pty Ltd",
    abn:       "51 679 064 343",
    acn:       "679 064 343",
  };

  var FINANCE_PARTNER = {
    legalName:   "Acquired Financial Services Pty Ltd",
    tradingAs:   "Acquired Finance",
    acl:         "488607",
    phone:       "1300 235 255",
    website:     "www.acquiredfinance.com",
    lenderPanel: "63+",
  };

  // Full legal consent text — used in the full-screen finance form
  var FINANCE_CONSENT_TEXT =
    "Yes, refer me to Acquired Financial Services. I consent to Test Drive Group Pty Ltd, " +
    "operator of Buy My Next Car, providing my name, telephone number and brief vehicle or " +
    "finance enquiry details to Acquired Financial Services Pty Ltd so that a licensed finance " +
    "broker can contact me. I understand that Test Drive Group Pty Ltd may receive a commission " +
    "or referral benefit if I proceed with finance arranged by Acquired Financial Services.";

  var LANGUAGES = [
    { code: "English",  label: "English",   flag: "🇦🇺" },
    { code: "Mandarin", label: "中文",       flag: "🇨🇳" },
    { code: "Arabic",   label: "العربية",    flag: "🇸🇦" },
    { code: "Hindi",    label: "हिन्दी",      flag: "🇮🇳" },
  ];

  // ── State ──
  var state = {
    open:             false,
    sessionId:        null,
    language:         null,
    showLanguageSelect: true,
    messages:         [],
    isLoading:        false,
    isUploading:      false,
    handoffRequired:  false,
    handoffSubmitted: false,
    handoffCTAShown:  false,
    // NEW: tracks whether the inline finance consent card has been shown
    // (so we only show it once per conversation)
    financeCardShown: false,
    screen:           "lang",
  };

  // ── Load fonts (idempotent) ──
  function ensureFonts() {
    if (document.getElementById("bmnc-fonts")) return;
    var link = document.createElement("link");
    link.id   = "bmnc-fonts";
    link.rel  = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600&display=swap";
    document.head.appendChild(link);
  }

  // ── Tiny markdown renderer ──
  function renderMarkdown(text) {
    if (!text) return "";
    var escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    escaped = escaped.replace(/^### (.*$)/gim, "<h3>$1</h3>");
    escaped = escaped.replace(/^## (.*$)/gim,  "<h2>$1</h2>");
    escaped = escaped.replace(/^# (.*$)/gim,   "<h1>$1</h1>");
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    escaped = escaped.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");

    var lines      = escaped.split("\n");
    var html       = [];
    var listBuffer = [];
    var listType   = null;

    function flushList() {
      if (listBuffer.length === 0) return;
      var tag = listType === "ol" ? "ol" : "ul";
      html.push("<" + tag + ">" + listBuffer.join("") + "</" + tag + ">");
      listBuffer = [];
      listType   = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line        = lines[i];
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
      } else if (line.trim() === "") {
        continue;
      } else {
        flushList();
        if (/^<h[1-3]>/.test(line)) {
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
    opts     = opts || {};
    var node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.html  !== undefined) node.innerHTML   = opts.html;
    if (opts.text  !== undefined) node.textContent = opts.text;
    if (opts.attrs) {
      for (var k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
    }
    if (opts.style) node.style.cssText = opts.style;
    return node;
  }

  var ICONS = {
    chat:
      '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    close:
      '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    reset:
      '<svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    bot:
      '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/></svg>',
    user:
      '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    globe:
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    send:
      '<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    attach:
      '<svg viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    headset:
      '<svg viewBox="0 0 24 24"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h3zM3 15a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2H3zM8 20a4 4 0 0 0 4 2h1"/></svg>',
    finance:
      '<svg viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
  };

  // ── Build widget skeleton ──
  var root = el("div", { attrs: { "data-bmnc-widget": "" } });

  var launcher = el("button", {
    attrs: { id: "bmnc-launcher", "aria-label": "Open chat" },
    html:  ICONS.chat + '<span class="bmnc-badge"></span>',
  });

  var win = el("div", {
    attrs: { id: "bmnc-window", role: "dialog", "aria-label": "Buy My Next Car AI Assistant" },
  });

  // ── Header ──
  var header       = el("div", { className: "bmnc-header" });
  var headerLeft   = el("div", { className: "bmnc-header-left" });
  var avatar       = el("div", { className: "bmnc-avatar", html: ICONS.bot });
  var headerTitleWrap = el("div", { style: "min-width:0;" });
  var headerTitle  = el("p", { className: "bmnc-header-title", text: "Buy My Next Car" });
  var headerStatus = el("p", { className: "bmnc-header-status", text: TAGLINE });
  headerTitleWrap.appendChild(headerTitle);
  headerTitleWrap.appendChild(headerStatus);
  headerLeft.appendChild(avatar);
  headerLeft.appendChild(headerTitleWrap);

  var headerActions = el("div", { className: "bmnc-header-actions" });
  var specialistBtn = el("button", {
    className: "bmnc-icon-btn bmnc-hidden",
    html:      ICONS.headset,
    attrs:     { "aria-label": "Talk to a specialist", title: "Talk to a specialist" },
  });
  var resetBtn = el("button", {
    className: "bmnc-icon-btn",
    html:      ICONS.reset,
    attrs:     { "aria-label": "Start over", title: "Start over" },
  });
  var closeBtn = el("button", {
    className: "bmnc-icon-btn",
    html:      ICONS.close,
    attrs:     { "aria-label": "Close chat" },
  });
  headerActions.appendChild(specialistBtn);
  headerActions.appendChild(resetBtn);
  headerActions.appendChild(closeBtn);
  header.appendChild(headerLeft);
  header.appendChild(headerActions);

  // ── Language select screen ──
  var langScreen = el("div", { className: "bmnc-lang-screen" });
  langScreen.appendChild(el("div", { className: "bmnc-lang-icon", html: ICONS.globe }));
  langScreen.appendChild(
    el("h3", { className: "bmnc-lang-title", text: "Welcome to Buy My Next Car" })
  );
  langScreen.appendChild(
    el("p", {
      className: "bmnc-lang-subtitle",
      text: "I'm your Buy My Next Car concierge. Choose your preferred language to get started.",
    })
  );
  var langGrid = el("div", { className: "bmnc-lang-grid" });
  LANGUAGES.forEach(function (lang) {
    var btn = el("button", {
      className: "bmnc-lang-btn",
      html:
        '<span class="bmnc-flag">' + lang.flag + "</span><span>" + lang.label + "</span>",
      attrs: { "data-lang": lang.code },
    });
    btn.addEventListener("click", function () { selectLanguage(lang.code); });
    langGrid.appendChild(btn);
  });
  langScreen.appendChild(langGrid);
  langScreen.appendChild(
    el("p", {
      className: "bmnc-lang-note",
      text: "You can switch languages anytime during the conversation",
    })
  );
  langScreen.appendChild(buildPrivacyNote());

  // ── Chat screen ──
  var chatScreen = el("div", { className: "bmnc-hidden" });
  chatScreen.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;";

  var messagesEl = el("div", { className: "bmnc-messages" });
  var errorToast = el("div", { className: "bmnc-error-toast bmnc-hidden" });

  var inputBar = el("div", { className: "bmnc-input-bar" });
  var inputRow = el("div", { className: "bmnc-input-row" });

  var attachBtn = el("button", {
    className: "bmnc-icon-btn bmnc-attach-btn",
    attrs:     { type: "button", "aria-label": "Attach photos", title: "Attach photos" },
    html:      ICONS.attach,
  });
  var fileInput = el("input", {
    attrs: { type: "file", accept: "image/*", multiple: "multiple", style: "display:none;" },
  });
  var inputEl = el("input", {
    className: "bmnc-input",
    attrs:     { type: "text", placeholder: "Type your message...", "aria-label": "Message" },
  });
  var sendBtn = el("button", {
    className: "bmnc-send-btn",
    html:      ICONS.send,
    attrs:     { "aria-label": "Send message", disabled: "disabled" },
  });
  inputRow.appendChild(attachBtn);
  inputRow.appendChild(fileInput);
  inputRow.appendChild(inputEl);
  inputRow.appendChild(sendBtn);
  inputBar.appendChild(inputRow);
  inputBar.appendChild(
    el("p", {
      className: "bmnc-disclaimer",
      text: "Indicative guidance only. Final approvals and valuations are confirmed by our specialists.",
    })
  );
  chatScreen.appendChild(messagesEl);
  chatScreen.appendChild(errorToast);
  chatScreen.appendChild(inputBar);

  // ── Handover / lead-capture screen ──
  var handoverScreen = buildHandoverScreen();

  // ── Finance referral consent screen (full-screen, accessible via header CTA) ──
  var financeScreen = buildFinanceScreen();

  win.appendChild(header);
  win.appendChild(langScreen);
  win.appendChild(chatScreen);
  win.appendChild(handoverScreen.el);
  win.appendChild(financeScreen.el);

  // ─────────────────────────────────────────────────────────────────────────
  // Privacy + entity-identity footer helper
  // ─────────────────────────────────────────────────────────────────────────

  function buildPrivacyNote() {
    var wrap = el("div", { style: "display:flex;flex-direction:column;align-items:center;" });

    var companyLine = el("p", { className: "bmnc-company-line" });
    companyLine.textContent =
      COMPANY.tradingAs +
      " is operated by " +
      COMPANY.legalName +
      " · ABN " +
      COMPANY.abn +
      " · ACN " +
      COMPANY.acn;
    wrap.appendChild(companyLine);

    var note = el("p", { className: "bmnc-privacy-note" });
    note.innerHTML =
      'By chatting with us your information may be shared with our finance and dealer partners ' +
      'to action your enquiry. See our <a href="' +
      CONFIG.privacyPolicyUrl +
      '" target="_blank" rel="noopener noreferrer">Privacy Policy</a> for details.';
    wrap.appendChild(note);

    return wrap;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Handover / lead-capture screen builder
  // ─────────────────────────────────────────────────────────────────────────

  function buildHandoverScreen() {
    var wrap = el("div", { className: "bmnc-handover-screen bmnc-hidden" });

    wrap.appendChild(el("div", { className: "bmnc-handover-icon", html: ICONS.headset }));
    wrap.appendChild(el("h3", { className: "bmnc-handover-title", text: "Talk to a specialist" }));
    wrap.appendChild(
      el("p", {
        className: "bmnc-handover-subtitle",
        text:
          "Pop in your details and one of our team will pick up your conversation directly — confirming pricing, availability, trade value or finance figures.",
      })
    );

    function field(labelText, inputAttrs, isTextarea) {
      var wrapEl = el("div", { className: "bmnc-handover-field" });
      wrapEl.appendChild(el("label", { className: "bmnc-handover-label", text: labelText }));
      var input = isTextarea
        ? el("textarea", { className: "bmnc-handover-textarea", attrs: inputAttrs })
        : el("input",    { className: "bmnc-handover-input",    attrs: inputAttrs });
      wrapEl.appendChild(input);
      wrap.appendChild(wrapEl);
      return input;
    }

    var nameInput  = field("Your name *",                { type: "text",  placeholder: "Jane Smith" });
    var phoneInput = field("Phone",                      { type: "tel",   placeholder: "04xx xxx xxx" });
    var emailInput = field("Email",                      { type: "email", placeholder: "jane@example.com" });
    var notesInput = field("Anything else? (optional)",  { placeholder: "Best time to call, current vehicle, etc." }, true);

    var errorEl = el("p", { className: "bmnc-handover-error" });
    wrap.appendChild(errorEl);

    var actions   = el("div", { className: "bmnc-handover-actions" });
    var backBtn   = el("button", { className: "bmnc-handover-back",   attrs: { type: "button" }, text: "Back" });
    var submitBtn = el("button", { className: "bmnc-handover-submit", attrs: { type: "button" }, text: "Submit my details" });
    actions.appendChild(backBtn);
    actions.appendChild(submitBtn);
    wrap.appendChild(actions);

    wrap.appendChild(buildPrivacyNote());

    return {
      el:         wrap,
      nameInput:  nameInput,
      phoneInput: phoneInput,
      emailInput: emailInput,
      notesInput: notesInput,
      errorEl:    errorEl,
      backBtn:    backBtn,
      submitBtn:  submitBtn,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Finance referral consent screen builder (full-screen)
  // Used when the user explicitly opens via BMNCWidget.compareFinance()
  // or the header icon, not for the inline card flow.
  // ─────────────────────────────────────────────────────────────────────────

  function buildFinanceScreen() {
    var wrap = el("div", { className: "bmnc-handover-screen bmnc-hidden" });

    wrap.appendChild(el("div", { className: "bmnc-handover-icon", html: ICONS.finance }));
    wrap.appendChild(
      el("h3", { className: "bmnc-handover-title", text: "Finance referral" })
    );
    wrap.appendChild(
      el("p", {
        className: "bmnc-handover-subtitle",
        text:
          "We'll connect you with our broker partner, " +
          FINANCE_PARTNER.tradingAs +
          " (ACL " + FINANCE_PARTNER.acl + "), who has access to " +
          FINANCE_PARTNER.lenderPanel +
          "+ lenders. The initial conversation is obligation-free.",
      })
    );

    var disclosureBox = el("div", { className: "bmnc-finance-disclosure" });
    disclosureBox.innerHTML =
      "<strong>Commission disclosure:</strong> " +
      COMPANY.legalName +
      " may receive a commission or referral benefit if you proceed with finance arranged by " +
      FINANCE_PARTNER.tradingAs + ".";
    wrap.appendChild(disclosureBox);

    var consentWrap  = el("div", { className: "bmnc-finance-consent-wrap" });
    var consentLabel = el("label", { className: "bmnc-finance-consent-label" });
    var consentCheck = el("input", {
      attrs: { type: "checkbox", id: "bmnc-finance-consent-check" },
    });
    consentCheck.style.cssText = "flex-shrink:0;width:16px;height:16px;margin-top:2px;accent-color:var(--bmnc-teal);cursor:pointer;";
    var consentText = el("span", {
      className: "bmnc-finance-consent-text",
      text: FINANCE_CONSENT_TEXT,
    });
    consentLabel.appendChild(consentCheck);
    consentLabel.appendChild(consentText);
    consentWrap.appendChild(consentLabel);
    wrap.appendChild(consentWrap);

    function field(labelText, inputAttrs) {
      var wrapEl = el("div", { className: "bmnc-handover-field" });
      wrapEl.appendChild(el("label", { className: "bmnc-handover-label", text: labelText }));
      var input = el("input", { className: "bmnc-handover-input", attrs: inputAttrs });
      wrapEl.appendChild(input);
      wrap.appendChild(wrapEl);
      return input;
    }

    var nameInput    = field("Your name *",  { type: "text", placeholder: "Jane Smith" });
    var phoneInput   = field("Phone *",      { type: "tel",  placeholder: "04xx xxx xxx" });
    var emailInput   = field("Email (optional — to receive chat summary)", { type: "email", placeholder: "jane@example.com" });
    var amountInput  = field("Borrowing Amount (optional)", {
      type: "text",
      placeholder: "e.g. $30,000",
    });
    var vehicleInput = field("Vehicle you're interested in (optional)", {
      type: "text",
      placeholder: "e.g. Toyota RAV4 hybrid",
    });

    var errorEl = el("p", { className: "bmnc-handover-error" });
    wrap.appendChild(errorEl);

    var actions   = el("div", { className: "bmnc-handover-actions" });
    var backBtn   = el("button", { className: "bmnc-handover-back",   attrs: { type: "button" }, text: "Back" });
    var submitBtn = el("button", {
      className: "bmnc-handover-submit",
      attrs:     { type: "button", disabled: "disabled" },
      text:      "Refer me to Acquired Finance",
    });
    actions.appendChild(backBtn);
    actions.appendChild(submitBtn);
    wrap.appendChild(actions);

    consentCheck.addEventListener("change", function () {
      submitBtn.disabled = !consentCheck.checked;
    });

    wrap.appendChild(buildPrivacyNote());

    return {
      el:           wrap,
      consentCheck: consentCheck,
      nameInput:    nameInput,
      phoneInput:   phoneInput,
      emailInput:   emailInput,
      amountInput:  amountInput,
      vehicleInput: vehicleInput,
      errorEl:      errorEl,
      backBtn:      backBtn,
      submitBtn:    submitBtn,
    };
  }

  // ── Mount once DOM is ready ──
  function mount() {
    ensureFonts();
    root.appendChild(launcher);
    root.appendChild(win);
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
          sessionId:        state.sessionId,
          messages:         state.messages,
          language:         state.language,
          handoffRequired:  state.handoffRequired,
          handoffSubmitted: state.handoffSubmitted,
          handoffCTAShown:  state.handoffCTAShown,
          financeCardShown: state.financeCardShown,
        })
      );
    } catch (e) { /* localStorage unavailable */ }
  }

  function restoreSession() {
    try {
      var saved = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!saved) return;
      var parsed = JSON.parse(saved);
      if (parsed.sessionId && parsed.messages && parsed.messages.length > 0) {
        state.sessionId        = parsed.sessionId;
        state.messages         = parsed.messages;
        state.language         = parsed.language || "English";
        state.showLanguageSelect = false;
        state.handoffRequired  = !!parsed.handoffRequired;
        state.handoffSubmitted = !!parsed.handoffSubmitted;
        state.handoffCTAShown  = !!parsed.handoffCTAShown;
        state.financeCardShown = !!parsed.financeCardShown;
        renderMessages();
        showChatScreen();
        if (state.handoffRequired && !state.handoffSubmitted && !state.handoffCTAShown) {
          appendHandoffCTA();
        }
      }
    } catch (e) { /* invalid saved session — start fresh */ }
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch (e) {}
  }

  // ── Screen transitions ──
  function hideAllScreens() {
    langScreen.classList.add("bmnc-hidden");
    chatScreen.classList.add("bmnc-hidden");
    chatScreen.style.display = "none";
    handoverScreen.el.classList.add("bmnc-hidden");
    financeScreen.el.classList.add("bmnc-hidden");
    specialistBtn.classList.add("bmnc-hidden");
  }

  function showChatScreen() {
    state.screen = "chat";
    hideAllScreens();
    chatScreen.classList.remove("bmnc-hidden");
    chatScreen.style.display = "flex";
    specialistBtn.classList.remove("bmnc-hidden");
  }

  function showLangScreen() {
    state.screen = "lang";
    hideAllScreens();
    langScreen.classList.remove("bmnc-hidden");
  }

  function showHandoverScreen() {
    var previousScreen = state.screen;
    handoverScreen.el.setAttribute("data-return-to", previousScreen);
    hideAllScreens();
    handoverScreen.el.classList.remove("bmnc-hidden");
    handoverScreen.errorEl.classList.remove("bmnc-visible");
    state.screen = "handover";
    setTimeout(function () { handoverScreen.nameInput.focus(); }, 150);
  }

  function hideHandoverScreen() {
    var returnTo = handoverScreen.el.getAttribute("data-return-to") || "chat";
    if (returnTo === "lang") showLangScreen();
    else showChatScreen();
  }

  function showFinanceScreen() {
    var previousScreen = state.screen;
    financeScreen.el.setAttribute("data-return-to", previousScreen);
    hideAllScreens();
    financeScreen.el.classList.remove("bmnc-hidden");
    financeScreen.errorEl.classList.remove("bmnc-visible");
    financeScreen.consentCheck.checked = false;
    financeScreen.submitBtn.disabled   = true;
    financeScreen.nameInput.value      = "";
    financeScreen.phoneInput.value     = "";
    financeScreen.amountInput.value    = "";
    financeScreen.vehicleInput.value   = "";
    state.screen = "finance";
    setTimeout(function () { financeScreen.nameInput.focus(); }, 150);
  }

  function hideFinanceScreen() {
    var returnTo = financeScreen.el.getAttribute("data-return-to") || "chat";
    if (returnTo === "lang") showLangScreen();
    else showChatScreen();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NEW: Inline finance consent card
  //
  // Replaces the old verbose block of consent text pasted into the chat.
  // Shows a clean card with:
  //   - A short question
  //   - One-line permission summary
  //   - [Yes, refer me] [Not now] buttons
  //   - Commission disclosure note (present but unobtrusive)
  //   - Links to Privacy Policy and Finance Referral Information
  //
  // On "Yes, refer me" → opens the full-screen finance form to collect
  //   name, phone, and vehicle, with the legal consent checkbox.
  // On "Not now" → dismisses the card gracefully in-place.
  // ─────────────────────────────────────────────────────────────────────────

  function appendInlineFinanceCard() {
    // Only show once per conversation
    if (state.financeCardShown) return;
    state.financeCardShown = true;

    var cardWrap  = el("div", { className: "bmnc-finance-card" });
    var cardInner = el("div", { className: "bmnc-finance-card-inner" });

    // Question
    cardInner.appendChild(
      el("p", {
        className: "bmnc-finance-card-question",
        text: "Would you like our finance partner to contact you?",
      })
    );

    // Permission summary (short, clear)
    cardInner.appendChild(
      el("p", {
        className: "bmnc-finance-card-body",
        text:
          "With your permission, " +
          COMPANY.legalName +
          ", operator of " +
          COMPANY.tradingAs +
          ", will share your name, phone number and brief vehicle or finance enquiry details with " +
          FINANCE_PARTNER.legalName +
          " so their broker can contact you.",
      })
    );

    // Commission note — present (required disclosure) but understated
    cardInner.appendChild(
      el("p", {
        className: "bmnc-finance-card-commission",
        text:
          COMPANY.legalName +
          " may receive a commission or referral benefit if you proceed.",
      })
    );

    // Buttons
    var btns   = el("div", { className: "bmnc-finance-card-btns" });
    var yesBtn = el("button", {
      className: "bmnc-finance-card-yes",
      attrs:     { type: "button" },
      text:      "Yes, refer me",
    });
    var noBtn  = el("button", {
      className: "bmnc-finance-card-no",
      attrs:     { type: "button" },
      text:      "Not now",
    });
    btns.appendChild(yesBtn);
    btns.appendChild(noBtn);
    cardInner.appendChild(btns);

    // Links
    var links = el("div", { className: "bmnc-finance-card-links" });
    var privacyLink = el("a", {
      text:  "Privacy Policy",
      attrs: { href: CONFIG.privacyPolicyUrl, target: "_blank", rel: "noopener noreferrer" },
    });
    var financeLink = el("a", {
      text:  "Finance Referral Information",
      attrs: { href: CONFIG.financeInfoUrl, target: "_blank", rel: "noopener noreferrer" },
    });
    links.appendChild(privacyLink);
    links.appendChild(financeLink);
    cardInner.appendChild(links);

    cardWrap.appendChild(cardInner);
    messagesEl.appendChild(cardWrap);
    scrollToBottom();

    // ── Button handlers ──
    yesBtn.addEventListener("click", function () {
      // Visually lock the card so the user can see their choice was registered
      cardInner.classList.add("bmnc-dismissed");
      yesBtn.textContent = "Connecting you…";
      // Small delay for visual feedback before screen transition
      setTimeout(function () {
        showFinanceScreen();
      }, 300);
    });

    noBtn.addEventListener("click", function () {
      cardInner.classList.add("bmnc-dismissed");
      // Replace buttons with a polite acknowledgement
      btns.innerHTML = "";
      links.style.display = "none";
      var dismissedLabel = el("p", {
        className: "bmnc-finance-card-dismissed-label",
        text: "No problem — just let me know if you'd like to explore finance later.",
      });
      // Append below the commission note, above the links area
      cardInner.appendChild(dismissedLabel);
      scrollToBottom();
      saveSession();

      // Send a brief message to keep the conversation going
      sendMessage("No thanks, not right now.", state.language);
    });

    saveSession();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Detect whether an AI reply is introducing the finance referral.
  // If so, we suppress the inline consent block the AI would normally include
  // and replace it with our clean inline card.
  //
  // The AI system prompt instructs it to present the consent statement in its
  // reply. We detect that signal and swap it out for the card, keeping the
  // introductory text but removing the raw consent paragraph.
  // ─────────────────────────────────────────────────────────────────────────

  var FINANCE_TRIGGER_PHRASES = [
    "refer me to acquired",
    "acquired financial services",
    "refer you to our broker",
    "connect you with our broker",
    "our broker partner",
    "finance referral",
    "finance partner",
    "compare finance",
  ];

  function containsFinanceTrigger(text) {
    if (!text) return false;
    var lower = text.toLowerCase();
    for (var i = 0; i < FINANCE_TRIGGER_PHRASES.length; i++) {
      if (lower.indexOf(FINANCE_TRIGGER_PHRASES[i]) !== -1) return true;
    }
    return false;
  }

  // Strip the raw consent statement block from the AI reply text so the card
  // appears instead. Handles the bolded version the AI produces.
  function stripConsentBlock(text) {
    if (!text) return text;
    // Remove everything from the consent statement opening quote onward
    // (the AI produces it bold: **"Yes, refer me...**")
    var patterns = [
      /\*?\*?"Yes, refer me to Acquired[\s\S]*/i,
      /Please confirm with the following statement[\s\S]*/i,
      /could you please confirm with the following[\s\S]*/i,
    ];
    var result = text;
    for (var i = 0; i < patterns.length; i++) {
      result = result.replace(patterns[i], "").trim();
    }
    return result;
  }

  // ── Rendering helpers ──
  function appendMessageEl(msg) {
    var row = el("div", {
      className: "bmnc-row " + (msg.role === "user" ? "bmnc-row--user" : "bmnc-row--bot"),
    });
    var msgAvatar = el("div", {
      className:
        "bmnc-msg-avatar " +
        (msg.role === "assistant" ? "bmnc-msg-avatar--bot" : "bmnc-msg-avatar--user"),
      html: msg.role === "assistant" ? ICONS.bot : ICONS.user,
    });
    var bubble = el("div", {
      className:
        "bmnc-bubble " +
        (msg.role === "assistant" ? "bmnc-bubble--bot" : "bmnc-bubble--user"),
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

  function appendHandoffCTA() {
    var row = el("div", { className: "bmnc-cta-row" });
    var btn = el("button", {
      className: "bmnc-cta-btn",
      attrs:     { type: "button" },
      html:      ICONS.headset + "<span>Share my details with the team</span>",
    });
    btn.addEventListener("click", showHandoverScreen);
    row.appendChild(btn);
    messagesEl.appendChild(row);
    scrollToBottom();
    state.handoffCTAShown = true;
    saveSession();
  }

  function appendFinanceCTA() {
    var row = el("div", { className: "bmnc-cta-row" });
    var btn = el("button", {
      className: "bmnc-cta-btn",
      attrs:     { type: "button" },
      html:      ICONS.finance + "<span>Compare finance options</span>",
    });
    btn.addEventListener("click", showFinanceScreen);
    row.appendChild(btn);
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  function renderMessages() {
    messagesEl.innerHTML = "";
    state.messages.forEach(appendMessageEl);
    scrollToBottom();
  }

  function scrollToBottom() {
    setTimeout(function () { messagesEl.scrollTop = messagesEl.scrollHeight; }, 30);
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
    setTimeout(function () { errorToast.classList.add("bmnc-hidden"); }, 5000);
  }

  function updateSendEnabled() {
    sendBtn.disabled =
      state.isLoading || state.isUploading || inputEl.value.trim().length === 0;
  }

  function setLoading(loading) {
    state.isLoading     = loading;
    inputEl.disabled    = loading || state.isUploading;
    inputEl.placeholder = loading ? "Thinking..." : "Type your message...";
    attachBtn.disabled  = loading || state.isUploading;
    updateSendEnabled();
    headerStatus.textContent = loading ? "Thinking..." : TAGLINE;
    if (loading) showTyping();
    else hideTyping();
  }

  function setUploading(uploading) {
    state.isUploading  = uploading;
    inputEl.disabled   = uploading || state.isLoading;
    attachBtn.disabled = uploading || state.isLoading;
    updateSendEnabled();
    if (uploading) {
      headerStatus.textContent = "Uploading photos...";
      showTyping();
    } else if (!state.isLoading) {
      headerStatus.textContent = TAGLINE;
      hideTyping();
    }
  }

  function handleHandoffFlags(data) {
    if (typeof data.handoffSubmitted === "boolean") state.handoffSubmitted = data.handoffSubmitted;
    if (typeof data.handoffRequired  === "boolean") state.handoffRequired  = data.handoffRequired;
    if (state.handoffRequired && !state.handoffSubmitted && !state.handoffCTAShown) {
      appendHandoffCTA();
    }
  }

  // ── API calls ──
  function sendMessage(text, language) {
    var userMsg = { id: "user-" + Date.now(), role: "user", content: text };
    state.messages.push(userMsg);
    appendMessageEl(userMsg);
    scrollToBottom();
    setLoading(true);

    fetch(CONFIG.apiUrl + "/api/chat/message", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId: state.sessionId || undefined,
        message:   text,
        language:  language || state.language || "English",
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

        // ── Conversational chat rendering ──
        // Do NOT auto-inject inline finance cards or strip content from the AI reply.
        // The conversation is handled naturally by the AI Concierge in chat without
        // unexpected pop-up cards or interrupting the user.
        var replyText = data.message;
        var shouldShowFinanceCard = false;

        var assistantMsg = {
          id:      "assistant-" + Date.now(),
          role:    "assistant",
          content: replyText,
        };
        state.messages.push(assistantMsg);
        setLoading(false);
        appendMessageEl(assistantMsg);
        scrollToBottom();

        // Optional programmatic/manual finance card only
        if (shouldShowFinanceCard) {
          setTimeout(appendInlineFinanceCard, 120);
        }

        handleHandoffFlags(data);
        saveSession();
      })
      .catch(function (err) {
        console.error("[BMNC Widget] Send failed:", err);
        setLoading(false);
        var errorMsg = {
          id:      "error-" + Date.now(),
          role:    "assistant",
          content: "We're having trouble connecting right now — please try again in a moment.",
        };
        state.messages.push(errorMsg);
        appendMessageEl(errorMsg);
        scrollToBottom();
        showError("Connection issue — please try again.");
      });
  }

  function uploadPhotos(files) {
    if (!files || files.length === 0) return;

    var accepted = [];
    for (var i = 0; i < files.length && accepted.length < MAX_PHOTOS_PER_UPLOAD; i++) {
      var f = files[i];
      if (!/^image\//.test(f.type)) continue;
      if (f.size > MAX_PHOTO_SIZE_BYTES) {
        showError('"' + f.name + '" is too large (max 8MB) and was skipped.');
        continue;
      }
      accepted.push(f);
    }

    if (accepted.length === 0) {
      showError("Please choose an image file under 8MB.");
      return;
    }

    if (state.showLanguageSelect) { selectLanguage("English"); }

    var formData = new FormData();
    formData.append("sessionId", state.sessionId || "");
    formData.append("language",  state.language || "English");
    accepted.forEach(function (f) { formData.append("photos", f, f.name); });

    var localMsg = {
      id:      "user-upload-" + Date.now(),
      role:    "user",
      content: accepted.length === 1
        ? "📎 Uploaded 1 photo"
        : "📎 Uploaded " + accepted.length + " photos",
    };
    state.messages.push(localMsg);
    appendMessageEl(localMsg);
    scrollToBottom();

    setUploading(true);

    fetch(CONFIG.apiUrl + "/api/chat/upload", { method: "POST", body: formData })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (body) { throw new Error(body.error || "Upload failed"); });
        }
        return res.json();
      })
      .then(function (data) {
        if (data.sessionId) state.sessionId = data.sessionId;
        setUploading(false);
        saveSession();
        sendMessage("I've just uploaded some photos.", state.language);
      })
      .catch(function (err) {
        console.error("[BMNC Widget] Upload failed:", err);
        setUploading(false);
        showError("We couldn't upload those photos — please try again.");
      });
  }

  function submitHandover() {
    var name  = handoverScreen.nameInput.value.trim();
    var phone = handoverScreen.phoneInput.value.trim();
    var email = handoverScreen.emailInput.value.trim();
    var notes = handoverScreen.notesInput.value.trim();

    function showFormError(msg) {
      handoverScreen.errorEl.textContent = msg;
      handoverScreen.errorEl.classList.add("bmnc-visible");
    }

    if (!name)            { showFormError("Please add your name."); return; }
    if (!phone && !email) { showFormError("Please add a phone number or email so we can reach you."); return; }
    if (!state.sessionId) { showFormError("Let's chat for a moment first so we have some context to pass on."); return; }

    handoverScreen.errorEl.classList.remove("bmnc-visible");
    handoverScreen.submitBtn.disabled    = true;
    handoverScreen.submitBtn.textContent = "Submitting...";

    fetch(CONFIG.apiUrl + "/api/chat/handover", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ sessionId: state.sessionId, name: name, phone: phone, email: email, notes: notes }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || "Couldn't submit your details.");
          return body;
        });
      })
      .then(function (data) {
        state.handoffSubmitted = true;
        state.handoffRequired  = true;
        handoverScreen.submitBtn.disabled    = false;
        handoverScreen.submitBtn.textContent = "Submit my details";
        handoverScreen.nameInput.value  = "";
        handoverScreen.phoneInput.value = "";
        handoverScreen.emailInput.value = "";
        handoverScreen.notesInput.value = "";
        showChatScreen();
        var confirmMsg = {
          id:      "assistant-handover-" + Date.now(),
          role:    "assistant",
          content: data.message || "Thanks — a specialist will be in touch shortly.",
        };
        state.messages.push(confirmMsg);
        appendMessageEl(confirmMsg);
        scrollToBottom();
        saveSession();
      })
      .catch(function (err) {
        handoverScreen.submitBtn.disabled    = false;
        handoverScreen.submitBtn.textContent = "Submit my details";
        showFormError(err.message || "Something went wrong — please try again.");
      });
  }

  function submitFinanceReferral() {
    var name    = financeScreen.nameInput.value.trim();
    var phone   = financeScreen.phoneInput.value.trim();
    var email   = financeScreen.emailInput ? financeScreen.emailInput.value.trim() : "";
    var amount  = financeScreen.amountInput.value.trim();
    var vehicle = financeScreen.vehicleInput.value.trim();

    function showFormError(msg) {
      financeScreen.errorEl.textContent = msg;
      financeScreen.errorEl.classList.add("bmnc-visible");
    }

    if (!financeScreen.consentCheck.checked) { showFormError("Please tick the consent box to proceed."); return; }
    if (!name)                               { showFormError("Please add your name."); return; }
    if (!phone)                              { showFormError("Please add your phone number."); return; }
    if (!state.sessionId)                    { showFormError("Let's chat for a moment first so we have some context to pass on."); return; }

    financeScreen.errorEl.classList.remove("bmnc-visible");
    financeScreen.submitBtn.disabled    = true;
    financeScreen.submitBtn.textContent = "Submitting...";

    var notes =
      "[Finance referral] Consent given." +
      (amount ? " Borrowing amount: " + amount + "." : "") +
      " Vehicle of interest: " +
      (vehicle || "not specified") +
      ". Referred to Acquired Financial Services Pty Ltd (ACL " +
      FINANCE_PARTNER.acl + ").";

    fetch(CONFIG.apiUrl + "/api/chat/handover", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId: state.sessionId,
        name:      name,
        phone:     phone,
        email:     email,
        notes:     notes,
      }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || "Couldn't submit your details.");
          return body;
        });
      })
      .then(function () {
        financeScreen.submitBtn.disabled    = false;
        financeScreen.submitBtn.textContent = "Refer me to Acquired Finance";
        showChatScreen();
        var confirmMsg = {
          id:      "assistant-finance-" + Date.now(),
          role:    "assistant",
          content:
            "✅ Done — your details have been passed to Acquired Finance. " +
            "One of their licensed brokers will be in touch to discuss your options. " +
            "The initial call is obligation-free, and they'll explain available rates and repayments based on your circumstances.",
        };
        state.messages.push(confirmMsg);
        appendMessageEl(confirmMsg);
        scrollToBottom();
        saveSession();
      })
      .catch(function (err) {
        financeScreen.submitBtn.disabled    = false;
        financeScreen.submitBtn.textContent = "Refer me to Acquired Finance";
        showFormError(err.message || "Something went wrong — please try again.");
      });
  }

  function selectLanguage(langCode) {
    state.language           = langCode;
    state.showLanguageSelect = false;
    showChatScreen();

    var langLabel =
      (LANGUAGES.filter(function (l) { return l.code === langCode; })[0] || {}).label || langCode;
    sendMessage(
      "Hi! I'd like to chat in " + langLabel + ". I'm looking for help finding a car.",
      langCode
    );
  }

  function resetConversation() {
    var sid = state.sessionId;
    if (sid) {
      fetch(CONFIG.apiUrl + "/api/chat/reset", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ sessionId: sid }),
      }).catch(function () {});
    }
    state.messages          = [];
    state.sessionId         = null;
    state.language          = null;
    state.showLanguageSelect = true;
    state.handoffRequired   = false;
    state.handoffSubmitted  = false;
    state.handoffCTAShown   = false;
    state.financeCardShown  = false;
    messagesEl.innerHTML    = "";
    clearSession();
    showLangScreen();
  }

  function openWidget() {
    state.open = true;
    win.classList.add("bmnc-open");
    launcher.classList.remove("bmnc-has-unread");
    launcher.classList.add("bmnc-launcher-hidden");
    if (!state.showLanguageSelect) {
      setTimeout(function () { inputEl.focus(); }, 350);
    }
  }

  function closeWidget() {
    state.open = false;
    win.classList.remove("bmnc-open");
    launcher.classList.remove("bmnc-launcher-hidden");
  }

  function toggleWidget() {
    if (state.open) closeWidget();
    else openWidget();
  }

  // ── Event wiring ──
  launcher.addEventListener("click", toggleWidget);
  closeBtn.addEventListener("click", closeWidget);
  resetBtn.addEventListener("click", resetConversation);
  specialistBtn.addEventListener("click", showHandoverScreen);

  handoverScreen.backBtn.addEventListener("click",   hideHandoverScreen);
  handoverScreen.submitBtn.addEventListener("click", submitHandover);

  financeScreen.backBtn.addEventListener("click",   hideFinanceScreen);
  financeScreen.submitBtn.addEventListener("click", submitFinanceReferral);

  inputEl.addEventListener("input", updateSendEnabled);
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") handleSend();
  });
  sendBtn.addEventListener("click", handleSend);

  attachBtn.addEventListener("click", function () {
    if (state.isLoading || state.isUploading) return;
    fileInput.click();
  });
  fileInput.addEventListener("change", function () {
    uploadPhotos(fileInput.files);
    fileInput.value = "";
  });

  function handleSend() {
    var text = inputEl.value.trim();
    if (!text || state.isLoading || state.isUploading) return;
    inputEl.value      = "";
    sendBtn.disabled   = true;
    sendMessage(text);
  }

  // ── Position override ──
  if (CONFIG.position === "left") {
    var styleOverride = document.createElement("style");
    styleOverride.textContent =
      "#bmnc-launcher{left:max(24px, env(safe-area-inset-left));right:auto;}" +
      "@media(min-width:560px){#bmnc-window{left:24px;right:auto;}}" +
      "#bmnc-window{transform-origin:bottom left;}";
    document.head.appendChild(styleOverride);
  }

  // ── Public API ──
  window.BMNCWidget = {
    open:                openWidget,
    close:               closeWidget,
    toggle:              toggleWidget,
    reset:               resetConversation,
    talkToSpecialist:    showHandoverScreen,
    compareFinance:      showFinanceScreen,
    appendFinanceCTA:    appendFinanceCTA,
    // NEW: programmatically show the inline finance consent card
    showInlineFinanceCard: appendInlineFinanceCard,
  };

  // ── Auto-open ──
  if (CONFIG.autoOpen) {
    setTimeout(openWidget, 600);
  }
})();