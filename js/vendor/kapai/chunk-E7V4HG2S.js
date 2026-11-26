// ../contracts/src/protocol.ts
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
var STREAM_REFUSALS = {
  invalid_request: 400,
  unsupported_option: 400,
  modality_not_supported: 400,
  quota_exceeded: 402,
  capability_off: 403,
  input_too_large: 413,
  rate_limited: 429,
  concurrency_limited: 429
};
function streamErrorStatus(code) {
  if (code === "upstream_error") return 502;
  if (code === "upstream_unavailable") return 503;
  return (code !== null && Object.hasOwn(STREAM_REFUSALS, code) ? STREAM_REFUSALS[code] : void 0) ?? 500;
}

// src/errors.ts
var KapaiError = class extends Error {
  constructor(code, message, status = 0, details = {}, options) {
    super(message, options);
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

// src/internal/abort.ts
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

// src/pages.ts
var POLL_INTERVAL_MS = 3e3;
var MAX_WAIT_MS = 15 * 6e4;
var productOf = (mode, options) => mode === "upgrade" && options.product ? { product: options.product } : {};
var hasMembership = (e) => Boolean(e.membership && e.membership.status !== "canceled");
function purchaseOf(before, now) {
  if (now.membership?.status === "active" && before?.membership?.status !== "active") return "membership";
  if (now.customer && !before?.customer) return "credits";
  return before && now.usage.credits.allowance > before.usage.credits.allowance ? "credits" : null;
}
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
var isPurchase = (mode, before, entitlement) => mode !== "developer" && entitlement.testDevice == null && purchaseOf(before, entitlement) !== null;
async function appWindowPaywall(host, showPage, mode, options) {
  throwIfAborted(options.signal);
  const before = host.cachedEntitlement();
  host.emit({ type: "opened", mode });
  try {
    const request = {
      display: "app",
      ...options.returnUrl ? { returnUrl: options.returnUrl } : {},
      ...host.appearance ? { appearance: host.appearance } : {},
      ...productOf(mode, options)
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
  if (isPurchase(mode, before, entitlement)) host.emit({ type: "purchased", mode });
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
    { ...options.returnUrl ? { returnUrl: options.returnUrl } : {}, ...lookOf(host), ...productOf(mode, options) },
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
  const { usage: ua, testDevice: _ta, ...restA } = a;
  const { usage: ub, testDevice: _tb, ...restB } = b;
  return ua.credits.allowance === ub.credits.allowance && deepEqual(restA, restB);
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

// src/own-ai/app-managed.ts
var KapaiOwnAI = {
  /** An own AI that the app manages. Call `kapai.ownAI.changed()` after the app changes it, so the elements follow. */
  appManaged(options) {
    return {
      state() {
        const label = options.label();
        if (options.isActive?.()) {
          const problem = options.problem?.() ?? null;
          return problem ? { state: "invalid", label, problem } : { state: "active", label };
        }
        if (label !== null && options.isFallback?.()) return { state: "fallback", label };
        return label === null ? { state: "notSetUp" } : { state: "available", label };
      },
      ...options.setActive ? { setActive: options.setActive } : {},
      ...options.openSettings ? { openSettings: options.openSettings } : {},
      ...options.respond ? { respond: options.respond } : {},
      ...options.media ? { media: options.media } : {},
      ...options.isActive ? { isActive: options.isActive } : {}
    };
  },
  /** A fixed state. For mocks and pictures. */
  fixed(state) {
    return { state: () => state };
  }
};
var isOwnAIActive = (state) => state.state === "active" || state.state === "invalid" || state.state === "fallback";

export {
  MAX_TOOLS,
  canonicalJwk,
  powInput,
  tokenSigningInput,
  leadingZeroBits,
  classifyResponse,
  streamErrorStatus,
  KapaiError,
  QuotaExceededError,
  RateLimitedError,
  KapaiUnavailableError,
  OwnAIError,
  SETUP_HINTS,
  errorFromResponse,
  throwIfAborted,
  abortReason,
  raceAbort,
  productOf,
  hasMembership,
  purchaseOf,
  lookOf,
  setPageOpener,
  devPill,
  setDevPill,
  openPage,
  isPurchase,
  externalPaywall,
  KapaiOwnAI,
  isOwnAIActive
};
