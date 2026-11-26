import {
  audioForm,
  filePart,
  imagePart,
  runTools
} from "./chunk-6L2KWEND.js";
import {
  KapaiError,
  KapaiUnavailableError,
  OwnAIError,
  QuotaExceededError,
  RateLimitedError,
  abortReason,
  externalPaywall,
  isPurchase,
  lookOf,
  productOf,
  raceAbort,
  setDevPill,
  setPageOpener,
  throwIfAborted
} from "./chunk-E7V4HG2S.js";

// src/paywall.ts
var TITLES = { upgrade: "Plans", restore: "Use your purchases on this device", manage: "Account", developer: "Developer" };
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
  const button = (className, label, text) => {
    const el = element("button", className);
    el.type = "button";
    el.setAttribute("aria-label", label);
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
  const opener = doc.activeElement;
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
      opener?.focus?.();
    }
  };
}
var HOLD_MS = 8e3;
async function modalPaywall(host, mode, options, page, closed) {
  throwIfAborted(options.signal);
  const before = host.cachedEntitlement();
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
          if (data.step === "done" && (mode === "upgrade" || mode === "restore")) {
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
              if (isPurchase(mode, before, entitlement)) {
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
        ...productOf(mode, options)
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
  const { url } = await host.createSession(mode, { returnUrl: options.returnUrl ?? win.location.href, ...lookOf(host), ...productOf(mode, options) }, options.signal);
  win.location.assign(url);
  return new Promise(() => void 0);
}

// src/bridge.ts
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
  const { returnUrl, product } = asObject(value);
  return Object.fromEntries(Object.entries({ returnUrl, product }).filter(([, v]) => v !== void 0));
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
  const stream = (id, request, kapaiOnly) => {
    const controller = new AbortController();
    streams.set(id, controller);
    void (async () => {
      let error;
      try {
        const signaled = { ...request, signal: controller.signal };
        for await (const event of kapaiOnly ? kapai.streamRound(signaled, true) : kapai.ai.stream(signaled)) main.send({ type: "stream", id, event });
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
    products: () => kapai.products(),
    upgrade: (options) => kapai.upgrade(paywallOptions(options)),
    restore: (options) => kapai.restore(paywallOptions(options)),
    manage: (options) => kapai.manage(paywallOptions(options)),
    developer: (options) => kapai.developer(paywallOptions(options)),
    stream: (id, request, kapaiOnly) => void stream(String(id), aiRequest(request), kapaiOnly === true),
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
  const listeners = { entitlement: /* @__PURE__ */ new Set(), connection: /* @__PURE__ */ new Set(), source: /* @__PURE__ */ new Set(), paywall: /* @__PURE__ */ new Set(), ownAI: /* @__PURE__ */ new Set(), limit: /* @__PURE__ */ new Set() };
  const streams = /* @__PURE__ */ new Map();
  let limit = null;
  let policy;
  let capabilities;
  page.subscribe((message) => {
    if (message.type === "stream" || message.type === "stream-end") streams.get(message.id)?.(message);
    else if (message.type === "entitlement") {
      policy = message.entitlement.app.ownAIPolicy;
      capabilities = message.entitlement.app.capabilities;
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
  async function* stream(request, kapaiOnly = false) {
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
      await call("stream", id, rest, ...kapaiOnly ? [true] : []);
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
  const respond = async (request, kapaiOnly = false) => {
    for await (const event of stream(request, kapaiOnly)) {
      if (event.type !== "done") continue;
      const { type: _type, ...result } = event;
      return result;
    }
    throw new KapaiError("bridge_error", "The answer ended with no result.");
  };
  return {
    limit: () => limit,
    ai: {
      stream: (request) => stream(request),
      respond: (request) => respond(request),
      // The handlers run in the page: a function cannot cross the bridge. Each round crosses it as one respond.
      runTools: (request, options) => runTools(respond, request, options),
      // The two helpers run in the page too: they read a local file, so no call crosses the bridge.
      imagePart,
      filePart,
      capabilities: () => capabilities,
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
      // shortcut: the page uses the last policy and preference, because the breaker stays in the other process.
      canUse: () => policy !== void 0 && policy !== "off" && ownAI.config !== null && ownAI.preferred
    },
    entitlement: async (options = {}) => {
      const entitlement = await call("entitlement", { refresh: options.refresh === true });
      policy = entitlement.app.ownAIPolicy;
      capabilities = entitlement.app.capabilities;
      return entitlement;
    },
    products: () => call("products"),
    upgrade,
    restore: (options = {}) => call("restore", paywallOptions(options)),
    manage: (options = {}) => call("manage", paywallOptions(options)),
    developer: (options = {}) => call("developer", paywallOptions(options)),
    on: (event, listener) => {
      const set = listeners[event];
      set.add(listener);
      return () => void set.delete(listener);
    },
    reset: async (options = {}) => {
      update(await call("reset", options));
      capabilities = void 0;
    },
    // shortcut: the page does not see the breaker of the other process; the browser's online state still shows.
    connection: () => "online",
    // shortcut: the page's elements take the app's color from their CSS (--kapai-brand) or from the plan.
    brandColor: () => void 0
  };
}

// src/index.ts
setPageOpener(openPaywall);
setDevPill((client) => {
  if (typeof document === "undefined") return;
  let marked = true;
  const stop = client.on("entitlement", (entitlement) => marked = entitlement.testDevice != null);
  void import("./dev-pill-334U73NW.js").then((pill) => {
    if (marked) pill.showDevPill(client);
  }).catch(() => void 0).finally(stop);
});

export {
  serveKapai,
  connectKapai
};
