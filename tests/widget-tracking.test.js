const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/iife.js"), "utf8");

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

// Execute the complete shipped widget with DOM and network boundaries stubbed.
function widget(options = {}) {
  const nodes = [];
  function element(tag) {
    const attrs = {};
    const listeners = {};
    const classes = new Set();
    const node = {
      tag, children: [], style: {}, value: "", textContent: "", innerHTML: "",
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
      },
      setAttribute: (key, value) => { attrs[key] = value; },
      getAttribute: (key) => attrs[key] || null,
      appendChild(child) { this.children.push(child); child.parentNode = this; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      click() { (listeners.click || []).forEach((fn) => fn({ target: this })); },
      focus() {},
    };
    nodes.push(node);
    return node;
  }
  const script = element("script");
  script.src = "https://bot.example/iife.js";
  for (const [key, value] of Object.entries(options.attributes || {})) script.setAttribute(key, value);
  const timers = [];
  const requests = [];
  const window = {
    location: { origin: "https://cars.example", pathname: "/" },
    BMNC_CONFIG: options.config || {},
    localStorage: options.localStorage || storage(),
    sessionStorage: options.sessionStorage || storage(),
  };
  if (options.dataLayer) window.dataLayer = options.dataLayer;
  const document = {
    currentScript: script, readyState: "complete", head: element("head"), body: element("body"),
    createElement: element,
    getElementById: (id) => nodes.find((node) => node.id === id || node.getAttribute("id") === id),
    querySelectorAll: () => [], addEventListener() {},
  };
  vm.runInNewContext(source, {
    window, document, URL, localStorage: window.localStorage,
    console: { error() {}, warn() {} },
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      const body = options.response ? options.response(url, init) : { sessionId: "chat-1", message: "Welcome" };
      return { ok: !body.error, json: async () => body };
    },
  });
  const by = (key, value, index = 0) => nodes.filter((node) => node[key] === value || node.getAttribute(key) === value)[index];
  return {
    window, requests, by,
    clickLauncher: () => by("id", "bmnc-launcher").click(),
    start: () => nodes.find((node) => node.className === "bmnc-lang-btn").click(),
    events: () => Array.isArray(window.dataLayer) ? Array.from(window.dataLayer, (event) => event.event) : [],
    autoOpen: () => timers.find((timer) => timer.delay === 600).fn(),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("manual opens count every opening, unique opens persist across page loads in a tab", () => {
  const sessionStorage = storage();
  const first = widget({ sessionStorage });
  first.clickLauncher();
  first.clickLauncher(); // Close does not count.
  first.clickLauncher();
  assert.deepEqual(first.events(), ["bmnc_chat_open", "bmnc_chat_open_unique", "bmnc_chat_open"]);
  const nextPage = widget({ sessionStorage });
  nextPage.clickLauncher();
  assert.deepEqual(nextPage.events(), ["bmnc_chat_open"]);
});

test("automatic and public API opens do not count as launcher clicks", () => {
  const app = widget({ config: { autoOpen: true } });
  app.autoOpen();
  app.window.BMNCWidget.close();
  app.window.BMNCWidget.open();
  app.window.BMNCWidget.toggle();
  app.window.BMNCWidget.toggle();
  assert.deepEqual(app.events(), []);
  app.window.BMNCWidget.close();
  app.clickLauncher();
  assert.equal(app.events().length, 2);
});

test("a lead requires a successful server-confirmed contact, and is deduplicated across reloads", async () => {
  const localStorage = storage();
  let captured = false;
  const response = () => ({ sessionId: "chat-1", message: "Thanks", leadCaptured: captured, handoffSubmitted: true });
  const app = widget({ localStorage, response });
  app.start();
  await settle();
  assert.deepEqual(app.events(), ["bmnc_chat_started"]);
  captured = true;
  const input = app.by("className", "bmnc-input");
  input.value = "Private name, phone and email";
  app.by("className", "bmnc-send-btn").click();
  await settle();
  assert.deepEqual(app.events(), ["bmnc_chat_started", "bmnc_lead_captured"]);
  assert.deepEqual(Object.keys(app.window.dataLayer[1]).sort(), ["event", "interaction_source", "lead_method", "widget_name"]);
  assert.equal(app.window.dataLayer[1].lead_method, "conversation");
  assert.doesNotMatch(JSON.stringify(app.window.dataLayer), /Private|chat-1/);
  const reloaded = widget({ localStorage, response });
  reloaded.by("className", "bmnc-input").value = "Hello again";
  reloaded.by("className", "bmnc-send-btn").click();
  await settle();
  assert.deepEqual(reloaded.events(), []);
});

test("failed message requests do not create starts or leads", async () => {
  const app = widget({ response: () => ({ error: "Unavailable", leadCaptured: true }) });
  app.start();
  await settle();
  assert.deepEqual(app.events(), []);
});

test("handover and finance successes count once for the same conversation", async () => {
  const app = widget({ response: (url) => url.endsWith("/handover") ? { success: true } : { sessionId: "chat-1", message: "Welcome" } });
  app.start();
  await settle();
  app.by("placeholder", "Jane Smith").value = "Private Customer";
  app.by("placeholder", "04xx xxx xxx").value = "0400000000";
  app.by("textContent", "Submit my details").click();
  await settle();
  app.by("placeholder", "Jane Smith", 1).value = "Private Customer";
  app.by("placeholder", "04xx xxx xxx", 1).value = "0400000000";
  app.by("id", "bmnc-finance-consent-check").checked = true;
  app.by("textContent", "Refer me to Acquired Finance").click();
  await settle();
  assert.deepEqual(app.events(), ["bmnc_chat_started", "bmnc_lead_captured"]);
  assert.equal(app.window.dataLayer[1].lead_method, "handover");
});

test("finance-only conversion reports its method and failed handovers never count", async () => {
  let success = false;
  const app = widget({ response: (url) => url.endsWith("/handover") ? (success ? { success: true } : { error: "Try again" }) : { sessionId: "chat-1", message: "Welcome" } });
  app.start();
  await settle();
  app.by("placeholder", "Jane Smith", 1).value = "Private Customer";
  app.by("placeholder", "04xx xxx xxx", 1).value = "0400000000";
  app.by("id", "bmnc-finance-consent-check").checked = true;
  app.by("textContent", "Refer me to Acquired Finance").click();
  await settle();
  assert.deepEqual(app.events(), ["bmnc_chat_started"]);
  success = true;
  app.by("textContent", "Refer me to Acquired Finance").click();
  await settle();
  assert.equal(app.window.dataLayer[1].lead_method, "finance_referral");
});

test("storage or analytics failures never block the launcher", () => {
  const blockedStorage = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
  const app = widget({ localStorage: blockedStorage, sessionStorage: blockedStorage });
  app.clickLauncher();
  app.window.BMNCWidget.close();
  app.clickLauncher();
  assert.deepEqual(app.events(), ["bmnc_chat_open", "bmnc_chat_open_unique", "bmnc_chat_open"]);
  const broken = widget({ dataLayer: { push() { throw Error("broken"); } } });
  broken.clickLauncher();
  assert.ok(broken.by("id", "bmnc-window").classList.contains("bmnc-open"));
});

test("tracking can be disabled through config or script attributes", async () => {
  for (const options of [{ config: { trackingEnabled: false } }, { attributes: { "data-tracking-enabled": "false" } }]) {
    const app = widget(options);
    app.clickLauncher();
    app.start();
    await settle();
    assert.deepEqual(app.events(), []);
    assert.equal(app.window.dataLayer, undefined);
  }
});
