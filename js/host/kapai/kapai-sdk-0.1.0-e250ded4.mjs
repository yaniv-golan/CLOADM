var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/sdk/src/ui/dev-pill.ts
var dev_pill_exports = {};
__export(dev_pill_exports, {
  defineKapaiDevPill: () => defineKapaiDevPill,
  showDevPill: () => showDevPill
});
function defineKapaiDevPill(registry = globalThis.customElements, name = NAME) {
  if (!registry || registry.get(name)) return;
  registry.define(
    name,
    class KapaiDevPillElement extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML = `<style>${CSS}</style><button type="button" class="open">Kapai dev \xB7 Test device</button><button type="button" class="close" aria-label="Hide the Kapai dev pill">\xD7</button>`;
      }
    }
  );
}
function showDevPill(client) {
  const doc = globalThis.document;
  if (hidden || typeof doc?.createElement !== "function" || !globalThis.customElements) return;
  if (!doc.body) {
    doc.addEventListener("DOMContentLoaded", () => showDevPill(client), { once: true });
    return;
  }
  if (doc.querySelector(NAME)) return;
  defineKapaiDevPill();
  const pill = doc.createElement(NAME);
  const root = pill.shadowRoot;
  const stop = client.on("entitlement", (entitlement) => {
    if (entitlement.testDevice != null) return;
    pill.remove();
    stop();
  });
  root.querySelector(".open").addEventListener("click", () => {
    client.developer().catch((err) => console.warn("Kapai: the developer page did not open.", err instanceof Error ? err.message : err));
  });
  root.querySelector(".close").addEventListener("click", () => {
    hidden = true;
    pill.remove();
    stop();
  });
  doc.body.append(pill);
}
var CSS, NAME, hidden;
var init_dev_pill = __esm({
  "packages/sdk/src/ui/dev-pill.ts"() {
    "use strict";
    CSS = `
:host { position: fixed; right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); z-index: 2147482000;
  display: inline-flex; align-items: center; height: 28px; border-radius: 14px; background: #151515; color: #fff;
  font: 500 12px/16px system-ui, sans-serif; box-shadow: 0 4px 12px rgb(0 0 0 / 0.25); }
button { height: 28px; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.open { padding: 0 6px 0 12px; border-radius: 14px 0 0 14px; white-space: nowrap; }
.open::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: #e9ff45; }
.close { width: 28px; padding: 0; border-radius: 0 14px 14px 0; font-size: 16px; opacity: 0.7; }
.close:hover { opacity: 1; }
button:focus-visible { outline: 2px solid #e9ff45; outline-offset: -2px; }
`;
    NAME = "kapai-dev-pill";
    hidden = false;
  }
});

// packages/contracts/src/protocol.ts
var MAX_TOOLS = 32;
function canonicalJwk(jwk) {
  return `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
}
function powInput(nonce, thumbprint, counter) {
  return `${nonce}.${thumbprint}.${counter}`;
}
function tokenSigningInput(installId, timestamp) {
  return `kapai-v1|${installId}|${timestamp}`;
}
function leadingZeroBits(bytes) {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}
function classifyResponse(status, code) {
  if (status === 0 || status >= 500) return "outage";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limited";
  if (code === "token_expired" || code === "invalid_token") return "reauthenticate";
  if (code === "install_unknown") return "reregister";
  return "fatal";
}
function streamErrorStatus(code) {
  if (code === "upstream_error") return 502;
  if (code === "upstream_unavailable") return 503;
  return 500;
}

// packages/sdk/src/errors.ts
var KapaiError = class extends Error {
  constructor(code, message, status = 0, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
  code;
  status;
  details;
  name = "KapaiError";
};
var QuotaExceededError = class extends KapaiError {
  name = "QuotaExceededError";
  reason;
  resetsAt;
  upgradeAvailable;
  canUseOwnAI;
  startUpgrade;
  constructor(code, message, status, details, context = {}) {
    super(code, message, status, details);
    this.reason = details.reason ?? null;
    this.resetsAt = typeof details.resetsAt === "string" ? details.resetsAt : null;
    this.upgradeAvailable = details.upgradeAvailable === true;
    this.canUseOwnAI = context.canUseOwnAI ?? false;
    this.startUpgrade = context.upgrade;
  }
  /** Opens the paywall. Resolves with the new entitlement. */
  upgrade() {
    if (!this.startUpgrade) return Promise.reject(new KapaiError("upgrade_unavailable", "Call kapai.upgrade() to open the paywall."));
    return this.startUpgrade();
  }
};
var RateLimitedError = class extends KapaiError {
  name = "RateLimitedError";
  retryAfter;
  constructor(code, message, status, details, retryAfter) {
    super(code, message, status, details);
    this.retryAfter = retryAfter;
  }
};
var KapaiUnavailableError = class extends KapaiError {
  name = "KapaiUnavailableError";
};
var OwnAIError = class extends KapaiError {
  name = "OwnAIError";
  kind;
  constructor(code, message, options = {}) {
    super(code, message, options.status ?? 0, options.details ?? {});
    this.kind = options.kind;
  }
};
var SETUP_HINTS = {
  origin_not_allowed: "Add this page's origin to the allowed origins of the app in the Kapai dashboard. A browser extension's origin is chrome-extension://<its ID>.",
  invalid_publishable_key: "Copy the publishable key from the app's page in the Kapai dashboard, and set it as `publishableKey`.",
  install_revoked: "The developer revoked this install in the Kapai dashboard. The user sees that included AI is turned off.",
  app_suspended: "Kapai suspended this app. Contact Kapai's support."
};
var told = /* @__PURE__ */ new Set();
function tellDeveloperOnce(code, message) {
  if (told.has(code)) return;
  told.add(code);
  const where = typeof location !== "undefined" ? ` Origin: ${location.origin}.` : "";
  console.error(`[kapai] ${code}: ${message ?? "The request was refused."}${where} ${SETUP_HINTS[code]}`);
}
function errorFromResponse(status, body, context = {}) {
  const error = body?.error;
  const parsed = error && typeof error === "object" ? error : null;
  const code = typeof parsed?.code === "string" ? parsed.code : null;
  const { code: _code, message: rawMessage, ...details } = parsed ?? {};
  const message = typeof rawMessage === "string" ? rawMessage : null;
  if (code && code in SETUP_HINTS) tellDeveloperOnce(code, message);
  switch (classifyResponse(status, code)) {
    case "outage":
      return new KapaiUnavailableError(code ?? "unavailable", message ?? "Kapai is not available. Try again soon.", status, details);
    case "quota":
      return new QuotaExceededError(code ?? "quota_exceeded", message ?? "You reached your AI limit for now.", status, details, context);
    case "rate_limited": {
      const header = Number(context.headers?.get("retry-after"));
      const retryAfter = typeof details.retryAfter === "number" ? details.retryAfter : Number.isFinite(header) && header > 0 ? header : 1;
      return new RateLimitedError(code ?? "rate_limited", message ?? "Too many AI uses at once. Wait a moment.", status, details, retryAfter);
    }
    default:
      return new KapaiError(code ?? "http_error", message ?? `Kapai returned HTTP ${status}.`, status, details);
  }
}

// packages/sdk/src/internal/abort.ts
function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}
function abortReason(signal) {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
function raceAbort(shared, signal) {
  if (!signal) return shared;
  shared.catch(() => {
  });
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

// packages/sdk/src/pages.ts
var POLL_INTERVAL_MS = 3e3;
var MAX_WAIT_MS = 15 * 6e4;
var planOf = (mode, options) => mode === "upgrade" && options.tier ? { tier: options.tier, ...options.interval ? { interval: options.interval } : {} } : {};
var lookOf = (host) => host.appearance ? { appearance: host.appearance } : {};
var opener;
function setPageOpener(open) {
  opener = open;
}
var devPill;
function setDevPill(show) {
  devPill = show;
}
function openPage(host, mode, options = {}) {
  if (host.showPage) return appWindowPaywall(host, host.showPage, mode, options);
  return opener && !host.openUrl ? opener(host, mode, options) : externalPaywall(host, mode, options);
}
var isPaid = (entitlement) => entitlement?.tier === "pro" || entitlement?.tier === "unlimited";
var isPurchase = (mode, paidBefore, entitlement) => mode !== "developer" && !paidBefore && isPaid(entitlement) && entitlement.testDevice == null;
async function appWindowPaywall(host, showPage, mode, options) {
  throwIfAborted(options.signal);
  const paidBefore = isPaid(host.cachedEntitlement());
  host.emit({ type: "opened", mode });
  try {
    const request = {
      display: "app",
      ...options.returnUrl ? { returnUrl: options.returnUrl } : {},
      ...host.appearance ? { appearance: host.appearance } : {},
      ...planOf(mode, options)
    };
    const session = await host.createSession(mode, request, options.signal);
    await raceAbort(showPage(session.url, options.signal), options.signal);
  } finally {
    host.emit({ type: "closed", mode });
  }
  host.emit({ type: "updating", mode });
  let entitlement;
  try {
    entitlement = await host.refreshEntitlement();
  } finally {
    host.emit({ type: "updated", mode });
  }
  if (isPurchase(mode, paidBefore, entitlement)) host.emit({ type: "purchased", mode });
  return entitlement;
}
async function externalPaywall(host, mode, options) {
  const openUrl = host.openUrl;
  if (!openUrl) {
    throw new KapaiError("open_url_missing", "Set the openUrl option. This runtime has no browser window to show the paywall.");
  }
  if (mode === "developer") {
    const session = await host.createSession(mode, { ...options.returnUrl ? { returnUrl: options.returnUrl } : {}, ...lookOf(host) }, options.signal);
    await openUrl(session.url);
    return host.refreshEntitlement();
  }
  const waits = openWaits.get(openUrl) ?? openWaits.set(openUrl, /* @__PURE__ */ new Map()).get(openUrl);
  const running = waits.get(mode);
  if (running) {
    await openUrl(running.url);
    return running.result;
  }
  const entry = { url: "", result: Promise.resolve(void 0) };
  entry.result = (async () => {
    try {
      return await externalWait(host, openUrl, mode, options, (url) => entry.url = url);
    } finally {
      waits.delete(mode);
    }
  })();
  waits.set(mode, entry);
  return entry.result;
}
var openWaits = /* @__PURE__ */ new WeakMap();
async function externalWait(host, openUrl, mode, options, opened) {
  const before = await host.refreshEntitlement();
  const session = await host.createSession(
    mode,
    { ...options.returnUrl ? { returnUrl: options.returnUrl } : {}, ...lookOf(host), ...planOf(mode, options) },
    options.signal
  );
  opened(session.url);
  const page = await openUrl(session.url);
  host.emit({ type: "opened", mode, where: "tab" });
  try {
    return await waitForResult(host, session, before, options, page ? page.closed : void 0);
  } finally {
    host.emit({ type: "closed", mode, where: "tab" });
  }
}
async function waitForResult(host, session, before, options, closed) {
  const deadline = Date.now() + MAX_WAIT_MS;
  let latest = before;
  let gone = false;
  const pageClosed = closed?.then(() => void (gone = true));
  while (Date.now() < deadline) {
    await Promise.race([sleep(POLL_INTERVAL_MS, options.signal), ...pageClosed ? [pageClosed] : []]);
    if (gone) return host.refreshEntitlement().catch(() => latest);
    try {
      latest = await host.refreshEntitlement();
    } catch (err) {
      if (err instanceof KapaiError && classifyResponse(err.status, err.code) === "fatal") throw err;
      continue;
    }
    if (!samePlan(latest, before)) return latest;
    if (session.id && await host.isDone(session.id, options.signal).catch(() => false)) return host.refreshEntitlement().catch(() => latest);
  }
  return latest;
}
function samePlan(a, b) {
  const { usage: _a, testDevice: _ta, ...restA } = a;
  const { usage: _b, testDevice: _tb, ...restB } = b;
  return deepEqual(restA, restB);
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((key) => deepEqual(a[key], b[key]));
}
function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// packages/sdk/src/paywall.ts
var TITLES = { upgrade: "Plans", restore: "Use your plan on this device", manage: "Account", developer: "Developer" };
var MODAL_CSS = `
.kapai-modal{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center}
.kapai-modal .kapai-backdrop{position:absolute;inset:0;background:rgba(15,18,20,.55)}
.kapai-modal .kapai-box{position:relative;width:min(480px,calc(100vw - 24px));height:min(var(--kapai-fit,720px),720px,calc(100dvh - 24px));border-radius:14px;overflow:hidden;background:Canvas;color:CanvasText;box-shadow:0 24px 64px rgba(0,0,0,.35);overscroll-behavior:contain}
.kapai-modal .kapai-box:focus{outline:none}
.kapai-modal .kapai-loading{position:absolute;inset:0;display:grid;place-items:center;margin:0;opacity:.7}
.kapai-modal .kapai-frame,.kapai-modal .kapai-pay{display:block;width:100%;height:100%;border:0}
.kapai-modal .kapai-pay{overflow:auto;padding-top:44px;box-sizing:border-box}
.kapai-modal [hidden]{display:none}
.kapai-modal .kapai-close,.kapai-modal .kapai-back{position:absolute;top:8px;z-index:1;height:32px;min-width:32px;padding:0 10px;border:0;border-radius:16px;background:rgba(127,127,127,.2);color:inherit;font:inherit;font-size:14px;line-height:32px;cursor:pointer}
.kapai-modal .kapai-close{right:8px;font-size:20px}
.kapai-modal .kapai-back{left:8px}
.kapai-modal .kapai-close:focus-visible,.kapai-modal .kapai-back:focus-visible{outline:2px solid currentColor;outline-offset:2px}
@media (max-width:520px){.kapai-modal .kapai-box{width:100vw;height:100dvh;border-radius:0}}
`;
function browserPage() {
  const g = globalThis;
  if (!g.window?.location || typeof g.document?.createElement !== "function" || !g.document.body) return void 0;
  return { window: g.window, document: g.document };
}
var isPaid2 = (entitlement) => entitlement?.tier === "pro" || entitlement?.tier === "unlimited";
function openPaywall(host, mode, options = {}) {
  const page = host.openUrl ? void 0 : browserPage();
  if (!page) return externalPaywall(host, mode, options);
  const open = openModals.get(page.document);
  if (open) return raceAbort(open, options.signal);
  const closed = () => {
    if (openModals.get(page.document) === result) openModals.delete(page.document);
  };
  const result = modalPaywall(host, mode, options, page, closed);
  openModals.set(page.document, result);
  result.catch(closed);
  return result;
}
var openModals = /* @__PURE__ */ new WeakMap();
function loadStripe(page, url) {
  const stripe = () => page.window.Stripe;
  const loaded = stripe();
  if (loaded) return Promise.resolve(loaded);
  return new Promise((resolve, reject) => {
    const failed = () => reject(new KapaiError("stripe_blocked", "Stripe's payment form did not load in this page."));
    const script = page.document.createElement("script");
    script.src = url;
    script.addEventListener("load", () => {
      const now = stripe();
      if (now) resolve(now);
      else failed();
    });
    script.addEventListener("error", failed);
    page.document.head.append(script);
  });
}
function buildModal(doc, title, appearance) {
  const element = (tag, className) => {
    const el = doc.createElement(tag);
    el.className = className;
    return el;
  };
  const button = (className, label2, text) => {
    const el = element("button", className);
    el.type = "button";
    el.setAttribute("aria-label", label2);
    el.textContent = text;
    return el;
  };
  const root = element("div", "kapai-modal");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", title);
  const box = element("div", "kapai-box");
  box.tabIndex = -1;
  if (appearance?.theme === "light" || appearance?.theme === "dark") box.style.colorScheme = appearance.theme;
  if (appearance?.variables?.colorBackground) box.style.background = appearance.variables.colorBackground;
  if (appearance?.variables?.colorText) box.style.color = appearance.variables.colorText;
  const style = doc.createElement("style");
  style.textContent = MODAL_CSS;
  const close = button("kapai-close", "Close", "\xD7");
  const back = button("kapai-back", "Back to plans", "\u2039 Back");
  back.hidden = true;
  const loading = element("p", "kapai-loading");
  loading.setAttribute("role", "status");
  loading.textContent = "Loading\u2026";
  let held = false;
  const frame = element("iframe", "kapai-frame");
  frame.title = title;
  frame.hidden = true;
  const payment = element("div", "kapai-pay");
  payment.hidden = true;
  box.append(close, back, loading, frame, payment);
  root.append(style, element("div", "kapai-backdrop"), box);
  const opener2 = doc.activeElement;
  doc.body.append(root);
  box.focus();
  return {
    root,
    box,
    frame,
    payment,
    close,
    back,
    /** Shows the frame in place of the loading line, one time. A later call changes nothing. */
    reveal() {
      if (loading.hidden || held) return;
      loading.hidden = true;
      frame.hidden = false;
    },
    /** Hides the frame behind the loading line with `text`, until `release`. */
    hold(text) {
      held = true;
      loading.textContent = text;
      loading.hidden = false;
      frame.hidden = true;
    },
    release() {
      if (!held) return;
      held = false;
      loading.hidden = true;
      frame.hidden = false;
    },
    showPayment() {
      frame.hidden = true;
      payment.hidden = false;
      back.hidden = false;
    },
    /** Shows the frame again, at `next` when given. */
    showFrame(next) {
      payment.hidden = true;
      back.hidden = true;
      payment.replaceChildren();
      frame.hidden = false;
      if (next) frame.src = next;
    },
    remove() {
      root.remove();
      opener2?.focus?.();
    }
  };
}
var HOLD_MS = 8e3;
async function modalPaywall(host, mode, options, page, closed) {
  throwIfAborted(options.signal);
  const paidBefore = isPaid2(host.cachedEntitlement());
  const ui = buildModal(page.document, TITLES[mode], host.appearance);
  host.emit({ type: "opened", mode });
  return new Promise((resolve, reject) => {
    let latest;
    let checkout;
    let settled = false;
    let sessionUrl;
    let origin;
    const showFrame = (next) => {
      checkout?.destroy();
      checkout = void 0;
      ui.showFrame(next);
    };
    let holdTimer;
    const settle = (then) => {
      if (settled) return;
      settled = true;
      clearTimeout(holdTimer);
      page.window.removeEventListener("message", onMessage);
      page.document.removeEventListener("securitypolicyviolation", onBlocked);
      page.document.removeEventListener("keydown", onKey);
      page.document.removeEventListener("focusin", onFocus);
      options.signal?.removeEventListener("abort", onAbort);
      checkout?.destroy();
      ui.remove();
      closed();
      host.emit({ type: "closed", mode });
      then();
    };
    const close = () => settle(() => void (latest ?? host.refreshEntitlement()).then(resolve, reject));
    const onAbort = () => settle(() => reject(abortReason(options.signal)));
    const useTab = () => settle(() => void sameTabPaywall(host, mode, options, page.window).then(resolve, reject));
    const onBlocked = (event) => {
      const blocked = String(event.blockedURI ?? "");
      if (origin && blocked.startsWith(origin) || blocked.startsWith("https://js.stripe.com")) useTab();
    };
    const pay = async (data, pages) => {
      const { publishableKey, clientSecret, stripeJsUrl, returnUrl } = data;
      if (typeof publishableKey !== "string" || typeof clientSecret !== "string") return;
      if (!hasOrigin(stripeJsUrl, "https://js.stripe.com") || !hasOrigin(returnUrl, pages)) return;
      const stripe = await loadStripe(page, stripeJsUrl);
      const created = await stripe(publishableKey).createEmbeddedCheckoutPage({ clientSecret, onComplete: () => showFrame(returnUrl) });
      if (settled) return created.destroy();
      checkout?.destroy();
      checkout = created;
      ui.box.style.removeProperty("--kapai-fit");
      ui.showPayment();
      created.mount(ui.payment);
    };
    const onMessage = (event) => {
      if (!origin || event.origin !== origin || event.source !== ui.frame.contentWindow) return;
      ui.reveal();
      const data = event.data ?? {};
      switch (data.type) {
        case "kapai:page":
          host.emit({ type: "step", mode, step: typeof data.step === "string" ? data.step : "page" });
          if (data.step === "done" && !paidBefore) {
            ui.hold("Updating your plan\u2026");
            clearTimeout(holdTimer);
            holdTimer = setTimeout(ui.release, HOLD_MS);
          } else ui.release();
          break;
        case "kapai:pay":
          void pay(data, origin).catch(useTab);
          break;
        case "kapai:done":
          host.emit({ type: "updating", mode });
          latest = host.refreshEntitlement();
          latest.then(
            (entitlement) => {
              host.emit({ type: "updated", mode });
              if (isPurchase(mode, paidBefore, entitlement)) {
                host.emit({ type: "purchased", mode });
                close();
              } else ui.release();
            },
            () => {
              host.emit({ type: "updated", mode });
              ui.release();
            }
          );
          break;
        case "kapai:close":
          close();
          break;
        case "kapai:reset":
          if (mode !== "developer") break;
          settle(() => void (host.reset ?? (() => Promise.resolve()))().then(() => host.refreshEntitlement()).then(resolve, reject));
          break;
        case "kapai:size":
          if (typeof data.height === "number" && data.height > 0) ui.box.style.setProperty("--kapai-fit", `${Math.ceil(data.height)}px`);
          break;
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    const onFocus = (event) => {
      const target = event.target;
      if (target && !ui.root.contains(target) && target.tagName !== "IFRAME") ui.box.focus();
    };
    page.window.addEventListener("message", onMessage);
    page.document.addEventListener("securitypolicyviolation", onBlocked);
    page.document.addEventListener("keydown", onKey);
    page.document.addEventListener("focusin", onFocus);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    ui.close.addEventListener("click", close);
    ui.back.addEventListener("click", () => showFrame(sessionUrl));
    host.createSession(
      mode,
      {
        display: "embedded",
        ...options.returnUrl ? { returnUrl: options.returnUrl } : {},
        ...host.appearance ? { appearance: host.appearance } : {},
        ...planOf(mode, options)
      },
      options.signal
    ).then((session) => {
      if (settled) return;
      origin = new URL(session.url).origin;
      sessionUrl = session.url;
      ui.frame.addEventListener("load", ui.reveal, { once: true });
      ui.frame.src = session.url;
    }).catch((err) => settle(() => reject(err)));
  });
}
function hasOrigin(url, origin) {
  try {
    return typeof url === "string" && new URL(url).origin === origin;
  } catch {
    return false;
  }
}
async function sameTabPaywall(host, mode, options, win) {
  const { url } = await host.createSession(mode, { returnUrl: options.returnUrl ?? win.location.href, ...lookOf(host), ...planOf(mode, options) }, options.signal);
  win.location.assign(url);
  return new Promise(() => void 0);
}

// packages/sdk/src/circuit.ts
var BASE_COOLDOWN_MS = 3e4;
var MAX_COOLDOWN_MS = 5 * 6e4;
var CircuitBreaker = class {
  constructor(now) {
    this.now = now;
  }
  now;
  until = null;
  nextCooldown = BASE_COOLDOWN_MS;
  isOpen() {
    return this.until !== null && this.now() < this.until;
  }
  /** The time (ms) when the breaker lets calls through again, or null when it never opened. */
  openUntil() {
    return this.until;
  }
  recordOutage() {
    if (this.isOpen()) return;
    this.until = this.now() + this.nextCooldown;
    this.nextCooldown = Math.min(this.nextCooldown * 2, MAX_COOLDOWN_MS);
  }
  recordSuccess() {
    this.reset();
  }
  reset() {
    this.until = null;
    this.nextCooldown = BASE_COOLDOWN_MS;
  }
};

// packages/sdk/src/internal/audio.ts
var TRANSCRIBE_TIMEOUT_MS = 75e4;
var MAX_FILE_BYTES = 10 * 1024 * 1024;
var includedAIOnly = () => new KapaiError("included_ai_only", "Speech to text works only with the included AI. Switch to the included AI.", 0);
var LANGUAGES = "af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo zh".split(" ");
var LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;
var knownLanguage = (code) => LANGUAGE.test(code) && LANGUAGES.includes(code.slice(0, 2));
var MAX_PROMPT = 1e3;
var ascii = (head, at, text) => [...text].every((c, i) => head[at + i] === c.charCodeAt(0));
function audioType(head) {
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WAVE")) return "wav";
  if (ascii(head, 4, "ftyp")) return "mp4";
  if (head[0] === 26 && head[1] === 69 && head[2] === 223 && head[3] === 163) return "webm";
  if (ascii(head, 0, "OggS")) return "ogg";
  return null;
}
var invalid = (message) => new KapaiError("invalid_request", message, 0);
async function audioForm(audio, options) {
  const file = audio instanceof Blob ? audio : new Blob([audio]);
  if (file.size > MAX_FILE_BYTES) {
    throw new KapaiError("input_too_large", "The audio file is larger than 10 MB. Record a shorter file, or record at a lower bit rate.", 0, { maxFileBytes: MAX_FILE_BYTES });
  }
  const type = audioType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  if (!type) throw invalid("Expected an audio file: M4A, Ogg, WAV, or WebM.");
  if (options.language !== void 0 && !knownLanguage(options.language)) {
    throw invalid("Speech to text does not know this language code. Send a two-letter code such as en or pt.");
  }
  const promptLength = options.prompt === void 0 ? 1 : [...options.prompt.replace(/\r\n|\r|\n/g, "\r\n")].length;
  if (promptLength < 1 || promptLength > MAX_PROMPT) throw invalid("The prompt must have 1 to 1,000 characters.");
  if (options.timestamps !== void 0 && options.timestamps !== "segment") throw invalid('Expected timestamps: "segment". Word timestamps are not available.');
  const form = new FormData();
  form.append("file", file, `recording.${type === "mp4" ? "m4a" : type}`);
  if (options.language !== void 0) form.append("language", options.language);
  if (options.prompt !== void 0) form.append("prompt", options.prompt);
  if (options.timestamps) form.append("timestamp_granularities[]", options.timestamps);
  return form;
}
function serverDown(error) {
  if (!(error instanceof KapaiUnavailableError)) return false;
  if (error.status === 0) return error.code !== "timeout" && error.code !== "registration_timeout";
  return error.code === "unavailable" || error.code === "bad_response";
}

// packages/sdk/src/internal/http.ts
var timeoutError = () => new KapaiUnavailableError("timeout", "Kapai did not answer in time.");
var registrationTimeoutError = () => new KapaiUnavailableError("registration_timeout", "This device is still registering with Kapai. Try again in a few seconds.");
function withTimeout(promise, ms, controller, signal, onTimeout = timeoutError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(onTimeout());
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      controller.abort();
      reject(abortReason(signal));
    };
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function send(config, path, init, signal) {
  const controller = new AbortController();
  try {
    const response = await withTimeout(
      (async () => {
        const response2 = await config.fetch(`${config.baseUrl}${path}`, { ...init, signal: controller.signal });
        if (!response2.body || response2.ok && response2.headers.get("content-type")?.includes("text/event-stream")) return response2;
        return new Response(await response2.arrayBuffer(), response2);
      })(),
      config.firstByteTimeoutMs,
      controller,
      signal
    );
    return { response, controller };
  } catch (err) {
    if (signal?.aborted || err instanceof KapaiUnavailableError) throw err;
    throw new KapaiUnavailableError("network_error", "Kapai is not reachable. Check the network connection.", 0, {
      cause: err instanceof Error ? err.message : String(err)
    });
  }
}
async function readJson(response) {
  try {
    return await response.json();
  } catch (err) {
    throw new KapaiUnavailableError("bad_response", "Kapai sent an answer that the SDK cannot read.", response.status, {
      cause: err instanceof Error ? err.message : String(err)
    });
  }
}
async function readError(response, context = {}) {
  let body = null;
  try {
    body = await response.json();
  } catch {
  }
  return errorFromResponse(response.status, body, { ...context, headers: response.headers });
}
var jsonHeaders = (token) => ({
  "content-type": "application/json",
  ...token ? { authorization: `Bearer ${token}` } : {}
});

// packages/sdk/src/incomplete.ts
function incompleteOf(status) {
  return status === "incomplete" ? { incomplete: { reason: "max_output_tokens" } } : {};
}

// packages/sdk/src/internal/sse.ts
async function* chunksOf(stream) {
  const reader = stream.getReader();
  let finished = false;
  try {
    for (; ; ) {
      const { value, done: done3 } = await reader.read();
      if (done3) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => void 0);
  }
}
async function* readLines(chunks) {
  const decoder = new TextDecoder();
  let buffer = "";
  let skipLf = false;
  for await (const chunk of chunks) {
    let text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (skipLf && text.length > 0) {
      if (text.startsWith("\n")) text = text.slice(1);
      skipLf = false;
    }
    buffer += text;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch !== "\n" && ch !== "\r") continue;
      yield buffer.slice(start, i);
      if (ch === "\r") {
        if (i + 1 === buffer.length) skipLf = true;
        else if (buffer[i + 1] === "\n") i++;
      }
      start = i + 1;
    }
    buffer = buffer.slice(start);
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}
async function* readSse(stream) {
  let event = "";
  let data = [];
  const dispatch = () => {
    const out2 = data.length > 0 ? { event: event || "message", data: data.join("\n") } : void 0;
    event = "";
    data = [];
    return out2;
  };
  for await (const line of readLines(chunksOf(stream))) {
    if (line === "") {
      const out2 = dispatch();
      if (out2) yield out2;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  const out = dispatch();
  if (out) yield out;
}

// packages/sdk/src/internal/responses.ts
var REQUEST_MEMBERS = {
  input: true,
  instructions: true,
  maxOutputTokens: true,
  temperature: true,
  textFormat: true,
  reasoningEffort: true,
  tools: true,
  toolChoice: true,
  parallelToolCalls: true,
  signal: true
};
function isToolRequest(request) {
  const items = Array.isArray(request.input) ? request.input : [];
  return (request.tools?.length ?? 0) > 0 || items.some((item) => item.type === "function_call" || item.type === "function_call_output");
}
function checkRequest(request, warn) {
  if (request.tools != null && !Array.isArray(request.tools)) throw new KapaiError("invalid_request", `Expected a list of at most ${MAX_TOOLS} tools.`, 0);
  request.tools?.forEach((tool, index) => {
    const shape = tool;
    if (shape?.parameters === void 0 && shape?.input_schema !== void 0) {
      throw new KapaiError("invalid_request", "A tool needs `parameters`, a JSON schema. This tool has `input_schema`: rename it to `parameters`.", 0, { tool: index });
    }
  });
  const choice = request.toolChoice;
  const toolIssue = choice === void 0 || choice === "auto" || choice === "none" ? void 0 : !request.tools?.length ? "Expected auto or none, because the request has no tools." : choice === "required" || request.tools.some((tool) => tool.name === choice?.name) ? void 0 : "Expected auto, none, required, or a function of tools.";
  if (toolIssue) throw new KapaiError("invalid_request", toolIssue, 0, { issues: [{ path: "tool_choice", message: toolIssue }] });
  for (const name of Object.keys(request)) if (!Object.hasOwn(REQUEST_MEMBERS, name)) warn(name);
}
function outputMessage(id, text) {
  return { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}
function withoutProviderData(item) {
  if (item?.type !== "function_call" || !("providerData" in item)) return item;
  const { providerData: _, ...rest } = item;
  return rest;
}
function responsesBody(request) {
  const tools = request.tools?.length ? request.tools : void 0;
  const choice = request.toolChoice;
  return JSON.stringify({
    input: Array.isArray(request.input) ? request.input.map(withoutProviderData) : request.input,
    ...request.instructions !== void 0 ? { instructions: request.instructions } : {},
    ...request.maxOutputTokens !== void 0 ? { max_output_tokens: request.maxOutputTokens } : {},
    ...request.temperature !== void 0 ? { temperature: request.temperature } : {},
    ...request.textFormat !== void 0 ? { text: { format: request.textFormat } } : {},
    ...request.reasoningEffort !== void 0 ? { reasoning: { effort: request.reasoningEffort } } : {},
    // With no tools, the request sends none of the three tool members.
    ...tools ? { tools: tools.map((tool) => ({ type: "function", ...tool })) } : {},
    ...tools && choice !== void 0 ? { tool_choice: typeof choice === "object" ? { type: "function", name: choice.name } : choice } : {},
    ...tools && request.parallelToolCalls !== void 0 ? { parallel_tool_calls: request.parallelToolCalls } : {},
    stream: true
  });
}
function parseData(data) {
  try {
    return JSON.parse(data);
  } catch {
    throw new KapaiUnavailableError("bad_event", "Kapai sent data that the SDK cannot read.");
  }
}
async function* readResponseStream(body, options) {
  const events = readSse(body)[Symbol.asyncIterator]();
  let timeoutMs = options.firstEventTimeoutMs;
  const toolCalls = [];
  try {
    for (; ; ) {
      let next;
      try {
        next = await withTimeout(events.next(), timeoutMs, options.controller, options.signal);
      } catch (err) {
        if (options.signal?.aborted || err instanceof KapaiError) throw err;
        throw new KapaiUnavailableError("stream_interrupted", "The connection to Kapai broke before the answer was complete.", 0, {
          cause: err instanceof Error ? err.message : String(err)
        });
      }
      timeoutMs = options.idleTimeoutMs;
      if (next.done) break;
      const { event, data } = next.value;
      if (event === "response.output_text.delta") {
        const delta = parseData(data).delta;
        if (typeof delta === "string" && delta.length > 0) yield { type: "text", delta };
      } else if (event === "response.output_item.done") {
        const item = parseData(data).item;
        if (item?.type !== "function_call") continue;
        if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string") {
          throw new KapaiUnavailableError("bad_event", "Kapai sent data that the SDK cannot read.");
        }
        const call = { callId: item.call_id, name: item.name, arguments: item.arguments };
        toolCalls.push(call);
        yield { type: "tool_call", call };
      } else if (event === "response.completed") {
        const response = parseData(data).response;
        if (typeof response?.output_text !== "string") {
          throw new KapaiUnavailableError("bad_event", "Kapai sent data that the SDK cannot read.");
        }
        const output = Array.isArray(response.output) ? response.output : [];
        yield { type: "done", text: response.output_text, toolCalls, output, ...response.usage ? { usage: response.usage } : {}, ...incompleteOf(response.status) };
        return;
      } else if (event === "error") {
        const error = parseData(data);
        throw errorFromResponse(streamErrorStatus(error.code ?? null), { error }, options.errorContext);
      }
    }
  } finally {
    void events.return?.(void 0);
  }
  throw new KapaiUnavailableError("stream_ended", "The connection to Kapai closed before the answer was complete.");
}

// packages/sdk/src/tools.ts
var NO_TOOL = '{"error":"The app has no tool with this name."}';
var BAD_ARGUMENTS = '{"error":"The arguments are not valid JSON."}';
async function runTools(respond, request, options) {
  const maxRounds = options.maxRounds ?? 5;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new KapaiError("invalid_request", "Expected maxRounds to be a whole number of 1 or more.", 0);
  let input = typeof request.input === "string" ? [{ role: "user", content: request.input }] : [...request.input];
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  for (let rounds = 1; ; rounds++) {
    input = await runPending(input, options.handlers, request.signal);
    const { toolChoice, ...rest } = request;
    const last = await respond({ ...rest, ...rounds === 1 || toolChoice === "auto" || toolChoice === "none" ? { toolChoice } : {}, input });
    if (last.usage) for (const key of ["input_tokens", "output_tokens", "total_tokens"]) usage[key] += last.usage[key];
    input = [...input, ...last.output.map(inputOf)];
    const end = (stopped, pendingCalls) => ({ text: last.text, last, rounds, usage, stopped, pendingCalls, input });
    if (last.incomplete) return end("incomplete", last.toolCalls);
    if (last.toolCalls.length === 0) return end("done", []);
    if (rounds >= maxRounds) return end("max_rounds", last.toolCalls);
  }
}
function inputOf(item) {
  if (item.type === "function_call") return { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments, ...item.providerData !== void 0 ? { providerData: item.providerData } : {} };
  return { role: "assistant", content: item.content.map((part) => part.text).join("") };
}
async function runPending(input, handlers, signal) {
  const answered = new Set(input.flatMap((item) => item.type === "function_call_output" ? [item.call_id] : []));
  const outputs = [];
  for (const item of input) {
    if (item.type !== "function_call" || answered.has(item.call_id)) continue;
    throwIfAborted(signal);
    answered.add(item.call_id);
    outputs.push({ type: "function_call_output", call_id: item.call_id, output: await outputOf({ callId: item.call_id, name: item.name, arguments: item.arguments }, handlers, signal) });
  }
  return outputs.length ? [...input, ...outputs] : input;
}
async function outputOf(call, handlers, signal) {
  const handler = Object.hasOwn(handlers, call.name) ? handlers[call.name] : void 0;
  if (!handler) return NO_TOOL;
  let args;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return BAD_ARGUMENTS;
  }
  const result = await raceAbort(Promise.resolve().then(() => handler(args, call)), signal);
  return typeof result === "string" ? result : JSON.stringify(result) ?? "null";
}

// packages/sdk/src/internal/return.ts
var MARKER = "kapai=done";
function consumeReturnMarker() {
  const g = globalThis;
  let url;
  try {
    if (typeof g.location?.href !== "string") return false;
    url = new URL(g.location.href);
  } catch {
    return false;
  }
  const parts = url.search.slice(1).split("&");
  const kept = parts.filter((part) => part !== MARKER);
  if (kept.length === parts.length) return false;
  const search = kept.join("&");
  try {
    g.history?.replaceState?.(g.history.state, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
  } catch {
  }
  return true;
}

// packages/sdk/src/internal/runtime.ts
function detectPlatform(options = {}) {
  const g = globalThis;
  if (g.navigator?.product === "ReactNative") return { runtime: "react-native", device: "Mobile app" };
  const versions = g.process?.versions;
  const os = g.process?.platform?.slice(0, 64);
  const app = () => appLabel(options.appName, NODE_OS[g.process?.platform ?? ""]);
  if (versions?.electron) return { runtime: "electron", ...os ? { os } : {}, device: app() };
  if (g.window !== void 0 && g.document !== void 0) {
    const device = browserLabel(g.navigator, options.appName);
    return { runtime: "browser", ...device ? { device } : {} };
  }
  if (versions?.node) return { runtime: "node", ...os ? { os } : {}, device: app() };
  return { runtime: "other" };
}
var MAX_LABEL = 64;
var NODE_OS = { darwin: "macOS", win32: "Windows", linux: "Linux" };
function label(name, os) {
  const suffix = os ? ` on ${os}` : "";
  return `${name.slice(0, MAX_LABEL - suffix.length).trim()}${suffix}`;
}
var appLabel = (appName, os) => label(appName?.trim() || "Desktop app", os);
var BRANDS = {
  "Google Chrome": "Chrome",
  "Microsoft Edge": "Edge",
  Opera: "Opera",
  "Samsung Internet": "Samsung Internet"
};
var UA_BROWSERS = [
  [/SamsungBrowser\//, "Samsung Internet"],
  [/OPR\/|OPiOS\/|OPT\/|Opera/, "Opera"],
  [/Edg(?:e|A|iOS)?\//, "Edge"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"]
];
var PLATFORMS = {
  macOS: "macOS",
  Windows: "Windows",
  Linux: "Linux",
  Android: "Android",
  "Chrome OS": "ChromeOS",
  ChromeOS: "ChromeOS",
  iOS: "iOS"
};
var UA_OS = [
  [/iPad/, "iPadOS"],
  [/iPhone|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Macintosh|Mac OS X/, "macOS"],
  [/Linux/, "Linux"]
];
function browserLabel(nav, appName) {
  const ua = typeof nav?.userAgent === "string" ? nav.userAgent : "";
  const data = nav?.userAgentData;
  const hintedOS = typeof data?.platform === "string" ? PLATFORMS[data.platform] : void 0;
  let os = hintedOS ?? UA_OS.find(([pattern]) => pattern.test(ua))?.[1];
  if (!hintedOS && os === "macOS" && (nav?.maxTouchPoints ?? 0) > 1) os = "iPadOS";
  if (/Electron\//.test(ua)) return appLabel(appName, os);
  const brands = Array.isArray(data?.brands) ? data.brands : [];
  const browser = brands.map((b) => typeof b?.brand === "string" ? BRANDS[b.brand] : void 0).find(Boolean) ?? UA_BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  if (!browser && !os) return void 0;
  return label(browser ?? "Web browser", os);
}
function deviceTimeZone() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone ? { timeZone } : {};
  } catch {
    return {};
  }
}

// packages/sdk/src/internal/encoding.ts
var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function base64url(bytes) {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[n >> 12 & 63] + ALPHABET[n >> 6 & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >> 18] + ALPHABET[n >> 12 & 63];
  } else if (rest === 2) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8;
    out += ALPHABET[n >> 18] + ALPHABET[n >> 12 & 63] + ALPHABET[n >> 6 & 63];
  }
  return out;
}
var utf8 = (text) => new TextEncoder().encode(text);

// packages/sdk/src/crypto/sha256.ts
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var W = new Uint32Array(64);
function compress(state, block, offset) {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    W[i] = block[j] << 24 | block[j + 1] << 16 | block[j + 2] << 8 | block[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const w15 = W[i - 15];
    const w2 = W[i - 2];
    const s0 = (w15 >>> 7 | w15 << 25) ^ (w15 >>> 18 | w15 << 14) ^ w15 >>> 3;
    const s1 = (w2 >>> 17 | w2 << 15) ^ (w2 >>> 19 | w2 << 13) ^ w2 >>> 10;
    W[i] = W[i - 16] + s0 + W[i - 7] + s1 | 0;
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let i = 0; i < 64; i++) {
    const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
    const ch = e & f ^ ~e & g;
    const t1 = h + S1 + ch + K[i] + W[i] | 0;
    const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
    const maj = a & b ^ a & c ^ b & c;
    const t2 = S0 + maj | 0;
    h = g;
    g = f;
    f = e;
    e = d + t1 | 0;
    d = c;
    c = b;
    b = a;
    a = t1 + t2 | 0;
  }
  state[0] = state[0] + a;
  state[1] = state[1] + b;
  state[2] = state[2] + c;
  state[3] = state[3] + d;
  state[4] = state[4] + e;
  state[5] = state[5] + f;
  state[6] = state[6] + g;
  state[7] = state[7] + h;
}
function sha256(data) {
  const state = new Uint32Array([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  const fullBlocks = Math.floor(data.length / 64);
  for (let i = 0; i < fullBlocks; i++) compress(state, data, i * 64);
  const rest = data.length - fullBlocks * 64;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(data.subarray(fullBlocks * 64));
  tail[rest] = 128;
  const bitLength = data.length * 8;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(tail.length - 4, bitLength >>> 0);
  for (let offset = 0; offset < tail.length; offset += 64) compress(state, tail, offset);
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, state[i]);
  return out;
}

// packages/sdk/src/crypto/keys.ts
var ALGORITHM = { name: "ECDSA", namedCurve: "P-256" };
function subtle() {
  const found = globalThis.crypto?.subtle;
  if (!found) {
    throw new KapaiError(
      "webcrypto_missing",
      "Kapai needs WebCrypto (crypto.subtle), and this page does not have it. A browser supplies it only on HTTPS and on localhost. Open the page on HTTPS, or on localhost."
    );
  }
  return found;
}
function jwkThumbprint(jwk) {
  return base64url(sha256(utf8(canonicalJwk(jwk))));
}
async function generateKeyPair(extractable) {
  return subtle().generateKey(ALGORITHM, extractable, ["sign", "verify"]);
}
async function exportPublicJwk(keys) {
  const jwk = await subtle().exportKey("jwk", keys.publicKey);
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}
async function signTokenRequest(privateKey, installId, timestamp) {
  const signature = await subtle().sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    utf8(tokenSigningInput(installId, timestamp))
  );
  return base64url(new Uint8Array(signature));
}

// packages/sdk/src/crypto/pow.ts
var encoder = new TextEncoder();
async function solvePow(nonce, thumbprint, difficulty, options = {}) {
  const chunkSize = options.chunkSize ?? 5e3;
  const prefix = encoder.encode(powInput(nonce, thumbprint, 0).slice(0, -1));
  const buffer = new Uint8Array(prefix.length + 20);
  buffer.set(prefix);
  for (let counter = 0; ; ) {
    throwIfAborted(options.signal);
    const end = counter + chunkSize;
    for (; counter < end; counter++) {
      const digits = String(counter);
      for (let i = 0; i < digits.length; i++) buffer[prefix.length + i] = digits.charCodeAt(i);
      if (leadingZeroBits(sha256(buffer.subarray(0, prefix.length + digits.length))) >= difficulty) return counter;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// packages/sdk/src/internal/session.ts
var SDK_VERSION = "0.1.0";
var REFRESH_MARGIN_MS = 6e4;
var Session = class {
  constructor(config) {
    this.config = config;
  }
  config;
  /** `kapai.reset()` adds 1. Work that started before a reset compares it and does not save its result. */
  generation = 0;
  refreshing = null;
  registering = null;
  /** True while the device does the proof of work of a new install. */
  solving = false;
  /** Server time (ms), from the device clock and the saved clock offset. */
  serverNow() {
    return this.config.clock() + (this.config.state.get("clockOffset") ?? 0);
  }
  /**
   * Returns a valid access token. Concurrent callers share one registration and one refresh.
   * The shared work does not use any caller's signal, so one caller's abort does not fail the others.
   * A new install needs several requests. Together they get the time limit of one request, for each caller.
   * After that time the caller gets a timeout, and the shared work goes on for the next call.
   * A timeout during the proof of work has its own code, because the wait is on the device and Kapai is not down.
   */
  async accessToken(signal) {
    const token = this.config.state.get("token");
    if (token && this.serverNow() < token.expiresAt - REFRESH_MARGIN_MS) return token.accessToken;
    this.refreshing ??= this.fetchToken().finally(() => this.refreshing = null);
    const onTimeout = () => this.solving ? registrationTimeoutError() : timeoutError();
    return withTimeout(this.refreshing, this.config.http.firstByteTimeoutMs, new AbortController(), signal, onTimeout);
  }
  /** Forgets a token that the server rejected. A newer token stays. */
  invalidateToken(rejected) {
    if (this.config.state.get("token")?.accessToken === rejected) void this.config.state.remove("token");
  }
  /**
   * Deletes the key pair, install ID, and token. The next call registers a new install.
   * With `onlyInstallId`, it does nothing when another caller already made a new install.
   */
  async resetIdentity(onlyInstallId) {
    if (onlyInstallId !== void 0 && this.installId() !== onlyInstallId) return;
    this.refreshing = null;
    this.registering = null;
    await Promise.all([
      this.config.keyStore.clear(),
      this.config.state.remove("install"),
      this.config.state.remove("token")
    ]);
  }
  /** The install ID the current token belongs to, if any. */
  installId() {
    return this.config.state.get("install")?.installId;
  }
  async fetchToken() {
    const generation = this.generation;
    let fixedClock = false;
    let reregistered = false;
    for (; ; ) {
      const install = await this.ensureInstall();
      const response = await this.requestToken(install);
      if (response.ok) {
        const body = await readJson(response);
        if (generation === this.generation) {
          await this.config.state.set("token", { accessToken: body.accessToken, expiresAt: Date.parse(body.expiresAt) });
        }
        return body.accessToken;
      }
      const error = await readError(response);
      if (generation !== this.generation) throw error;
      const serverTime = error.details.serverTime;
      if (error.code === "invalid_signature" && typeof serverTime === "number" && !fixedClock) {
        fixedClock = true;
        await this.config.state.set("clockOffset", serverTime * 1e3 - this.config.clock());
        continue;
      }
      if (classifyResponse(response.status, error.code) === "reregister" && !reregistered) {
        reregistered = true;
        await this.resetIdentity();
        continue;
      }
      throw error;
    }
  }
  /**
   * A token for the saved install, for a last request before a reset. It never registers and never saves the token.
   * Returns undefined when there is no saved install or the server gives no token.
   */
  async currentToken(signal) {
    const token = this.config.state.get("token");
    if (token && this.serverNow() < token.expiresAt) return token.accessToken;
    const { install } = await this.savedInstall();
    if (!install) return void 0;
    const response = await this.requestToken(install, signal);
    if (!response.ok) return void 0;
    return (await readJson(response)).accessToken;
  }
  /** The saved install when its key pair is still in the key store. */
  async savedInstall() {
    const saved = this.config.state.get("install");
    const keys = await this.config.keyStore.load();
    if (saved && keys && jwkThumbprint(await exportPublicJwk(keys)) === saved.thumbprint) {
      return { install: { installId: saved.installId, keys }, keys };
    }
    return { install: null, keys };
  }
  /** Signs a token request with the install key and sends it. */
  async requestToken(install, signal) {
    const timestamp = Math.floor(this.serverNow() / 1e3);
    const signature = await signTokenRequest(install.keys.privateKey, install.installId, timestamp);
    const { response } = await send(
      this.config.http,
      `/v1/installs/${encodeURIComponent(install.installId)}/token`,
      { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ timestamp, signature, ...deviceTimeZone() }) },
      signal
    );
    return response;
  }
  async ensureInstall() {
    let { install, keys } = await this.savedInstall();
    if (install) return install;
    await this.config.state.reload("install");
    ({ install, keys } = await this.savedInstall());
    if (install) return install;
    this.registering ??= this.register(keys).finally(() => this.registering = null);
    return this.registering;
  }
  async register(existing) {
    const generation = this.generation;
    const keys = existing ?? await this.config.keyStore.create();
    const publicKey = await exportPublicJwk(keys);
    const thumbprint = jwkThumbprint(publicKey);
    let registered;
    for (let attempt = 1; !registered; attempt++) {
      try {
        registered = await this.registerOnce(publicKey, thumbprint);
      } catch (err) {
        const retry = err instanceof KapaiError && (err.code === "pow_invalid" || err.code === "pow_expired");
        if (!retry || attempt >= 2) throw err;
      }
    }
    if (generation === this.generation) {
      await this.config.state.set("install", { installId: registered.installId, thumbprint });
      await this.config.state.remove("token");
    }
    return { installId: registered.installId, keys };
  }
  /** Gets a challenge, solves the proof of work, and registers. */
  async registerOnce(publicKey, thumbprint) {
    const challenge = await this.postJson("/v1/installs/challenge", {
      publishableKey: this.config.publishableKey
    });
    this.solving = true;
    const counter = await solvePow(challenge.nonce, thumbprint, challenge.difficulty).finally(() => this.solving = false);
    return this.postJson("/v1/installs", {
      publishableKey: this.config.publishableKey,
      publicKey,
      pow: { nonce: challenge.nonce, counter },
      platform: this.config.platform,
      sdkVersion: SDK_VERSION,
      ...this.config.appVersion ? { appVersion: this.config.appVersion } : {},
      attestation: { type: "none" },
      ...deviceTimeZone()
    });
  }
  async postJson(path, body) {
    const { response } = await send(this.config.http, path, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
    if (!response.ok) throw await readError(response);
    return readJson(response);
  }
};

// packages/sdk/src/internal/state.ts
var KEYS = ["install", "token", "clockOffset", "entitlement", "ownAI", "debugToken"];
var isPromise = (value) => typeof value?.then === "function";
var StateStore = class {
  constructor(storage, namespace) {
    this.storage = storage;
    this.namespace = namespace;
    const pending = [];
    for (const key of KEYS) {
      const raw = storage.get(this.storageKey(key));
      if (isPromise(raw)) pending.push(raw.then((value) => this.accept(key, value)));
      else this.accept(key, raw);
    }
    this.ready = pending.length > 0 ? Promise.all(pending).then(() => void 0) : Promise.resolve();
  }
  storage;
  namespace;
  ready;
  values = {};
  writes = Promise.resolve();
  get(key) {
    return this.values[key];
  }
  set(key, value) {
    this.values[key] = value;
    return this.write(() => this.storage.set(this.storageKey(key), JSON.stringify(value)));
  }
  remove(key) {
    delete this.values[key];
    return this.write(() => this.storage.remove(this.storageKey(key)));
  }
  /** Reads the key from storage again. Another context, such as an extension's worker, can have saved it. */
  reload(key) {
    return this.write(async () => this.accept(key, await this.storage.get(this.storageKey(key))));
  }
  /**
   * Reads the key from storage again, then saves `change(current)`.
   * Another tab can save the key after this tab read the storage. A write from memory would then erase that change.
   * The read and the write are one step in the write queue, so two calls in this tab do not undo each other.
   * A key that is not in storage keeps its value from memory.
   */
  update(key, change) {
    return this.write(async () => {
      this.accept(key, await this.storage.get(this.storageKey(key)));
      const value = change(this.values[key]);
      this.values[key] = value;
      await this.storage.set(this.storageKey(key), JSON.stringify(value));
    });
  }
  storageKey(key) {
    return `kapai:${this.namespace}:${key}`;
  }
  accept(key, raw) {
    if (raw === null) return;
    try {
      this.values[key] = JSON.parse(raw);
    } catch {
    }
  }
  /** Writes run one after another, so the last write wins. */
  write(op) {
    const next = this.writes.then(op, op);
    this.writes = next.catch(() => void 0);
    return next;
  }
};

// packages/sdk/src/internal/systemone.ts
var SYSTEMONE_TIMEOUT_MS = 15e4;
var MAX_QUESTIONS = 32;
var MAX_FIELDS = 64;
var systemOneNeedsIncludedAI = () => new KapaiError("included_ai_only", "Decisions and extraction work only with the included AI. Switch to the included AI.", 0);
var invalid2 = (message) => new KapaiError("invalid_request", message, 0);
var DATA_URL = /^data:(?:[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*)?(?:;[a-z0-9!#$&^_.+=-]+)*,/i;
function hasDataUrl(value) {
  if (typeof value === "string") return DATA_URL.test(value.slice(0, 200).replace(/^[\s\u0085\uFEFF\u200B]+/, ""));
  if (Array.isArray(value)) return value.some(hasDataUrl);
  return typeof value === "object" && value !== null && Object.values(value).some(hasDataUrl);
}
function systemOneBody(shape, request) {
  const { signal: _signal, ...body } = request;
  const { state } = body;
  if (typeof state !== "string" && (typeof state !== "object" || state === null)) throw invalid2("Send a state: a text, an object, or an array.");
  const { questions, fields } = body;
  if (shape === "questions" && fields !== void 0) throw invalid2("decide() takes questions, not fields. Use extract() for fields.");
  if (shape === "fields" && questions !== void 0) throw invalid2("extract() takes fields, not questions. Use decide() for questions.");
  const [max, map] = shape === "fields" ? [MAX_FIELDS, fields] : [MAX_QUESTIONS, questions];
  const count = typeof map === "object" && map !== null ? Object.keys(map).length : 0;
  if (count < 1 || count > max) throw invalid2(`Send 1 to ${max} ${shape}.`);
  if (hasDataUrl(body)) throw invalid2("Kapai sends text only. Images and documents wait for a later version.");
  const issue = shape === "fields" ? fieldIssue(map) : null;
  if (issue) throw new KapaiError("invalid_request", issue.message, 0, { issues: [issue] });
  return body;
}
var FIELD_TYPES = ["text", "number", "date", "time", "datetime", "duration", "boolean", "enum", "object", "list", "compute", "estimate", "forecast"];
function fieldIssue(fields) {
  for (const [name, value] of Object.entries(fields)) {
    const spec = typeof value === "object" && value !== null ? value : {};
    const missing = (member, message) => spec[member] === void 0 ? { path: `fields.${name}.${member}`, message } : null;
    let issue = null;
    if (spec.type === "list") {
      issue = missing("items", "A list needs items: the type of each item, such as text.");
      if (!issue && (typeof spec.items !== "string" || spec.items === "boolean" || !FIELD_TYPES.includes(spec.items))) {
        issue = { path: `fields.${name}.items`, message: "items must be the type of each item as a text, other than boolean, such as text, number, or date." };
      }
    } else if (spec.type === "enum") issue = missing("enum", "An enum needs enum: the list of its values.");
    else if (spec.type === "object") issue = missing("properties", "An object needs properties: the field spec of each member.");
    else if (spec.type === "estimate") issue = missing("min", "An estimate needs min and max.") ?? missing("max", "An estimate needs min and max.");
    if (issue) return issue;
  }
  return null;
}
function sample(spec) {
  switch (spec.type) {
    case "text":
      return "(Offline AI) sample";
    case "number":
    case "estimate":
      return 0;
    case "boolean":
      return false;
    case "list": {
      const item = sample({ type: spec.items });
      return item === null ? [] : [item];
    }
    case "object": {
      const members = typeof spec.properties === "object" && spec.properties !== null ? Object.entries(spec.properties) : [];
      return Object.fromEntries(members.map(([name, member]) => [name, sample(member ?? {})]));
    }
    default:
      return null;
  }
}
function offlineAnswer(body) {
  const { model, questions, fields } = body;
  const each = (map, answer) => Object.fromEntries(Object.entries(map).map(([key, value]) => [key, answer(value)]));
  if (fields) {
    const answers2 = each(fields, (spec) => {
      const value = sample(spec);
      return { type: spec.type, value, valid: true, complete: true, confidence: 0, p_null: value === null ? 1 : 0 };
    });
    const usage = { state_tokens: 0, image_tokens: 0, schema_tokens: 0, input_tokens: 0, output_tokens: 0, passes: 0 };
    return { model: model ?? "clairic-flash", answers: answers2, truncated: false, usage };
  }
  const answers = each(questions ?? {}, (question) => {
    if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      const share = 1 / Math.max(options.length, 1);
      return { type: "choice", choice: options[0], confidence: share, probabilities: Object.fromEntries(options.map((option) => [option, share])) };
    }
    if (question.type === "score") {
      const levels = question.criteria;
      const share = 1 / Math.max(levels.length, 1);
      const legend = Object.fromEntries(levels.map((level, at) => [String(at), level]));
      return { type: "score", score: 0, confidence: share, legend, probabilities: Object.fromEntries(levels.map((_, at) => [String(at), share])) };
    }
    return { type: "noul", noul: 0.5 };
  });
  return { answers, model: model ?? "djev", usage: { input_tokens: 0, output_tokens: 0 } };
}

// packages/sdk/src/own-ai/http.ts
function requireField(config, field, label2, kind) {
  const value = config[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new OwnAIError("own_ai_invalid_config", `Enter the ${label2}.`, { kind });
  }
  return value.trim();
}
function requireHttpUrl(value, label2, kind) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OwnAIError("own_ai_invalid_config", `The ${label2} is not a valid URL.`, { kind });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OwnAIError("own_ai_invalid_config", `The ${label2} must start with http:// or https://.`, { kind });
  }
  return url;
}
var streamEnded = (kind) => new OwnAIError("own_ai_stream_ended", "The connection to your AI provider closed before the answer was complete.", { kind });
async function postForStream(fetchFn, url, headers, body, kind, signal) {
  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      ...signal ? { signal } : {}
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OwnAIError("own_ai_unreachable", `Could not reach ${new URL(url).host}. Check that the server runs and the URL is correct.`, {
      kind,
      details: { cause: err instanceof Error ? err.message : String(err) }
    });
  }
  if (!response.ok || !response.body) {
    const detail = await providerMessage(response);
    throw new OwnAIError("own_ai_failed", `Your AI provider returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`, {
      kind,
      status: response.status,
      ...detail ? { details: { providerMessage: detail } } : {}
    });
  }
  return response.body;
}
function toolsRefused(err, request) {
  const items = Array.isArray(request.input) ? request.input : [];
  const firstRound = (request.tools?.length ?? 0) > 0 && !items.some((item) => item.type === "function_call" || item.type === "function_call_output");
  const forced = request.toolChoice === "required" || typeof request.toolChoice === "object";
  if (!(err instanceof OwnAIError) || err.status !== 400 && err.status !== 422 || !firstRound || forced) return err;
  const message = typeof err.details.providerMessage === "string" ? err.details.providerMessage : void 0;
  return new OwnAIError(
    "own_ai_no_tools",
    `Your AI provider refused the tools (HTTP ${err.status})${message ? `: ${message.replace(/\.$/, "")}` : ""}. Choose a model that takes tools, or switch to the included AI.`,
    { kind: err.kind, status: err.status, ...message ? { details: { providerMessage: message } } : {} }
  );
}
var callWithNoName = (kind) => new OwnAIError("own_ai_failed", "Your AI provider sent a tool call with no name.", { kind });
var newCallId = () => `call_own_${crypto.randomUUID().replaceAll("-", "")}`;
async function providerMessage(response) {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    if (typeof body.error === "string") return body.error;
    if (typeof body.error?.message === "string") return body.error.message;
    if (typeof body.message === "string") return body.message;
  } catch {
  }
  return text.trim().slice(0, 200) || void 0;
}

// packages/sdk/src/own-ai/messages.ts
function textOf(content) {
  return typeof content === "string" ? content : content.map((part) => part.text).join("\n");
}
var isMessage = (item) => item.type === void 0 || item.type === "message";
var messagesOf = (input) => input.filter(isMessage);
function toChatMessages(input, instructions) {
  const messages = instructions ? [{ role: "system", content: instructions }] : [];
  if (typeof input === "string") return [...messages, { role: "user", content: input }];
  for (const message of messagesOf(input)) {
    messages.push({ role: message.role === "developer" ? "system" : message.role, content: textOf(message.content) });
  }
  return messages;
}
function toChatCompletionsMessages(input, instructions) {
  if (typeof input === "string") return toChatMessages(input, instructions);
  const messages = instructions ? [{ role: "system", content: instructions }] : [];
  let calls;
  for (const item of input) {
    if (item.type === "function_call") {
      if (!calls) {
        calls = [];
        const last = messages.at(-1);
        if (last?.role === "assistant" && !last.tool_calls) last.tool_calls = calls;
        else messages.push({ role: "assistant", content: null, tool_calls: calls });
      }
      calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
      continue;
    }
    if (item.type === "function_call_output") messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
    else if (isMessage(item)) messages.push({ role: item.role === "developer" ? "system" : item.role, content: textOf(item.content) });
    else continue;
    calls = void 0;
  }
  return messages;
}
function splitSystem(input, instructions) {
  const all = toChatMessages(input, instructions);
  const system = all.filter((m) => m.role === "system").map((m) => m.content);
  const messages = all.filter((m) => m.role !== "system");
  return { system: system.length > 0 ? system.join("\n\n") : void 0, messages };
}
function inputOf2(args) {
  try {
    const value = JSON.parse(args);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function thinkingOf(providerData) {
  const thinking = providerData?.anthropic?.thinking;
  return Array.isArray(thinking) ? thinking : [];
}
function toAnthropicMessages(input, instructions) {
  if (typeof input === "string" || !input.some((item) => item.type === "function_call" || item.type === "function_call_output")) {
    return splitSystem(input, instructions);
  }
  const system = instructions ? [instructions] : [];
  const messages = [];
  let inRun = false;
  for (const item of input) {
    const wasInRun = inRun;
    inRun = item.type === "function_call";
    if (item.type === "function_call") {
      const block = { type: "tool_use", id: item.call_id, name: item.name, input: inputOf2(item.arguments) };
      const last = messages.at(-1);
      const thinking = thinkingOf(item.providerData);
      if (last?.role !== "assistant") messages.push({ role: "assistant", content: [...thinking, block] });
      else {
        if (typeof last.content === "string") last.content = last.content ? [{ type: "text", text: last.content }] : [];
        if (wasInRun) last.content.push(...thinking, block);
        else last.content.unshift(...thinking), last.content.push(block);
      }
    } else if (item.type === "function_call_output") {
      const block = { type: "tool_result", tool_use_id: item.call_id, content: item.output };
      const last = messages.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else messages.push({ role: "user", content: [block] });
    } else if (isMessage(item)) {
      const text = textOf(item.content);
      if (item.role === "system" || item.role === "developer") system.push(text);
      else {
        const last = messages.at(-1);
        if (item.role === "user" && last?.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text });
        else messages.push({ role: item.role, content: text });
      }
    }
  }
  return { ...system.length > 0 ? { system: system.join("\n\n") } : {}, messages };
}

// packages/sdk/src/own-ai/anthropic.ts
var KIND = "anthropic";
var ENDPOINT = "https://api.anthropic.com/v1/messages";
var DEFAULT_MAX_TOKENS = 16e3;
var CACHE_CONTROL = { type: "ephemeral" };
var anthropicTool = ({ name, description, parameters, strict }) => ({
  name,
  ...description !== void 0 ? { description } : {},
  input_schema: parameters,
  ...strict !== void 0 ? { strict } : {}
});
var CHOICES = { auto: { type: "auto" }, none: { type: "none" }, required: { type: "any" } };
function anthropicToolChoice(choice, parallel) {
  const base = choice === void 0 ? parallel === false ? CHOICES.auto : void 0 : typeof choice === "string" ? CHOICES[choice] : { type: "tool", name: choice.name };
  return base && parallel === false && base.type !== "none" ? { ...base, disable_parallel_tool_use: true } : base;
}
function toolMembers(request) {
  if (!request.tools?.length) return {};
  const choice = anthropicToolChoice(request.toolChoice, request.parallelToolCalls);
  const tools = request.tools.map(anthropicTool);
  return {
    tools: tools.map((tool, index) => index === tools.length - 1 ? { ...tool, cache_control: CACHE_CONTROL } : tool),
    ...choice ? { tool_choice: choice } : {}
  };
}
function anthropicAdapter(config, env) {
  const fields = config;
  const apiKey = requireField(fields, "apiKey", "Anthropic API key", KIND);
  const model = requireField(fields, "model", "model name", KIND);
  return {
    tools: true,
    async *stream(request) {
      const { system, messages } = toAnthropicMessages(request.input, request.instructions);
      const body = await postForStream(
        env.fetch,
        ENDPOINT,
        {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          // Browsers block the call without this header. The key belongs to the user, so it is safe on their device.
          "anthropic-dangerous-direct-browser-access": "true"
        },
        {
          model,
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
          ...system !== void 0 ? { system: isToolRequest(request) ? [{ type: "text", text: system, cache_control: CACHE_CONTROL }] : system } : {},
          messages,
          stream: true,
          ...request.temperature !== void 0 ? { temperature: request.temperature } : {},
          ...toolMembers(request)
        },
        KIND,
        request.signal
      ).catch((err) => {
        throw toolsRefused(err, request);
      });
      let inputTokens = 0;
      let outputTokens = 0;
      let stopped = false;
      let stopReason;
      const open = /* @__PURE__ */ new Map();
      const calls = [];
      const thinkingOpen = /* @__PURE__ */ new Map();
      let thinking = [];
      for await (const { data } of readSse(body)) {
        const event = JSON.parse(data);
        if (event.type === "message_start") inputTokens = event.message?.usage?.input_tokens ?? 0;
        else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          open.set(event.index ?? 0, {
            callId: event.content_block.id || newCallId(),
            name: event.content_block.name ?? "",
            arguments: "",
            ...thinking.length ? { providerData: { anthropic: { thinking } } } : {}
          });
          thinking = [];
        } else if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
          thinkingOpen.set(event.index ?? 0, { type: "thinking", thinking: "", signature: "" });
        } else if (event.type === "content_block_start" && event.content_block?.type === "redacted_thinking") {
          thinking.push({ type: "redacted_thinking", data: event.content_block.data ?? "" });
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
          const block = thinkingOpen.get(event.index ?? 0);
          if (block) block.thinking += event.delta.thinking ?? "";
        } else if (event.type === "content_block_delta" && event.delta?.type === "signature_delta") {
          const block = thinkingOpen.get(event.index ?? 0);
          if (block) block.signature += event.delta.signature ?? "";
        } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          const call = open.get(event.index ?? 0);
          if (call) call.arguments += event.delta.partial_json ?? "";
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          yield { type: "text", delta: event.delta.text };
        } else if (event.type === "content_block_stop") {
          const block = thinkingOpen.get(event.index ?? 0);
          if (block) {
            thinkingOpen.delete(event.index ?? 0);
            thinking.push(block);
          }
          const call = open.get(event.index ?? 0);
          if (call) {
            open.delete(event.index ?? 0);
            calls.push({ ...call, arguments: call.arguments || "{}" });
          }
        } else if (event.type === "message_delta") {
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          stopReason = event.delta?.stop_reason ?? stopReason;
        } else if (event.type === "error") {
          throw new OwnAIError("own_ai_failed", `Anthropic failed: ${event.error?.message ?? event.error?.type ?? "unknown error"}`, {
            kind: KIND
          });
        } else if (event.type === "message_stop") {
          stopped = true;
          break;
        }
      }
      if (!stopped) throw streamEnded(KIND);
      const cut = stopReason === "max_tokens" || stopReason === "refusal";
      const complete = cut ? [] : calls;
      if (complete.some((call) => !call.name)) throw callWithNoName(KIND);
      for (const call of complete) yield { type: "tool_call", call };
      yield {
        type: "done",
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        ...cut ? { incomplete: { reason: stopReason === "refusal" ? "content_filter" : "max_output_tokens" } } : {}
      };
    }
  };
}

// packages/sdk/src/own-ai/openai-compatible.ts
var KIND2 = "openai-compatible";
var chatTool = ({ name, description, parameters, strict }) => ({
  type: "function",
  function: { name, ...description !== void 0 ? { description } : {}, parameters, ...strict !== void 0 ? { strict } : {} }
});
var chatToolChoice = (choice) => typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
function openAICompatibleAdapter(config, env) {
  const fields = config;
  const baseUrl = requireHttpUrl(requireField(fields, "baseUrl", "base URL", KIND2), "base URL", KIND2).href.replace(/\/+$/, "");
  const model = requireField(fields, "model", "model name", KIND2);
  const apiKey = typeof fields.apiKey === "string" && fields.apiKey.trim() !== "" ? fields.apiKey.trim() : void 0;
  return {
    tools: true,
    async *stream(request) {
      const body = await postForStream(
        env.fetch,
        `${baseUrl}/chat/completions`,
        apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        {
          model,
          messages: toChatCompletionsMessages(request.input, request.instructions),
          stream: true,
          // Only when set: some servers refuse a member that they do not know, and a tool choice with no tools.
          // With no tools, the Kapai server drops the choice and the parallel flag too.
          ...request.tools?.length ? {
            tools: request.tools.map(chatTool),
            ...request.toolChoice !== void 0 ? { tool_choice: chatToolChoice(request.toolChoice) } : {},
            ...request.parallelToolCalls !== void 0 ? { parallel_tool_calls: request.parallelToolCalls } : {}
          } : {},
          ...request.maxOutputTokens !== void 0 ? { max_tokens: request.maxOutputTokens } : {},
          ...request.temperature !== void 0 ? { temperature: request.temperature } : {}
        },
        KIND2,
        request.signal
      ).catch((err) => {
        throw toolsRefused(err, request);
      });
      let usage;
      let finished = false;
      let cut;
      const calls = /* @__PURE__ */ new Map();
      let open = 0;
      for await (const { data } of readSse(body)) {
        if (data === "[DONE]") {
          finished = true;
          break;
        }
        const chunk = JSON.parse(data);
        if (chunk.error) {
          const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? "Unknown error.";
          throw new OwnAIError("own_ai_failed", `Your AI provider failed: ${message}`, { kind: KIND2 });
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield { type: "text", delta };
        for (const part of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
          let index = part.index ?? open;
          if (part.index === void 0 && part.id && calls.has(index) && calls.get(index).callId !== part.id) index = Math.max(...calls.keys()) + 1;
          open = index;
          let call = calls.get(index);
          if (!call) calls.set(index, call = { callId: part.id || newCallId(), name: "", arguments: "" });
          call.name ||= part.function?.name ?? "";
          const args = part.function?.arguments;
          if (args != null) call.arguments += typeof args === "string" ? args : JSON.stringify(args);
        }
        const reason = chunk.choices?.[0]?.finish_reason;
        if (reason) finished = true;
        if (reason === "length" || reason === "content_filter") cut = reason;
        if (chunk.usage) {
          const input = chunk.usage.prompt_tokens ?? 0;
          const output = chunk.usage.completion_tokens ?? 0;
          usage = { input_tokens: input, output_tokens: output, total_tokens: chunk.usage.total_tokens ?? input + output };
        }
      }
      if (!finished) throw streamEnded(KIND2);
      const ordered = cut ? [] : [...calls].sort(([a], [b]) => a - b).map(([, c]) => c);
      if (ordered.some((call) => !call.name)) throw callWithNoName(KIND2);
      for (const call of ordered) yield { type: "tool_call", call };
      yield { type: "done", ...usage ? { usage } : {}, ...cut ? { incomplete: { reason: cut === "content_filter" ? "content_filter" : "max_output_tokens" } } : {} };
    }
  };
}

// packages/sdk/src/own-ai/registry.ts
var factories = /* @__PURE__ */ new Map([
  ["openai-compatible", openAICompatibleAdapter],
  ["anthropic", anthropicAdapter]
]);
function registerOwnAIAdapter(kind, factory) {
  factories.set(kind, factory);
}
function ownAIKinds() {
  return [...factories.keys()];
}
function createOwnAIAdapter(config, env) {
  const factory = factories.get(config.kind);
  if (!factory) {
    throw new OwnAIError("own_ai_unknown_kind", `This runtime cannot run "${config.kind}". Pick another AI source.`, { kind: config.kind });
  }
  return factory(config, env);
}

// packages/sdk/src/source.ts
function selectSource(inputs) {
  if (inputs.policy === "off") return inputs.circuitOpen ? "unavailable" : "kapai";
  if (inputs.hasConfig && (inputs.circuitOpen || inputs.policy === "anytime" && inputs.prefersOwnAI)) return "own";
  return inputs.circuitOpen ? "unavailable" : "kapai";
}

// packages/sdk/src/storage-idb.ts
var DB_NAME = "kapai-state";
var STORE = "values";
function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function indexedDbStorage(given) {
  const memory = /* @__PURE__ */ new Map();
  let db;
  const open = () => {
    db ??= new Promise((resolve) => {
      try {
        const factory = given ?? globalThis.indexedDB;
        if (!factory) return resolve(null);
        const request = factory.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return db;
  };
  const store = async (mode) => (await open())?.transaction(STORE, mode).objectStore(STORE);
  return {
    async get(key) {
      const values = await store("readonly");
      if (!values) return memory.get(key) ?? null;
      const value = await done(values.get(key));
      return typeof value === "string" ? value : null;
    },
    async set(key, value) {
      const values = await store("readwrite");
      if (!values) return void memory.set(key, value);
      await done(values.put(value, key));
    },
    async remove(key) {
      const values = await store("readwrite");
      if (!values) return void memory.delete(key);
      await done(values.delete(key));
    }
  };
}

// packages/sdk/src/storage.ts
function memoryStorage() {
  const map = /* @__PURE__ */ new Map();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key)
  };
}
function webStorage(storage) {
  const fallback = /* @__PURE__ */ new Map();
  return {
    get(key) {
      if (fallback.has(key)) return fallback.get(key);
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        storage.setItem(key, value);
        fallback.delete(key);
      } catch {
        fallback.set(key, value);
      }
    },
    remove(key) {
      fallback.delete(key);
      try {
        storage.removeItem(key);
      } catch {
      }
    }
  };
}
function browserGlobal(name) {
  const worker = typeof globalThis.WorkerGlobalScope !== "undefined";
  if (typeof globalThis.window === "undefined" && !worker) return void 0;
  try {
    return globalThis[name];
  } catch {
    return void 0;
  }
}
function defaultStorage() {
  const local = browserGlobal("localStorage");
  if (local) return webStorage(local);
  const factory = browserGlobal("indexedDB");
  return factory ? indexedDbStorage(factory) : memoryStorage();
}
function memoryKeyStore() {
  let keys = null;
  return {
    load: async () => keys,
    create: async () => keys = await generateKeyPair(false),
    clear: async () => void (keys = null)
  };
}
var DB_NAME2 = "kapai";
var STORE2 = "keys";
function done2(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function indexedDbKeyStore(name, factory = indexedDB) {
  const memory = memoryKeyStore();
  let db;
  const open = () => {
    db ??= new Promise((resolve) => {
      try {
        const request = factory.open(DB_NAME2, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return db;
  };
  const store = (db2, mode) => db2.transaction(STORE2, mode).objectStore(STORE2);
  const load = async () => {
    const db2 = await open();
    if (!db2) return memory.load();
    const value = await done2(store(db2, "readonly").get(name));
    return value ? { publicKey: value.publicKey, privateKey: value.privateKey } : null;
  };
  return {
    load,
    async create() {
      const db2 = await open();
      if (!db2) return memory.create();
      const keys = await generateKeyPair(false);
      try {
        await done2(store(db2, "readwrite").add({ publicKey: keys.publicKey, privateKey: keys.privateKey }, name));
        return keys;
      } catch (err) {
        const first = await load();
        if (first) return first;
        throw err;
      }
    },
    async clear() {
      const db2 = await open();
      if (!db2) return memory.clear();
      await done2(store(db2, "readwrite").delete(name));
    }
  };
}
function defaultKeyStore(name) {
  const factory = browserGlobal("indexedDB");
  return factory ? indexedDbKeyStore(name, factory) : memoryKeyStore();
}

// packages/sdk/src/client.ts
var isSetupFault = (err) => err instanceof KapaiError && (err.code === "origin_not_allowed" || err.code === "invalid_publishable_key");
var DEFAULT_IDLE_TIMEOUT_MS = 6e4;
var ENTITLEMENT_MAX_AGE_MS = 6e4;
var CLAIM_WARNINGS = {
  debug_token_invalid: "Kapai: the debug token is not valid. It expired, was revoked, or belongs to another app. Create a new token in the dashboard.",
  test_device_limit: "Kapai: this app has its most test devices. Remove a test mark on the Installs page, or raise the limit in Settings.",
  test_device_has_customer: "Kapai: this install has a paid plan. A test device cannot have one. Claim the token on another install.",
  invalid_request: "Kapai: the server refused the debug token."
};
function takeDebugParameter() {
  const g = globalThis;
  const search = g.location?.search;
  if (!search) return null;
  const parts = search.slice(1).split("&");
  const isDebug = (part) => {
    try {
      return decodeURIComponent(part.split("=")[0].replace(/\+/g, " ")) === "kapai_debug";
    } catch {
      return false;
    }
  };
  const kept = parts.filter((part) => !isDebug(part));
  if (kept.length === parts.length) return null;
  const token = new URLSearchParams(search).get("kapai_debug");
  const url = new URL(g.location.href);
  url.search = kept.length ? `?${kept.join("&")}` : "";
  g.history?.replaceState?.(g.history.state, "", url.href);
  return token || null;
}
var memberWarning = (name) => name === "model" ? "Kapai: the SDK does not send `model`. The model is the app's setting in the Kapai dashboard." : `Kapai: the SDK does not send \`${name}\`. Kapai does not know this member of a request.`;
var SIGN_OUT_TIMEOUT_MS = 3e3;
var RANK = { free: 0, pro: 1, unlimited: 2 };
function betterPlan(before, now) {
  if (!before) return false;
  if ((RANK[now.tier] ?? 0) > (RANK[before.tier] ?? 0)) return true;
  return now.status !== before.status && (now.status === "active" || now.status === "trial");
}
function limitLifted(refusal, now) {
  const { requestsToday, requestsPerDay } = now.usage;
  return refusal.reason === "daily_requests" && (requestsPerDay === null || (requestsToday ?? 0) < requestsPerDay);
}
function answerAdapter(respond) {
  let warned = false;
  return {
    tools: true,
    async *stream(request) {
      const answer = respond(request);
      if (typeof answer === "object" && answer !== null && Symbol.asyncIterator in answer) {
        for await (const event of answer) {
          yield event;
          if (event.type === "done") return;
        }
      } else {
        const text = await answer;
        if (typeof text !== "string") throw new OwnAIError("own_ai_failed", `Your own-AI respond returned ${text === null ? "null" : typeof text}. Return a string, or an async iterable of events.`);
        if (!warned && isToolRequest(request)) {
          warned = true;
          console.warn("Kapai: your own-AI respond returned text for a request with tools. Return an async iterable of events to pass tool calls.");
        }
        yield { type: "text", delta: text };
      }
      yield { type: "done" };
    }
  };
}
var ownAINoTools = (kind) => new OwnAIError("own_ai_no_tools", "Your own AI cannot use tool calls. Switch to the included AI, or choose an AI source that takes tools.", { kind });
async function* streamOwnAI(adapter, request, options) {
  throwIfAborted(request.signal);
  let text = "";
  const toolCalls = [];
  let first = true;
  const controller = new AbortController();
  const timed = !adapter.hasOwnTimeout;
  const timedOut = () => new OwnAIError("own_ai_timeout", `Your AI did not answer for ${Math.round(options.idleTimeoutMs / 1e3)} seconds.`, {
    kind: options.kind()
  });
  let events;
  try {
    events = adapter.stream(timed ? { ...request, signal: controller.signal } : request)[Symbol.asyncIterator]();
    for (; ; ) {
      const next = await (timed ? withTimeout(events.next(), options.idleTimeoutMs, controller, request.signal, timedOut) : events.next());
      if (next.done) break;
      const event = next.value;
      if (first) options.onFirst?.();
      first = false;
      if (event.type === "text") {
        text += event.delta;
        yield event;
      } else if (event.type === "tool_call") {
        toolCalls.push(event.call);
        yield event;
      } else if (event.type === "done") {
        options.onDone?.();
        const calls = toolCalls.map((call, i) => ({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments, id: `fc_own_${i + 1}`, status: "completed", ...call.providerData !== void 0 ? { providerData: call.providerData } : {} }));
        const output = text || calls.length === 0 ? [outputMessage("msg_own", text), ...calls] : calls;
        yield { type: "done", text, source: "own", toolCalls, output, ...event.usage ? { usage: event.usage } : {}, ...event.incomplete ? { incomplete: event.incomplete } : {} };
        return;
      }
    }
  } catch (err) {
    if (err instanceof OwnAIError || request.signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new OwnAIError("own_ai_failed", `Your own AI failed: ${message}`, { kind: options.kind() });
  } finally {
    void events?.return?.(void 0).catch(() => {
    });
  }
  throw streamEnded(options.kind());
}
var Kapai = class {
  ai = {
    /** Sends a request and returns the full answer. */
    respond: (request) => this.respond(request),
    /** Sends a request and streams the answer. */
    stream: (request) => this.run(request, false),
    /** Runs a tool loop: each round is one `respond`, and `handlers` run the calls of the model. 5 rounds by default. */
    runTools: (request, options) => runTools((round) => this.respond(round), request, options),
    /**
     * Sends one recording to speech to text and returns its text. Only the included AI transcribes.
     * It checks the size and the type before the upload.
     */
    transcribe: (audio, options) => this.transcribe(audio, options),
    /**
     * Asks typed questions about a state: `noul` (yes or no), `choice`, and `score`. Only the included AI decides.
     * Before the request, it checks the state and the number of questions. It refuses a data URL (an image or a
     * document as text) and a `fields` member.
     */
    decide: async (request) => this.included("/v1/systemone", { method: "POST", body: JSON.stringify(systemOneBody("questions", request)) }, request.signal, SYSTEMONE_TIMEOUT_MS, systemOneNeedsIncludedAI),
    /**
     * Reads typed fields from a state, each with a confidence. Only the included AI extracts.
     * Before the request, it checks the state and the number of fields. It refuses a data URL (an image or a
     * document as text) and a `questions` member.
     */
    extract: async (request) => this.included("/v1/systemone", { method: "POST", body: JSON.stringify(systemOneBody("fields", request)) }, request.signal, SYSTEMONE_TIMEOUT_MS, systemOneNeedsIncludedAI)
  };
  /** The user's own AI. The config stays on the device. The SDK never sends it to Kapai. */
  ownAI = {
    /** Saves a config, or removes it with null. Throws OwnAIError when the config is not valid. */
    configure: async (config) => {
      await this.configureOwnAI(config);
      this.ownAIChanged();
    },
    get: () => this.state.get("ownAI")?.config ?? null,
    /** Asks for own AI on every call. It applies only when the app's policy is `anytime`. */
    prefer: async (value) => {
      await this.state.ready;
      await this.state.update("ownAI", (saved) => ({ config: saved?.config ?? null, prefer: value }));
      this.ownAIChanged();
    },
    /** Tells the elements that the app changed its own AI (see the `ownAI` option). They draw again. */
    changed: () => this.ownAIChanged(),
    /** The own AI that the app manages, from the `ownAI` option, or undefined. */
    managed: () => this.managedOwnAI,
    /**
     * True when the user's own AI may answer now: the app's policy is `anytime`, or Kapai is down. Never under `off`.
     * With an app-managed own AI, the app checks this before it sends a request to the user's service.
     */
    canUse: () => {
      const configured = this.managedOwnAI ? this.managedOwnAI.state().state !== "none" && this.managedOwnAI.state().state !== "notSetUp" : this.ownAI.get() !== null;
      const policy = this.state.get("entitlement")?.value.app.ownAIPolicy;
      if (!configured || policy === "off") return false;
      return policy === "anytime" || this.breaker.isOpen() || this.kapaiUnusable;
    },
    isPreferred: () => this.prefersOwn(),
    /** Sends a short request to the user's own AI. It never throws. */
    test: () => this.testOwnAI(),
    /** The config kinds this runtime can run. */
    kinds: () => ownAIKinds()
  };
  /**
   * Resolves when the saved state is in memory. With a sync storage (the defaults), it is ready at once.
   * With an async storage, await it before you read `kapai.ownAI.get()` or `kapai.ownAI.isPreferred()`.
   */
  ready;
  http;
  state;
  session;
  idleTimeoutMs;
  clock;
  listeners = {
    entitlement: /* @__PURE__ */ new Set(),
    source: /* @__PURE__ */ new Set(),
    paywall: /* @__PURE__ */ new Set(),
    ownAI: /* @__PURE__ */ new Set(),
    limit: /* @__PURE__ */ new Set()
  };
  breaker;
  managedOwnAI;
  /** The adapter of the app's `respond`, made at the first request. */
  appAdapter;
  /**
   * True when Kapai cannot be used at all: a setup fault (such as a refused origin), or no plan was ever read and
   * the server cannot be reached. Then the policy is unknown or moot, and the user's own key may answer.
   */
  kapaiUnusable = false;
  noteFailure(err) {
    if (isSetupFault(err)) this.kapaiUnusable = true;
    else if (err instanceof KapaiUnavailableError && !this.state.get("entitlement")) this.kapaiUnusable = true;
  }
  openUrl;
  showPage;
  appearance;
  lastSource;
  entitlementStale = false;
  /** Counts the calls to `markEntitlementStale`. A fetch uses it to find a mark that arrived while it ran. */
  staleMarks = 0;
  /** Emit the next fetched entitlement, also when it did not change. */
  emitNextEntitlement = false;
  fetchingEntitlement = null;
  /** The debug token to claim before the next authorized call, or null. */
  pendingDebug;
  claiming = null;
  /** The codes of the refused claims that warned already. Each code warns one time. */
  claimWarned = /* @__PURE__ */ new Set();
  /** The request members that warned already. Each name warns one time. */
  memberWarned = /* @__PURE__ */ new Set();
  constructor(options) {
    if (!options.baseUrl) throw new TypeError("Kapai: set baseUrl to your Kapai server.");
    const fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.http = {
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      fetch: fetchFn,
      firstByteTimeoutMs: options.firstByteTimeoutMs ?? 2e4
    };
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const clock = options.clock ?? Date.now;
    this.clock = clock;
    this.breaker = new CircuitBreaker(clock);
    this.openUrl = options.openUrl;
    this.showPage = options.showPage;
    this.appearance = options.appearance;
    this.managedOwnAI = options.ownAI?.respond ? this.routed(options.ownAI) : options.ownAI;
    this.state = new StateStore(options.storage ?? defaultStorage(), options.publishableKey);
    this.ready = this.state.ready;
    this.session = new Session({
      http: this.http,
      publishableKey: options.publishableKey,
      state: this.state,
      keyStore: options.keyStore ?? defaultKeyStore(options.publishableKey),
      clock,
      platform: detectPlatform({ appName: options.appName }),
      ...options.appVersion ? { appVersion: options.appVersion } : {}
    });
    const launch = options.debug === false ? null : takeDebugParameter();
    this.pendingDebug = typeof options.debug === "string" && options.debug || launch;
    void this.state.ready.then(() => {
      const cached = this.state.get("entitlement")?.value;
      if (cached?.testDevice == null) return;
      this.markEntitlementStale();
      this.showPill(cached);
    });
    if (consumeReturnMarker()) this.refreshAfterReturn();
  }
  showPill(entitlement) {
    if (entitlement?.testDevice != null) devPill?.(this);
  }
  /**
   * The browser came back from a same-tab paywall. The plan may have changed, so the cache is out of date.
   * Listeners that subscribe right after the constructor get the "entitlement" event.
   */
  refreshAfterReturn() {
    this.markEntitlementStale();
    this.emitNextEntitlement = true;
    this.entitlement().catch(() => {
    });
  }
  /** The app's own primary color from the `appearance` option, or undefined. The elements use it in each state. */
  brandColor() {
    return this.appearance?.variables?.colorPrimary;
  }
  /**
   * The limit that stops the user now, or null. It clears by itself when a request goes through, when a purchase or
   * a restore gives a better plan, when its reset time passes, and when the user's own key takes over the answers.
   * It also clears when a fresh plan shows requests left today, or a trial again after a read of "free", such as after
   * the developer raised a limit.
   * `<kapai-limit-prompt>` shows it, so the app shows no limit text of its own. The `limit` event tells each change.
   */
  limit() {
    return this.limitNow;
  }
  limitNow = null;
  /** The plan at the refusal. A better plan ends the limit. */
  limitPlan;
  limitTimer;
  setLimit(value) {
    clearTimeout(this.limitTimer);
    if (!value && !this.limitNow) return;
    this.limitNow = value;
    this.limitPlan = this.state.get("entitlement")?.value;
    if (value?.resetsAt) this.armLimitTimer(Date.parse(value.resetsAt));
    this.emit("limit", value);
  }
  armLimitTimer(at) {
    const wait = Math.min(Math.max(0, at - this.clock()), 2 ** 31 - 1);
    this.limitTimer = setTimeout(() => this.clock() >= at ? this.setLimit(null) : this.armLimitTimer(at), wait);
    this.limitTimer.unref?.();
  }
  /** The user's own AI changed. When the user's own key answers now, the limit of the included AI no longer stops the user. */
  ownAIChanged() {
    this.emit("ownAI", void 0);
    if (this.limitNow && this.ownAdapter() && this.choose(true) === "own") this.setLimit(null);
  }
  /** The source of the next request with the cached policy (spec 6.3). */
  choose(hasConfig) {
    const policy = this.state.get("entitlement")?.value.app.ownAIPolicy ?? "outage_only";
    return selectSource({ policy, prefersOwnAI: this.prefersOwn(), hasConfig, circuitOpen: this.breaker.isOpen() });
  }
  /**
   * The user's choice of their own key. An app-managed key with no switch of the app: the SDK keeps the choice, and
   * a key that the user saved in the app is in use until the user chooses included AI. So a user who had a key
   * before the integration keeps it under `anytime`.
   */
  prefersOwn() {
    const managed = this.managedOwnAI;
    if (managed?.respond) return managed.isActive ? managed.isActive() : this.state.get("ownAI")?.prefer ?? true;
    return this.state.get("ownAI")?.prefer ?? false;
  }
  /**
   * An app-managed own AI that gives `respond`: the SDK routes each request, so the card and the pill show the
   * source that answers. The app's `isFallback` does not decide it. Its `isActive`, when given, is the user's choice.
   */
  routed(app) {
    return {
      ...app,
      state: () => {
        const own = app.state();
        if (own.state === "none" || own.state === "notSetUp") return own;
        const policy = this.state.get("entitlement")?.value.app.ownAIPolicy ?? "outage_only";
        if (policy === "off") return { state: "none" };
        if (policy === "anytime" && this.prefersOwn()) return own.state === "invalid" ? own : { state: "active", label: own.label };
        if (this.breaker.isOpen() || this.kapaiUnusable) return { state: "fallback", label: own.label };
        return { state: "available", label: own.label };
      },
      setActive: app.setActive ?? ((active) => this.ownAI.prefer(active))
    };
  }
  /**
   * How the SDK reaches Kapai now: "unavailable" while Kapai is down (the SDK waits before it calls again), else
   * "online". The browser's own online state comes on top. The elements show it on the card.
   */
  connection() {
    return this.breaker.isOpen() ? "unavailable" : "online";
  }
  /** Listens for an event. Returns a function that stops listening. */
  on(event, listener) {
    const set = this.listeners[event];
    set.add(listener);
    return () => void set.delete(listener);
  }
  /**
   * The install's plan, usage, and app settings. The SDK caches it for 60 seconds and after each AI call fetches it again.
   * Use `refresh: true` to skip the cache.
   * When Kapai is not reachable, it returns the last cached entitlement. With no cache, it throws KapaiUnavailableError.
   */
  async entitlement(options = {}) {
    await this.state.ready;
    const cached = this.state.get("entitlement");
    const fresh = cached && !this.entitlementStale && !this.pendingDebug && this.clock() - cached.fetchedAt < ENTITLEMENT_MAX_AGE_MS;
    if (!options.refresh && fresh) return cached.value;
    this.fetchingEntitlement ??= this.fetchEntitlement().finally(() => this.fetchingEntitlement = null);
    try {
      return await this.fetchingEntitlement;
    } catch (err) {
      this.noteFailure(err);
      const last = this.state.get("entitlement");
      if (last && err instanceof KapaiUnavailableError) return last.value;
      throw err;
    }
  }
  /**
   * The cache stays stale while the fetch runs, so other callers wait for the new value.
   * A failed fetch also removes the mark, so offline callers get the cache at once and do not each wait for a timeout.
   * A mark that arrived while the fetch ran stays: this fetch can be older than that change.
   */
  async fetchEntitlement() {
    const marks = this.staleMarks;
    const generation = this.session.generation;
    const limit = this.limitNow;
    try {
      const { response } = await this.authorized("/v1/entitlement", { method: "GET" });
      const value = await readJson(response);
      this.kapaiUnusable = false;
      if (generation !== this.session.generation) return value;
      await this.cacheEntitlement(value);
      if (this.limitNow && this.limitNow === limit) {
        if (betterPlan(this.limitPlan, value) || limitLifted(this.limitNow, value)) this.setLimit(null);
        else if (this.limitNow.reason === "trial_ended" && value.status === "free") this.limitPlan = value;
        else this.limitPlan ??= value;
      }
      return value;
    } finally {
      if (this.staleMarks === marks) this.entitlementStale = false;
    }
  }
  /** Saves a fetched entitlement, and emits it when it changed. */
  async cacheEntitlement(value) {
    const previous = this.state.get("entitlement")?.value;
    await this.state.set("entitlement", { value, fetchedAt: this.clock() });
    if (this.emitNextEntitlement || JSON.stringify(previous) !== JSON.stringify(value)) {
      this.emitNextEntitlement = false;
      this.emit("entitlement", value);
    }
    this.showPill(value);
  }
  markEntitlementStale() {
    this.entitlementStale = true;
    this.staleMarks++;
  }
  /**
   * Opens the paywall. Resolves with the new entitlement when the user is done.
   * In a browser it is a modal inside the page, so it needs no click handler.
   * The page shows one modal at a time: a call while a modal is open joins that modal and gets its result.
   * With `tier`, it skips the plan picker: use that for your own pricing UI.
   */
  upgrade(options = {}) {
    return this.paywall("upgrade", options);
  }
  /**
   * Opens the restore page. The user enters the purchase email and a code, and this install gets the plan back.
   * Resolves with the new entitlement when the user is done.
   */
  restore(options = {}) {
    return this.paywall("restore", options);
  }
  /**
   * The app's paid plans with their prices, for your own pricing UI.
   * Start the purchase of one with `kapai.upgrade({ tier, interval })`.
   */
  async plans() {
    const entitlement = await this.entitlement();
    return entitlement.prices.map((price) => ({ ...price, current: price.tier === entitlement.tier && price.interval === entitlement.interval }));
  }
  /** Opens the account page: change or cancel the plan, update the card, see invoices and devices. */
  manage(options = {}) {
    return this.paywall("manage", options);
  }
  /**
   * Opens the developer page of a test device: refill the trial credits, act as each plan state, use the offline AI,
   * reset the install, or remove the test mark. Resolves with the new entitlement when the page closes.
   * With `openUrl`, it resolves when `openUrl` returns. An install that is not a test device gets `not_test_device`.
   */
  developer(options = {}) {
    return this.paywall("developer", options);
  }
  /**
   * Opens the payment provider's form that updates the payment method, for a payment that is past due.
   * In a browser page it opens in a new tab, because the provider's page refuses a frame. Call it in the user's
   * click: a browser blocks a tab that opens later. When the browser blocks it, the account page opens in its place.
   * In an app's own window (`showPage`), the account page opens: it has the same link.
   */
  updatePayment(options = {}) {
    let open = this.openUrl;
    if (this.showPage || !open && typeof window === "undefined") return this.manage(options);
    if (!open) {
      const tab = window.open("", "_blank");
      if (!tab) return this.manage(options);
      tab.opener = null;
      open = async (url) => {
        tab.location.href = url;
        const closed = new Promise((resolve) => {
          const timer = setInterval(() => {
            if (!tab.closed) return;
            clearInterval(timer);
            resolve();
          }, 1e3);
        });
        return { closed };
      };
    }
    const to = open;
    return this.paywall("manage", options, (url) => {
      const card = new URL(url);
      card.pathname += "/card";
      return to(card.toString());
    });
  }
  paywall(mode, options, openUrl = this.openUrl) {
    return openPage(
      {
        openUrl,
        showPage: this.showPage,
        appearance: this.appearance,
        createSession: async (sessionMode, request, signal) => {
          await this.state.ready;
          const { response } = await this.authorized(
            "/v1/paywall/sessions",
            { method: "POST", body: JSON.stringify({ mode: sessionMode, ...deviceTimeZone(), ...request }) },
            signal
          );
          return readJson(response);
        },
        refreshEntitlement: () => this.entitlement({ refresh: true }),
        cachedEntitlement: () => this.state.get("entitlement")?.value,
        emit: (event) => this.emit("paywall", event),
        isDone: async (sessionId, signal) => {
          const { response } = await this.authorized(`/v1/paywall/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" }, signal);
          return (await readJson(response)).done === true;
        },
        reset: () => this.reset()
      },
      mode,
      options
    );
  }
  /**
   * Signs this device out. First it tells Kapai, so the server unlinks the install from the customer.
   * Other devices keep the plan. This step is best effort: it waits max 3 seconds and ignores errors.
   * Then it deletes this install's identity (key pair, install ID, access token, clock offset) and the cached entitlement.
   * It also closes the circuit breaker. The next call registers a new install.
   * The own-AI config and preference stay, unless `keepOwnAI` is false.
   * The debug token stays too, unless `keepDebug` is false: the next call claims it, so the new install is a test device.
   */
  async reset(options = {}) {
    await this.state.ready;
    await this.signOut();
    this.session.generation++;
    await this.session.resetIdentity();
    await Promise.all([
      this.state.remove("clockOffset"),
      this.state.remove("entitlement"),
      options.keepOwnAI === false ? this.state.remove("ownAI") : void 0,
      options.keepDebug === false ? this.state.remove("debugToken") : void 0
    ]);
    this.pendingDebug = options.keepDebug === false ? null : this.state.get("debugToken") ?? this.pendingDebug;
    this.breaker.reset();
    this.setLimit(null);
    this.entitlementStale = false;
    this.fetchingEntitlement = null;
  }
  /** POST /v1/install/sign-out with the saved install's token. It never registers an install and never throws. */
  async signOut() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIGN_OUT_TIMEOUT_MS);
    const request = async () => {
      const token = await this.session.currentToken(controller.signal);
      if (!token) return;
      const { response } = await send(this.http, "/v1/install/sign-out", { method: "POST", headers: { authorization: `Bearer ${token}` } }, controller.signal);
      await response.body?.cancel();
    };
    try {
      await raceAbort(request(), controller.signal);
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }
  emit(event, value) {
    for (const listener of this.listeners[event]) {
      try {
        listener(value);
      } catch (err) {
        console.error(`[kapai] a "${event}" listener failed`, err);
      }
    }
  }
  async respond(request) {
    for await (const event of this.run(request, true)) {
      if (event.type === "done") {
        const { type: _type, ...result } = event;
        return result;
      }
    }
    throw new KapaiError("no_answer", "The answer ended too early.");
  }
  /**
   * Picks the source (spec 6.3) and streams the answer.
   * With `lateFallback`, an outage after some text still falls back, because the caller has not seen the text yet.
   */
  async *run(request, lateFallback) {
    checkRequest(request, (name) => {
      if (this.memberWarned.has(name)) return;
      this.memberWarned.add(name);
      console.warn(memberWarning(name));
    });
    const { policy, own, choice } = await this.source();
    if (choice === "unavailable") throw this.circuitOpenError();
    const fallback = own && (own.tools === true || !isToolRequest(request)) ? own : null;
    if (choice === "own") {
      if (!fallback) throw this.breaker.isOpen() ? this.circuitOpenError() : ownAINoTools(this.ownAI.get()?.kind);
      yield* this.streamOwn(fallback, request);
      return;
    }
    let sentText = false;
    try {
      const errorContext = { canUseOwnAI: policy === "anytime" && fallback !== null, upgrade: () => this.upgrade() };
      for await (const event of this.streamKapai(request, errorContext)) {
        if (event.type !== "done") sentText = true;
        yield event;
      }
    } catch (err) {
      this.noteFailure(err);
      if (isSetupFault(err) && fallback && !sentText) {
        yield* this.streamOwn(fallback, request);
        return;
      }
      if (!(err instanceof KapaiUnavailableError)) {
        if (err instanceof KapaiError && err.status > 0) this.breaker.recordSuccess();
        throw err;
      }
      if (err.code !== "registration_timeout") this.breaker.recordOutage();
      if (fallback && (lateFallback || !sentText)) {
        yield* this.streamOwn(fallback, request);
        return;
      }
      throw err;
    }
  }
  /** The source of the next AI request (spec 6.3), with the policy and the user's own AI that it used. */
  async source() {
    await this.state.ready;
    const adapter = this.ownAdapter();
    const prefersOwnAI = this.prefersOwn();
    const policy = await this.policy(prefersOwnAI && adapter !== null);
    const own = policy === "off" ? null : adapter;
    const choice = selectSource({ policy, prefersOwnAI, hasConfig: own !== null, circuitOpen: this.breaker.isOpen() });
    return { policy, own, choice };
  }
  circuitOpenError() {
    return new KapaiUnavailableError("circuit_open", "The AI service is not available right now. Try again soon.", 0, {
      retryAt: new Date(this.breaker.openUntil()).toISOString()
    });
  }
  async transcribe(audio, options = {}) {
    const form = await audioForm(audio, options);
    return this.included("/v1/transcriptions", { method: "POST", body: form }, options.signal, TRANSCRIBE_TIMEOUT_MS, includedAIOnly);
  }
  /**
   * One request of a route that only the included AI answers, such as speech to text. `ownError` is the error when the
   * user's own AI is the source. Only a server that gives no answer opens the breaker.
   */
  async included(path, init, signal, timeoutMs, ownError) {
    const { choice } = await this.source();
    if (choice === "own" && !this.breaker.isOpen()) throw ownError();
    if (choice !== "kapai") throw this.circuitOpenError();
    const answer = { tier: null };
    let failure;
    try {
      const { response } = await this.authorized(path, init, signal, { upgrade: () => this.upgrade() }, (r) => answer.tier = r.headers.get("kapai-tier"), timeoutMs);
      const result = await readJson(response);
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      failure = err;
      if (isSetupFault(err) || serverDown(err)) this.noteFailure(err);
      if (serverDown(err)) this.breaker.recordOutage();
      else if (err instanceof KapaiError && err.status > 0) this.breaker.recordSuccess();
      throw err;
    } finally {
      this.syncAfterCall(answer.tier, failure);
    }
  }
  async *streamKapai(request, errorContext) {
    let first = true;
    const answer = { tier: null };
    let failure;
    try {
      const started = Date.now();
      const { response, controller } = await this.authorized(
        "/v1/responses",
        { method: "POST", body: responsesBody(request) },
        request.signal,
        errorContext,
        (r) => answer.tier = r.headers.get("kapai-tier")
      );
      const remaining = Math.max(0, this.http.firstByteTimeoutMs - (Date.now() - started));
      for await (const event of readResponseStream(response.body, {
        firstEventTimeoutMs: remaining,
        idleTimeoutMs: this.idleTimeoutMs,
        controller,
        errorContext,
        ...request.signal ? { signal: request.signal } : {}
      })) {
        if (first) {
          first = false;
          this.breaker.recordSuccess();
          this.setSource("kapai");
        }
        yield event.type === "done" ? { ...event, source: "kapai" } : event;
      }
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      this.syncAfterCall(answer.tier, failure);
    }
  }
  /**
   * Plan sync after a Kapai AI call. The plan can change on another device, on the account page, or when a payment fails.
   * A Kapai-Tier header that differs from the cached tier, or a 402, can show a new plan. Then it refreshes also with no listener.
   * A 429 uses no quota, so the cache stays fresh. This prevents a refresh for each 429 while the install is rate limited.
   * Other calls can use quota, so the cached usage is out of date. Then it refreshes only when something listens.
   */
  syncAfterCall(tier, failure) {
    if (failure instanceof QuotaExceededError) {
      this.setLimit({ reason: failure.reason, resetsAt: failure.resetsAt, message: failure.message, upgradeAvailable: failure.upgradeAvailable });
    } else if (!failure) this.setLimit(null);
    const cached = this.state.get("entitlement")?.value;
    const status = failure instanceof KapaiError ? failure.status : void 0;
    const planChanged = cached !== void 0 && (tier !== null && tier !== cached.tier || status === 402);
    if (status === 429 && !planChanged) return;
    this.markEntitlementStale();
    this.refreshEntitlementSoon(planChanged);
  }
  refreshPending = false;
  /**
   * When something listens for entitlement changes (for example <kapai-account>), refresh usage in the background.
   * With `force`, it refreshes also with no listener, so the cached plan is correct. Callers share one refresh.
   */
  refreshEntitlementSoon(force = false) {
    if (!force && this.listeners.entitlement.size === 0 || this.refreshPending) return;
    this.refreshPending = true;
    setTimeout(() => {
      this.refreshPending = false;
      this.entitlement().catch(() => {
      });
    }, 0);
  }
  streamOwn(adapter, request, announce = true) {
    return streamOwnAI(adapter, request, {
      idleTimeoutMs: this.idleTimeoutMs,
      kind: () => this.ownAI.get()?.kind,
      // The user's own key answered, so no limit stops the user now.
      ...announce ? { onFirst: () => this.setSource("own"), onDone: () => this.setLimit(null) } : {}
    });
  }
  /** The app's own-AI policy from the cached entitlement. With no cache, it is `outage_only`. */
  async policy(needed) {
    const entry = this.state.get("entitlement");
    let cached = entry?.value;
    if (!cached && needed && !this.breaker.isOpen()) cached = await this.entitlement().catch(() => void 0);
    else if (entry && needed && !this.breaker.isOpen() && this.clock() - entry.fetchedAt >= ENTITLEMENT_MAX_AGE_MS) this.refreshEntitlementSoon(true);
    return cached?.app.ownAIPolicy ?? "outage_only";
  }
  ownAdapter() {
    if (this.managedOwnAI) {
      const respond = this.managedOwnAI.respond;
      const state = this.managedOwnAI.state().state;
      return respond && state !== "none" && state !== "notSetUp" ? this.appAdapter ??= answerAdapter(respond) : null;
    }
    const config = this.ownAI.get();
    if (!config) return null;
    try {
      return createOwnAIAdapter(config, { fetch: this.http.fetch });
    } catch {
      return null;
    }
  }
  async configureOwnAI(config) {
    await this.state.ready;
    if (config) createOwnAIAdapter(config, { fetch: this.http.fetch });
    const copy = config ? JSON.parse(JSON.stringify(config)) : null;
    await this.state.update("ownAI", (saved) => ({ config: copy, prefer: saved?.prefer ?? false }));
  }
  async testOwnAI() {
    await this.state.ready;
    const config = this.ownAI.get();
    if (!config) return { ok: false, error: new OwnAIError("own_ai_not_configured", "Set up your own AI first.") };
    try {
      const adapter = createOwnAIAdapter(config, { fetch: this.http.fetch });
      let text = "";
      for await (const event of this.streamOwn(adapter, { input: "Reply with the word OK." }, false)) {
        if (event.type === "done") text = event.text;
      }
      return { ok: true, text };
    } catch (err) {
      const error = err instanceof OwnAIError ? err : new OwnAIError("own_ai_failed", err instanceof Error ? err.message : String(err), { kind: config.kind });
      return { ok: false, error };
    }
  }
  setSource(source) {
    if (this.lastSource === source) return;
    this.lastSource = source;
    this.emit("source", source);
  }
  /** Claims the pending debug token one time. Each authorized call waits for the claim, but a claim never fails a call. */
  claimPending(signal) {
    if (this.pendingDebug && !this.claiming) {
      const token = this.pendingDebug;
      this.pendingDebug = null;
      this.claiming = this.claimDebugToken(token).finally(() => this.claiming = null);
    }
    return raceAbort(this.claiming ?? Promise.resolve(), signal);
  }
  /**
   * POST /v1/test-device. A 200 keeps the token and replaces the cached entitlement. A refusal warns one time, and a
   * refused token is deleted. No answer, a rate limit, or an outage: the next call claims again. The breaker sees nothing.
   */
  async claimDebugToken(token) {
    await this.state.ready;
    const generation = this.session.generation;
    const stale = () => generation !== this.session.generation;
    const quietly = (work) => Promise.resolve().then(work).catch(() => void 0);
    try {
      const { response } = await this.request("/v1/test-device", { method: "POST", body: JSON.stringify({ token }) });
      const value = await readJson(response);
      if (stale()) return;
      await quietly(() => this.state.set("debugToken", token));
      await quietly(() => this.cacheEntitlement(value));
    } catch (err) {
      if (stale()) return;
      const code = err instanceof KapaiError ? err.code : "";
      const status = err instanceof KapaiError ? err.status : 0;
      if (code === "debug_token_invalid") await quietly(() => this.state.remove("debugToken"));
      const warning = Object.hasOwn(CLAIM_WARNINGS, code) ? CLAIM_WARNINGS[code] : void 0;
      if (warning && !this.claimWarned.has(code)) {
        this.claimWarned.add(code);
        console.warn(warning);
      }
      if (status === 0 || status === 429 || status >= 500) this.pendingDebug ??= token;
    }
  }
  /** Sends an authorized request, after the claim of a pending debug token. See `request`. */
  async authorized(path, init, signal, errorContext = {}, onResponse, timeoutMs = this.http.firstByteTimeoutMs) {
    await this.claimPending(signal);
    return this.request(path, init, signal, errorContext, onResponse, timeoutMs);
  }
  /**
   * Sends an authorized request. It gets a new token once on `token_expired` or `invalid_token`,
   * and registers a new install once on `install_unknown`. A revoked install (`install_revoked`) is final.
   * `onResponse` gets each HTTP response, also a failed one, before this method throws.
   * `timeoutMs` replaces `firstByteTimeoutMs` for this request.
   */
  async request(path, init, signal, errorContext = {}, onResponse, timeoutMs = this.http.firstByteTimeoutMs) {
    let reauthenticated = false;
    let reregistered = false;
    for (; ; ) {
      const token = await this.session.accessToken(signal);
      const installId = this.session.installId();
      const headers = init.body instanceof FormData ? { authorization: `Bearer ${token}` } : jsonHeaders(token);
      const sent = await send({ ...this.http, firstByteTimeoutMs: timeoutMs }, path, { ...init, headers }, signal);
      onResponse?.(sent.response);
      if (sent.response.ok) return sent;
      const error = await readError(sent.response, errorContext);
      const action = classifyResponse(sent.response.status, error.code);
      if (action === "reauthenticate" && !reauthenticated) {
        reauthenticated = true;
        this.session.invalidateToken(token);
        continue;
      }
      if (action === "reregister" && !reregistered) {
        reregistered = true;
        await this.session.resetIdentity(installId);
        continue;
      }
      throw error;
    }
  }
};

// packages/sdk/src/bridge.ts
function serializeError(err) {
  if (err instanceof KapaiError) {
    return {
      name: err.name,
      message: err.message,
      code: err.code,
      status: err.status,
      details: err.details,
      ...err instanceof RateLimitedError ? { retryAfter: err.retryAfter } : {},
      ...err instanceof OwnAIError && err.kind ? { kind: err.kind } : {},
      ...err instanceof QuotaExceededError ? { canUseOwnAI: err.canUseOwnAI } : {}
    };
  }
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}
function deserializeError(e, upgrade) {
  const code = e.code ?? "bridge_error";
  const status = e.status ?? 0;
  const details = e.details ?? {};
  switch (e.name) {
    case "QuotaExceededError":
      return new QuotaExceededError(code, e.message, status, details, { canUseOwnAI: e.canUseOwnAI ?? false, upgrade });
    case "RateLimitedError":
      return new RateLimitedError(code, e.message, status, details, e.retryAfter ?? 1);
    case "KapaiUnavailableError":
      return new KapaiUnavailableError(code, e.message, status, details);
    case "OwnAIError":
      return new OwnAIError(code, e.message, { ...e.kind ? { kind: e.kind } : {}, status, details });
    case "KapaiError":
      return new KapaiError(code, e.message, status, details);
    case "AbortError":
    case "TimeoutError":
      return new DOMException(e.message, e.name);
    default:
      return Object.assign(new Error(e.message), { name: e.name });
  }
}
var asObject = (value) => value && typeof value === "object" ? value : {};
function aiRequest(value) {
  const { input, instructions, maxOutputTokens, temperature, textFormat, reasoningEffort, tools, toolChoice, parallelToolCalls } = asObject(value);
  return Object.fromEntries(
    Object.entries({ input, instructions, maxOutputTokens, temperature, textFormat, reasoningEffort, tools, toolChoice, parallelToolCalls }).filter(([, v]) => v !== void 0)
  );
}
function paywallOptions(value) {
  const { returnUrl, tier, interval } = asObject(value);
  return Object.fromEntries(Object.entries({ returnUrl, tier, interval }).filter(([, v]) => v !== void 0));
}
function serveKapai(kapai, main) {
  const streams = /* @__PURE__ */ new Map();
  const stops = [
    kapai.on("entitlement", (entitlement) => main.send({ type: "entitlement", entitlement })),
    kapai.on("source", (source) => main.send({ type: "source", source })),
    kapai.on("paywall", (event) => main.send({ type: "paywall", event })),
    kapai.on("limit", (refusal) => main.send({ type: "limit", refusal }))
  ];
  const ownAI = () => ({ config: kapai.ownAI.get(), preferred: kapai.ownAI.isPreferred(), kinds: kapai.ownAI.kinds() });
  const stream = (id, request) => {
    const controller = new AbortController();
    streams.set(id, controller);
    void (async () => {
      let error;
      try {
        for await (const event of kapai.ai.stream({ ...request, signal: controller.signal })) main.send({ type: "stream", id, event });
      } catch (err) {
        error = serializeError(err);
      } finally {
        streams.delete(id);
      }
      main.send({ type: "stream-end", id, ...error ? { error } : {} });
    })();
  };
  const methods = {
    hello: async () => {
      await kapai.ready;
      return { ownAI: ownAI() };
    },
    entitlement: (options) => kapai.entitlement({ refresh: asObject(options).refresh === true }),
    plans: () => kapai.plans(),
    upgrade: (options) => kapai.upgrade(paywallOptions(options)),
    restore: (options) => kapai.restore(paywallOptions(options)),
    manage: (options) => kapai.manage(paywallOptions(options)),
    developer: (options) => kapai.developer(paywallOptions(options)),
    stream: (id, request) => void stream(String(id), aiRequest(request)),
    transcribe: async (id, audio, options) => {
      const { language, prompt, timestamps } = asObject(options);
      const controller = new AbortController();
      streams.set(String(id), controller);
      try {
        return await kapai.ai.transcribe(audio, {
          ...typeof language === "string" ? { language } : {},
          ...typeof prompt === "string" ? { prompt } : {},
          // The client checks the value before the upload.
          ...timestamps !== void 0 ? { timestamps } : {},
          signal: controller.signal
        });
      } finally {
        streams.delete(String(id));
      }
    },
    abort: (id) => void streams.get(String(id))?.abort(),
    "ownAI.configure": async (config) => {
      await kapai.ownAI.configure(config ?? null);
      return ownAI();
    },
    "ownAI.prefer": async (value) => {
      await kapai.ownAI.prefer(value === true);
      return ownAI();
    },
    "ownAI.test": async () => {
      const result = await kapai.ownAI.test();
      return result.ok ? result : { ok: false, error: serializeError(result.error) };
    },
    reset: async (options) => {
      const { keepOwnAI, keepDebug } = asObject(options);
      await kapai.reset({ keepOwnAI: keepOwnAI !== false, keepDebug: keepDebug !== false });
      return ownAI();
    }
  };
  main.handle(async (method, args) => {
    try {
      const fn = Object.hasOwn(methods, method) ? methods[method] : void 0;
      if (!fn) throw new KapaiError("bridge_unknown_method", `The Kapai bridge has no method "${method}".`);
      return { ok: true, value: await fn(...Array.isArray(args) ? args : []) };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  });
  return () => {
    for (const stop of stops) stop();
    for (const controller of streams.values()) controller.abort();
  };
}
async function connectKapai(page) {
  const listeners = { entitlement: /* @__PURE__ */ new Set(), source: /* @__PURE__ */ new Set(), paywall: /* @__PURE__ */ new Set(), ownAI: /* @__PURE__ */ new Set(), limit: /* @__PURE__ */ new Set() };
  const streams = /* @__PURE__ */ new Map();
  let limit = null;
  let policy;
  page.subscribe((message) => {
    if (message.type === "stream" || message.type === "stream-end") streams.get(message.id)?.(message);
    else if (message.type === "entitlement") {
      policy = message.entitlement.app.ownAIPolicy;
      for (const listener of listeners.entitlement) listener(message.entitlement);
    } else if (message.type === "source") for (const listener of listeners.source) listener(message.source);
    else if (message.type === "paywall") for (const listener of listeners.paywall) listener(message.event);
    else if (message.type === "limit") {
      limit = message.refusal;
      for (const listener of listeners.limit) listener(message.refusal);
    }
  });
  const upgrade = (options = {}) => call("upgrade", paywallOptions(options));
  async function call(method, ...args) {
    const result = await page.invoke(method, args);
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
      throw new KapaiError("bridge_missing", "The other process does not serve Kapai. Call serveKapai() there.");
    }
    if (!result.ok) throw deserializeError(result.error, upgrade);
    return result.value;
  }
  let ownAI = (await call("hello")).ownAI;
  const update = (state) => {
    ownAI = state;
    for (const listener of listeners.ownAI) listener();
  };
  async function* stream(request) {
    const { signal, ...rest } = request;
    throwIfAborted(signal);
    const id = crypto.randomUUID();
    const queue = [];
    let wake;
    let ended = false;
    streams.set(id, (message) => {
      queue.push(message);
      wake?.();
    });
    const abort = () => void call("abort", id).catch(() => void 0);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await call("stream", id, rest);
      for (; ; ) {
        while (queue.length === 0) await new Promise((resolve) => wake = resolve);
        const message = queue.shift();
        if (message.type === "stream") yield message.event;
        else if (message.type === "stream-end") {
          ended = true;
          if (message.error) throw deserializeError(message.error, upgrade);
          return;
        }
      }
    } finally {
      streams.delete(id);
      signal?.removeEventListener("abort", abort);
      if (!ended) abort();
    }
  }
  const respond = async (request) => {
    for await (const event of stream(request)) {
      if (event.type !== "done") continue;
      const { type: _type, ...result } = event;
      return result;
    }
    throw new KapaiError("bridge_error", "The answer ended with no result.");
  };
  return {
    limit: () => limit,
    ai: {
      stream,
      respond,
      // The handlers run in the page: a function cannot cross the bridge. Each round crosses it as one respond.
      runTools: (request, options) => runTools(respond, request, options),
      transcribe: async (audio, options = {}) => {
        const { signal, ...rest } = options;
        throwIfAborted(signal);
        await audioForm(audio, rest);
        const bytes = audio instanceof Blob ? new Uint8Array(await audio.arrayBuffer()) : audio;
        const id = crypto.randomUUID();
        const abort = () => void call("abort", id).catch(() => void 0);
        signal?.addEventListener("abort", abort, { once: true });
        try {
          return await raceAbort(call("transcribe", id, bytes, rest), signal);
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      }
    },
    ownAI: {
      configure: async (config) => update(await call("ownAI.configure", config)),
      get: () => ownAI.config,
      prefer: async (value) => update(await call("ownAI.prefer", value)),
      isPreferred: () => ownAI.preferred,
      test: async () => {
        const result = await call("ownAI.test");
        return result.ok ? result : { ok: false, error: deserializeError(result.error, upgrade) };
      },
      kinds: () => [...ownAI.kinds],
      changed: () => {
        for (const listener of listeners.ownAI) listener();
      },
      // shortcut: an app-managed own AI (the `ownAI` option) does not cross the bridge. Give it to the page's client if needed.
      managed: () => void 0,
      // shortcut: the page does not know the breaker of the other process. It answers for the `anytime` choice only.
      canUse: () => policy !== "off" && ownAI.config !== null && ownAI.preferred
    },
    entitlement: async (options = {}) => {
      const entitlement = await call("entitlement", { refresh: options.refresh === true });
      policy = entitlement.app.ownAIPolicy;
      return entitlement;
    },
    plans: () => call("plans"),
    upgrade,
    restore: (options = {}) => call("restore", paywallOptions(options)),
    manage: (options = {}) => call("manage", paywallOptions(options)),
    developer: (options = {}) => call("developer", paywallOptions(options)),
    on: (event, listener) => {
      const set = listeners[event];
      set.add(listener);
      return () => void set.delete(listener);
    },
    reset: async (options = {}) => update(await call("reset", options)),
    // shortcut: the page does not see the breaker of the other process; the browser's online state still shows.
    connection: () => "online",
    // shortcut: the page's elements take the app's color from their CSS (--kapai-brand) or from the plan.
    brandColor: () => void 0
  };
}

// packages/sdk/src/own-ai/app-managed.ts
var KapaiOwnAI = {
  /** An own AI that the app manages. Call `kapai.ownAI.changed()` after the app changes it, so the elements follow. */
  appManaged(options) {
    return {
      state() {
        const label2 = options.label();
        if (options.isActive?.()) {
          const problem = options.problem?.() ?? null;
          return problem ? { state: "invalid", label: label2, problem } : { state: "active", label: label2 };
        }
        if (label2 !== null && options.isFallback?.()) return { state: "fallback", label: label2 };
        return label2 === null ? { state: "notSetUp" } : { state: "available", label: label2 };
      },
      ...options.setActive ? { setActive: options.setActive } : {},
      ...options.openSettings ? { openSettings: options.openSettings } : {},
      ...options.respond ? { respond: options.respond } : {},
      ...options.isActive ? { isActive: options.isActive } : {}
    };
  },
  /** A fixed state. For mocks and pictures. */
  fixed(state) {
    return { state: () => state };
  }
};
var isOwnAIActive = (state) => state.state === "active" || state.state === "invalid" || state.state === "fallback";

// packages/sdk/src/mock.ts
var MOCK_STATES = [
  "loading",
  "free",
  "near-limit",
  "at-limit",
  "low-credits",
  "out-of-credits",
  "free-monthly",
  "trial",
  "pro",
  "pro-canceled",
  "past-due",
  "nothing-for-sale",
  "own-key",
  "offline",
  "service-down",
  "setup-failed",
  "page-open",
  "payment-pending",
  "restore-pending",
  "rate-limited",
  "revoked",
  "suspended"
];
var OFF = {
  transcriptions: "Speech to text is off for this app. The developer turns it on in the dashboard, in the app's Settings, after Kapai turns it on for the developer.",
  decisions: "Decisions are off for this app. The developer turns them on in the dashboard, in the app's Settings, after Kapai turns them on for the developer.",
  extractions: "Extraction is off for this app. The developer turns it on in the dashboard, in the app's Settings, after Kapai turns it on for the developer.",
  tools: "Tool calls are off for this app. The developer turns them on in the dashboard, in the app's Settings, after Kapai turns them on for the developer."
};
var BOTH_OFF = "Decisions and extraction are off for this app. The developer turns them on in the dashboard, in the app's Settings, after Kapai turns them on for the developer.";
var DAY = 864e5;
var PRICES = [
  { tier: "pro", interval: "month", amountCents: 749, creditsPerMonth: 3e6 },
  { tier: "pro", interval: "year", amountCents: 7485, creditsPerMonth: 3e6 }
];
function mockEntitlement(state, options = {}) {
  const now = options.now ?? Date.now();
  const at = (days) => new Date(now + days * DAY).toISOString();
  const tomorrow = new Date(now + DAY);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const monthEnd = at(20);
  const free = (used, requestsToday = 1, requestsPerDay = 5) => ({
    percent: Math.max(Math.min(100, used / 6e4 * 100), requestsPerDay ? 100 * (requestsToday ?? 0) / requestsPerDay : 0),
    requestsToday,
    requestsPerDay,
    resetsAt: monthEnd,
    requestsResetAt: requestsPerDay ? tomorrow.toISOString() : null,
    credits: { used, allowance: 6e4, resetsAt: monthEnd }
  });
  const paid = { maxInputTokens: 64e3, toolsMaxInputTokens: 64e3, maxOutputTokens: 4096 };
  const pro = (fields = {}, status = "active") => ({
    tier: "pro",
    limits: paid,
    status,
    interval: "month",
    customer: { email: "you@example.com" },
    usage: { percent: 12, requestsToday: null, requestsPerDay: null, resetsAt: at(30), requestsResetAt: null, credits: { used: 36e4, allowance: 3e6, resetsAt: at(30) } },
    billing: { tier: "pro", interval: "month", renewsAt: at(30), endsAt: null, cancelAtPeriodEnd: false, graceEndsAt: null, scheduledChange: null, ...fields }
  });
  const states = {
    free: { usage: free(5, 1, 5) },
    "near-limit": { usage: free(20, 4, 5) },
    "at-limit": { usage: free(25, 5, 5) },
    "low-credits": { usage: free(52e3, 1, null) },
    "out-of-credits": { usage: free(6e4, 1, null) },
    "free-monthly": { usage: free(21e3, null, null) },
    trial: {
      status: "trial",
      trial: { endsAt: at(9) },
      limits: paid,
      usage: { percent: 20, requestsToday: null, requestsPerDay: null, resetsAt: at(9), requestsResetAt: null, credits: { used: 6e4, allowance: 3e5, resetsAt: null } }
    },
    pro: pro(),
    "pro-canceled": pro({ renewsAt: null, endsAt: at(12), cancelAtPeriodEnd: true }),
    "past-due": pro({ renewsAt: null, endsAt: at(5), graceEndsAt: at(5) }, "past_due"),
    "nothing-for-sale": { usage: free(10, 2, 5), prices: [] }
  };
  if (state === "loading" || state === "setup-failed" || state === "revoked" || state === "suspended") return void 0;
  return {
    installId: "ins_mock",
    tier: "free",
    status: "free",
    interval: null,
    trial: null,
    usage: free(5, 1, 5),
    limits: { maxInputTokens: 8e3, toolsMaxInputTokens: 16e3, maxOutputTokens: 1024 },
    app: {
      id: "app_mock",
      slug: "mock",
      name: options.appName ?? "My App",
      branding: { primaryColor: options.primaryColor ?? "#2563eb", logoUrl: null },
      ownAIPolicy: options.ownAIPolicy ?? "outage_only"
    },
    customer: null,
    billing: null,
    prices: PRICES,
    ...states[state],
    ...options.testDevice !== void 0 ? { testDevice: options.testDevice } : {}
  };
}
function mockKapai(state, options = {}) {
  let entitlement = options.noPlan && (state === "offline" || state === "service-down") ? void 0 : mockEntitlement(state, options);
  let config = null;
  let preferred = false;
  const appKey = options.ownAI ?? (state === "own-key" ? KapaiOwnAI.fixed({ state: "active", label: "api.openai.com" }) : void 0);
  let keyPreferred = true;
  const ownKey = appKey?.respond ? {
    ...appKey,
    state: () => {
      const own = appKey.state();
      if (own.state === "none" || own.state === "notSetUp") return own;
      if (entitlement?.app.ownAIPolicy === "off") return { state: "none" };
      if (entitlement?.app.ownAIPolicy === "anytime" && (appKey.isActive ? appKey.isActive() : keyPreferred)) return own.state === "invalid" ? own : { state: "active", label: own.label };
      return current === "offline" || current === "service-down" ? { state: "fallback", label: own.label } : { state: "available", label: own.label };
    },
    setActive: appKey.setActive ?? ((active) => (keyPreferred = active, ownAIChanged()))
  } : appKey;
  const listeners = { entitlement: /* @__PURE__ */ new Set(), source: /* @__PURE__ */ new Set(), paywall: /* @__PURE__ */ new Set(), ownAI: /* @__PURE__ */ new Set(), limit: /* @__PURE__ */ new Set() };
  const emit = (event, value) => {
    for (const listener of listeners[event]) {
      try {
        listener(value);
      } catch (err) {
        console.error(`[kapai] a "${event}" listener failed`, err);
      }
    }
  };
  const answeringKey = () => ownKey?.respond && isOwnAIActive(ownKey.state()) ? ownKey.respond : void 0;
  const ownAIChanged = () => {
    emit("ownAI", void 0);
    if (limit && answeringKey()) setLimit(null);
  };
  let lastSource;
  const setSource = (source) => {
    if (lastSource === source) return;
    lastSource = source;
    emit("source", source);
  };
  const resetsAt = entitlement?.usage.credits?.resetsAt ?? entitlement?.usage.resetsAt ?? null;
  let current = state;
  const refusal = () => {
    switch (current) {
      case "at-limit":
        return new QuotaExceededError("quota_exceeded", "Today's limit is reached.", 402, { reason: "daily_requests", resetsAt: entitlement?.usage.requestsResetAt, upgradeAvailable: true });
      case "out-of-credits":
        return new QuotaExceededError("quota_exceeded", "The credits are used.", 402, { reason: "monthly_credits", resetsAt, upgradeAvailable: true });
      case "nothing-for-sale":
        return null;
      case "offline":
      case "service-down":
        return new KapaiUnavailableError("unavailable", "Kapai is not available. Try again soon.", 0);
      case "rate-limited":
        return new RateLimitedError("rate_limited", "Too many requests. Wait a moment.", 429, {}, 10);
      case "setup-failed":
        return new KapaiError("setup_failed", "The setup of included AI failed.", 0);
      case "revoked":
        return new KapaiError("install_revoked", "This install is revoked.", 403);
      case "suspended":
        return new KapaiError("app_suspended", "This app is suspended.", 403);
      case "loading":
        return null;
      default:
        return null;
    }
  };
  let limit = null;
  const setLimit = (value) => {
    if (!value && !limit) return;
    limit = value;
    emit("limit", value);
  };
  const syncLimit = (failure) => {
    if (failure instanceof QuotaExceededError) setLimit({ reason: failure.reason, resetsAt: failure.resetsAt, message: failure.message, upgradeAvailable: failure.upgradeAvailable });
    else if (!failure) setLimit(null);
  };
  const featureRefusal = (capability) => {
    if (!options.off?.includes(capability)) return refusal();
    if ((capability === "decisions" || capability === "extractions") && options.off.includes("decisions") && options.off.includes("extractions")) return new KapaiError("capability_off", BOTH_OFF, 403);
    return new KapaiError("capability_off", OFF[capability], 403, { capability });
  };
  const systemOne = async (shape, request) => {
    const body = systemOneBody(shape, request);
    const own = ownKey?.state().state;
    if (own === "active" || own === "invalid") throw systemOneNeedsIncludedAI();
    throwIfAborted(request.signal);
    const error = featureRefusal(shape === "questions" ? "decisions" : "extractions");
    syncLimit(error);
    if (error) throw error;
    return offlineAnswer(body);
  };
  let keyAdapter;
  let calls = 0;
  async function* stream(request) {
    checkRequest(request, () => {
    });
    throwIfAborted(request.signal);
    const respond2 = answeringKey();
    if (respond2) {
      yield* streamOwnAI(keyAdapter ??= answerAdapter(respond2), request, { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, kind: () => void 0, onFirst: () => setSource("own"), onDone: () => setLimit(null) });
      return;
    }
    let failure;
    try {
      const error = isToolRequest(request) ? featureRefusal("tools") : refusal();
      if (error) throw error;
      const last = typeof request.input === "string" ? void 0 : request.input.at(-1);
      const tool = request.tools?.length ? typeof request.toolChoice === "object" ? request.toolChoice.name : request.tools[0].name : void 0;
      if (tool && request.toolChoice !== "none" && last?.type !== "function_call_output") {
        const call = { callId: `call_mock_${++calls}`, name: tool, arguments: "{}" };
        setSource("kapai");
        yield { type: "tool_call", call };
        throwIfAborted(request.signal);
        const item = { type: "function_call", call_id: call.callId, name: tool, arguments: "{}", id: `fc_mock_${calls}`, status: "completed" };
        yield { type: "done", text: "", source: "kapai", toolCalls: [call], output: [item] };
        return;
      }
      const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
      const quote = last?.type === "function_call_output" ? ` The tool answered: "${last.output.slice(0, 200)}".` : "";
      const text = typeof options.answer === "function" ? options.answer(input) : options.answer ?? `This is a mock answer.${quote}`;
      throwIfAborted(request.signal);
      setSource("kapai");
      yield { type: "text", delta: text };
      throwIfAborted(request.signal);
      yield { type: "done", text, source: "kapai", toolCalls: [], output: [outputMessage("msg_mock", text)] };
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      syncLimit(failure);
    }
  }
  const page = (mode) => async () => {
    if (!entitlement) throw refusal() ?? new KapaiUnavailableError("unavailable", "Kapai is not available.", 0);
    emit("paywall", { type: "opened", mode });
    if (mode === "upgrade" && entitlement.prices.length > 0 && entitlement.tier === "free") {
      entitlement = { ...entitlement, ...mockEntitlement("pro", options) };
      current = "pro";
      emit("entitlement", entitlement);
      setLimit(null);
    }
    emit("paywall", { type: "closed", mode });
    return entitlement;
  };
  const respond = async (request) => {
    for await (const event of stream(request)) {
      if (event.type !== "done") continue;
      const { type: _type, ...result } = event;
      return result;
    }
    throw new KapaiError("no_answer", "The answer ended too early.");
  };
  return {
    mock: state,
    limit: () => limit,
    ai: {
      stream: (request) => stream(request),
      respond,
      runTools: (request, toolOptions) => runTools(respond, request, toolOptions),
      transcribe: async (audio, transcribeOptions = {}) => {
        const file = (await audioForm(audio, transcribeOptions)).get("file");
        const own = ownKey?.state().state;
        if (own === "active" || own === "invalid") throw includedAIOnly();
        throwIfAborted(transcribeOptions.signal);
        const error = featureRefusal("transcriptions");
        syncLimit(error);
        if (error) throw error;
        const result = { text: "(Mock) A short test recording.", seconds: Math.round(file.size / 320) / 100, language: transcribeOptions.language ?? "en" };
        return transcribeOptions.timestamps ? { ...result, segments: [{ start: 0, end: result.seconds, text: result.text }] } : result;
      },
      decide: (request) => systemOne("questions", request),
      extract: (request) => systemOne("fields", request)
    },
    ownAI: {
      configure: async (value) => {
        config = value;
        ownAIChanged();
      },
      get: () => config,
      prefer: async (value) => {
        preferred = value;
        ownAIChanged();
      },
      isPreferred: () => preferred,
      test: async () => ({ ok: true, text: "OK" }),
      kinds: () => ["openai-compatible", "anthropic"],
      changed: ownAIChanged,
      managed: () => ownKey,
      canUse: () => entitlement?.app.ownAIPolicy !== "off" && (Boolean(ownKey) || config !== null)
    },
    entitlement: async () => {
      if (state === "loading") return new Promise(() => void 0);
      if (!entitlement) throw refusal();
      return entitlement;
    },
    plans: async () => (entitlement?.prices ?? []).map((p) => ({ ...p, current: p.tier === entitlement?.tier && p.interval === entitlement?.interval })),
    upgrade: page("upgrade"),
    restore: page("restore"),
    manage: page("manage"),
    developer: page("developer"),
    on: (event, listener) => {
      const set = listeners[event];
      set.add(listener);
      if (event === "paywall") {
        const call = listener;
        if (state === "page-open") call({ type: "opened", mode: "upgrade" });
        if (state === "payment-pending") call({ type: "opened", mode: "upgrade" }), call({ type: "updating", mode: "upgrade" });
        if (state === "restore-pending") call({ type: "opened", mode: "restore" }), call({ type: "updating", mode: "restore" });
      }
      return () => void set.delete(listener);
    },
    reset: async () => void 0,
    // The card's offline and unavailable lines, as the browser and the breaker give them to a real client.
    brandColor: () => options.primaryColor,
    connection: () => current === "offline" ? "offline" : current === "service-down" ? "unavailable" : "online"
  };
}

// packages/sdk/src/index.ts
setPageOpener(openPaywall);
setDevPill((client) => {
  if (typeof document === "undefined") return;
  let marked = true;
  const stop = client.on("entitlement", (entitlement) => marked = entitlement.testDevice != null);
  void Promise.resolve().then(() => (init_dev_pill(), dev_pill_exports)).then((pill) => {
    if (marked) pill.showDevPill(client);
  }).catch(() => void 0).finally(stop);
});
export {
  Kapai,
  KapaiError,
  KapaiOwnAI,
  KapaiUnavailableError,
  MOCK_STATES,
  OwnAIError,
  QuotaExceededError,
  RateLimitedError,
  SYSTEMONE_TIMEOUT_MS,
  TRANSCRIBE_TIMEOUT_MS,
  connectKapai,
  indexedDbKeyStore,
  indexedDbStorage,
  memoryKeyStore,
  memoryStorage,
  mockEntitlement,
  mockKapai,
  ownAIKinds,
  registerOwnAIAdapter,
  runTools,
  serveKapai,
  webStorage
};
