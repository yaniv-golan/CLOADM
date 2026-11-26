import {
  KapaiError,
  KapaiUnavailableError,
  QuotaExceededError,
  RateLimitedError,
  SETUP_HINTS,
  hasMembership,
  isOwnAIActive,
  purchaseOf
} from "./chunk-E7V4HG2S.js";

// src/ui/copy.ts
var PAGE_NOUN = { upgrade: "plans page", manage: "account page", restore: "restore page", developer: "developer page" };
var PAGE_NAME = { upgrade: "Plans", manage: "Account", restore: "Restore purchase", developer: "Developer" };
var PAGE_ACTION = { upgrade: ["see-plans"], manage: ["manage", "update-payment"], restore: ["restore"], developer: [] };
var action = (id, label, primary = false, disabled = false) => ({ id, label, primary, disabled });
function longDate(iso, locale, timeZone) {
  return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", year: "numeric", timeZone }).format(new Date(iso));
}
var nextDate = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
function resetPhrase(iso, now, locale, timeZone) {
  const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
  const target = day.format(new Date(iso));
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
  const today = day.format(now);
  if (target === today) return `at ${time} today`;
  if (target === nextDate(today)) return `at ${time} tomorrow`;
  return `on ${longDate(iso, locale, timeZone)}`;
}
var when = (iso, now, locale, timeZone) => iso ? resetPhrase(iso, now, locale, timeZone) : "soon";
function dailyState(e, now) {
  const { requestsToday: today, requestsPerDay: limit } = e.usage;
  if (today === null || limit === null || limit === 0) return null;
  if (past(e.usage.requestsResetAt, now)) return null;
  if (today >= limit) return "reached";
  return today >= limit * 0.8 ? "near" : null;
}
var spentShare = (u) => u.allowance > 0 ? Math.min(1, u.used / u.allowance) : 0;
function usageView(e, now, locale, timeZone) {
  const n = new Intl.NumberFormat(locale);
  const { left, used, allowance, resetsAt } = e.usage.credits;
  const daily = dailyState(e, now);
  const lifts = when(e.usage.requestsResetAt, now, locale, timeZone);
  const limit = e.usage.requestsPerDay;
  return {
    text: `${n.format(left)} ${left === 1 ? "credit" : "credits"} left`,
    used,
    allowance,
    fraction: allowance > 0 ? Math.min(1, Math.max(0, left / allowance)) : 0,
    reset: resetsAt ? `Credits refill ${resetPhrase(resetsAt, now, locale, timeZone)}.` : null,
    daily: daily === "reached" ? `You reached today's limit of ${limit} AI ${limit === 1 ? "use" : "uses"}. It lifts ${lifts}.` : daily === "near" ? `Daily limit: ${e.usage.requestsToday} of ${limit} AI ${limit === 1 ? "use" : "uses"} today. It lifts ${lifts}.` : null
  };
}
function usageWarning(u) {
  const spent = spentShare(u);
  if (spent < 0.8) return null;
  return spent >= 1 ? { text: "You've used all your credits.", suffix: "Out of credits" } : { text: "You're almost out of credits.", suffix: "Low on credits" };
}
var past = (iso, now) => Boolean(iso && Date.parse(iso) <= now);
function planState(e, now) {
  const m = e.membership;
  if (m?.status === "past_due") return past(m.graceEndsAt, now) ? "on-hold" : "past-due";
  if (m?.status === "active" && !(m.cancelAtPeriodEnd && past(m.endsAt, now))) return m.cancelAtPeriodEnd && m.endsAt ? "ending" : "member";
  return e.customer ? "customer" : "new";
}
var isMember = (state) => state === "member" || state === "ending" || state === "past-due";
function sourceName(config) {
  if (!config) return "your own key";
  const base2 = config.baseUrl;
  if (typeof base2 === "string") {
    try {
      return new URL(base2).host;
    } catch {
    }
  }
  return { anthropic: "Anthropic", "claude-code": "Claude Code", codex: "Codex", "openai-compatible": "your own service" }[config.kind] ?? config.kind;
}
var offersOwnKey = (source) => Boolean(source?.supported && source.policy !== "off");
var ownKeyInUse = (source) => source?.managed ? isOwnAIActive(source.managed) : Boolean(source?.supported && source.policy === "anytime" && source.preferred && source.config);
var sourceLabel = (source) => source?.managed ? "label" in source.managed && source.managed.label || "your own key" : sourceName(source?.config ?? null);
function planBlock(e, now, locale, timeZone) {
  const date = (iso) => longDate(iso, locale, timeZone);
  const m = e.membership;
  const state = planState(e, now);
  const forSale2 = e.products.length > 0;
  const buy = (primary) => forSale2 ? [action("see-plans", "Buy credits\u2026", primary)] : [];
  const left = `${usageView(e, now, locale, timeZone).text}.`;
  const lines = [];
  const notices = [];
  let actions;
  let title = "Credits";
  let pill = "Credits";
  if (state === "member" || state === "ending") {
    title = pill = "Membership";
    if (state === "ending") {
      lines.push(`Your membership ends on ${date(m.endsAt)}.`);
      pill = "Membership \xB7 Ending";
    } else {
      lines.push(e.testDevice ? "Test device: the membership is simulated." : "Your membership is active.", `${new Intl.NumberFormat(locale).format(m.creditsPerMonth)} credits each month.`);
    }
    actions = [action("manage", "Manage membership\u2026", true), ...buy(false)];
  } else if (state === "past-due") {
    title = "Membership";
    lines.push("Payment needs attention.", m.graceEndsAt ? `Update your payment by ${date(m.graceEndsAt)} to keep your membership.` : "Update your payment to keep your membership.");
    actions = [action("update-payment", "Update payment\u2026", true), action("manage", "Manage membership\u2026")];
    pill = "Membership \xB7 Payment due";
  } else if (state === "on-hold") {
    lines.push(left);
    notices.push({ kind: "alert", text: "Payment needs attention." }, { kind: "alert", text: `Your membership is on hold since ${date(m.graceEndsAt)}.` });
    actions = [action("update-payment", "Update payment\u2026", true), action("manage", "Manage membership\u2026")];
    pill = "Credits \xB7 Payment due";
  } else if (state === "customer") {
    lines.push(left);
    if (m?.endsAt && past(m.endsAt, now)) notices.push({ kind: "info", text: `Your membership ended on ${date(m.endsAt)}.` });
    actions = [...buy(true), action("manage", "Manage\u2026")];
  } else {
    lines.push(`Included with ${e.app.name}.`);
    actions = [...buy(true), ...e.restoreAvailable === false ? [] : [action("restore", "Restore purchase\u2026")]];
  }
  if (!forSale2 && (state === "new" || state === "customer")) notices.push({ kind: "info", text: "This app has nothing for sale now." });
  return { state, title, lines, notices, actions, pill, lineKind: state === "past-due" ? "alert" : "plain" };
}
function blockerOf(e, refusal, usage, now, locale, timeZone) {
  if (spentShare(usage) >= 1) return null;
  const live = refusal && (!refusal.resetsAt || Date.parse(refusal.resetsAt) > now) ? refusal : null;
  const fresh = !e.customer;
  if (fresh && live?.reason === "ip_pool") return { line: `Today's AI is used up on this network. It comes back ${when(live.resetsAt, now, locale, timeZone)}.`, suffix: "Network limit reached" };
  if (fresh && live?.reason === "app_free_budget") return { line: `AI for new users is paused. It comes back ${when(live.resetsAt, now, locale, timeZone)}.`, suffix: "Paused" };
  if (dailyState(e, now) === "reached") return { line: usage.daily, suffix: "Daily limit reached" };
  return null;
}
function cardView(input) {
  const now = input.now ?? Date.now();
  const { locale, timeZone } = input;
  const e = input.entitlement;
  if (!e) {
    if (input.fault) return faultView(input.fault, input.appName ?? "this app");
    if (input.failed && input.failedBecause === "unavailable" && !input.offline) {
      return {
        state: "unavailable-setup",
        label: "Included AI",
        title: "Included AI is unavailable",
        lines: [UNAVAILABLE_NO_PLAN],
        lineKind: "plain",
        included: null,
        usage: null,
        notices: [],
        actions: [action("try-again", "Try again", true)],
        source: null,
        busy: false,
        pill: { text: "AI unavailable", short: "AI unavailable", withUsage: "AI unavailable", icon: "warning", label: "Included AI is unavailable. Show plan details." }
      };
    }
    if (input.failed || input.offline) {
      const offline = Boolean(input.offline);
      return {
        state: offline ? "offline-setup" : "failed",
        label: "Included AI",
        title: offline ? "Connect to set up included AI." : "Couldn't set up included AI.",
        lines: [offline ? "Your plan will appear here when you're online." : "Try again to get started."],
        lineKind: "plain",
        included: null,
        usage: null,
        notices: [],
        actions: offline ? [action("try-again", "Try again", true)] : [action("try-again", "Try again", true), action("restore", "Restore purchase\u2026")],
        source: null,
        busy: false,
        pill: { text: "AI unavailable", short: "AI unavailable", withUsage: "AI unavailable", icon: "warning", label: "Included AI is unavailable. Show plan details." }
      };
    }
    return {
      state: "loading",
      label: "Included AI",
      title: "Setting up included AI\u2026",
      lines: ["This usually takes a moment."],
      lineKind: "plain",
      included: null,
      usage: null,
      notices: [],
      actions: [],
      source: null,
      busy: true,
      pill: { text: "Setting up\u2026", short: "Setting up\u2026", withUsage: "Setting up\u2026", icon: "spinner", label: "Setting up included AI. Show plan details." }
    };
  }
  const source = input.source;
  const sourceRow = sourceRowOf(source);
  const plan = planBlock(e, now, locale, timeZone);
  const fullUsage = usageView(e, now, locale, timeZone);
  const warning = usageWarning(fullUsage);
  const blocker = blockerOf(e, input.refusal, fullUsage, now, locale, timeZone);
  const usage = blocker ? null : fullUsage;
  if (blocker && plan.state !== "past-due") {
    plan.lines = [blocker.line];
    plan.lineKind = "alert";
  }
  const notices = [...plan.notices];
  if (warning) notices.unshift({ kind: "warning", text: warning.text });
  let actions = plan.actions;
  let state = blocker ? `${plan.state} limit` : plan.state;
  let pillText = plan.pill;
  const suffix = warning?.suffix ?? blocker?.suffix ?? null;
  if (suffix && !pillText.includes(" \xB7 ")) pillText += ` \xB7 ${suffix}`;
  let pillShort = plan.title;
  let pillIcon = suffix || state === "past-due" || state === "on-hold" ? "warning" : "chevron";
  let label = "Included AI";
  let title = plan.title;
  let lines = plan.lines;
  let lineKind = plan.lineKind;
  let included = null;
  if (ownKeyInUse(source)) {
    state = `own-key ${state}`;
    label = "AI source";
    title = "My own key";
    lines = [`Using ${sourceLabel(source)}.`, "Included AI is not being used."];
    lineKind = "plain";
    if (source?.managed?.state === "invalid") notices.push({ kind: "alert", text: source.managed.problem ?? "Your own key needs attention." });
    included = { title: `Included AI: ${plan.title}`, lines: plan.lines };
    if (isMember(plan.state)) notices.push({ kind: "info", text: "Your membership stays active when you use your own key." });
    actions = [action("use-included", "Use included AI", true), ...actions.map((a) => ({ ...a, primary: false }))];
    pillText = "My own key";
    pillShort = "My own key";
    pillIcon = "chevron";
  }
  if (input.offline) {
    notices.push({ kind: "offline", text: "You're offline. Showing your last known plan and usage." });
    actions = [action("try-again", "Try again", true), ...actions.map((a) => ({ ...a, primary: false, disabled: a.id !== "use-included" }))];
    if (!ownKeyInUse(source)) {
      pillText = `${plan.title} \xB7 Offline`;
      pillIcon = "offline";
    }
    state += " offline";
  } else if (input.unavailable) {
    notices.push({ kind: "warning", text: "Included AI is unavailable. Showing your last known plan and usage." });
    actions = [action("try-again", "Try again", true), ...actions.map((a) => ({ ...a, primary: false }))];
    if (!ownKeyInUse(source)) {
      pillText = `${plan.title} \xB7 Unavailable`;
      pillIcon = "warning";
    }
    state += " unavailable";
  }
  if (input.pageError) notices.push({ kind: "alert", text: pageErrorText(input.pageError) });
  const open = input.page;
  if (open) {
    notices.push({
      kind: "info",
      text: input.pageWhere === "tab" ? pageOpenText(open) : `The ${PAGE_NOUN[open]} is open in this window.`
    });
    const ids = PAGE_ACTION[open];
    const label2 = `Show ${PAGE_NAME[open].toLowerCase()}`;
    let replaced = false;
    actions = actions.map((a) => {
      if (replaced || !ids.includes(a.id)) return a;
      replaced = true;
      return { ...a, label: label2 };
    });
    pillIcon = "window";
    state += " page-open";
  }
  if (input.updating) {
    notices.push({ kind: "busy", text: input.updating === "restore" ? "Purchase found. Updating your plan\u2026" : "Payment received. Updating your plan\u2026" });
    const first = actions.findIndex((a) => a.primary);
    actions = actions.map((a, i) => i === first ? action(a.id, "Updating plan\u2026", true, true) : a);
    pillText = "Updating plan\u2026";
    pillShort = "Updating plan\u2026";
    pillIcon = "spinner";
    state += " updating";
  }
  const summary = usage ? `${usage.text}.` : blocker.line;
  const a11y = ownKeyInUse(source) ? `AI source: my own key. Included AI: ${plan.title}. ${summary} Show plan details.` : `Included AI. ${plan.title}. ${summary} Show plan details.`;
  return {
    state,
    label,
    title,
    lines,
    lineKind,
    included,
    usage,
    notices,
    actions,
    source: sourceRow,
    busy: false,
    // The summary takes the place of "Low on credits" (the symbol stays). Other suffixes say more, so they stay.
    pill: {
      text: pillText,
      short: pillShort,
      withUsage: usage && (pillText === plan.title || pillText === `${plan.title} \xB7 Low on credits`) ? `${plan.title} \xB7 ${usage.text}` : pillText,
      icon: pillIcon,
      label: a11y
    }
  };
}
var PAGE_OBJECT = { upgrade: "the plans", manage: "your account", restore: "the restore page", developer: "the developer page" };
var UNAVAILABLE_NO_PLAN = "The service isn't responding. Try again later.";
var pageOpenText = (mode) => `The ${PAGE_NOUN[mode]} is open in another tab. Your plan updates here when you're done.`;
var pageErrorText = (mode) => `Couldn't load ${PAGE_OBJECT[mode]}. Your current plan has not changed.`;
function faultView(code, app) {
  const unavailable = `Included AI isn't available in ${app} yet.`;
  const [title, ...lines] = code === "install_revoked" ? ["Included AI is turned off on this device.", `Contact the developer of ${app} for help.`] : code === "app_suspended" ? [`Included AI is paused for ${app}.`, "Try again later."] : [unavailable];
  return {
    state: `fault ${code}`,
    label: "Included AI",
    title,
    lines,
    lineKind: "plain",
    included: null,
    usage: null,
    notices: [],
    actions: [],
    source: null,
    busy: false,
    pill: { text: "AI unavailable", short: "AI unavailable", withUsage: "AI unavailable", icon: "warning", label: `${title} Show plan details.` }
  };
}
function sourceRowOf(source) {
  if (!offersOwnKey(source)) return null;
  let text = "AI source: Included";
  if (ownKeyInUse(source)) text = "AI source: My own key";
  else if (source.policy === "outage_only" && (source.config || source.managed?.state === "available")) text = "AI source: Included, my own key as backup";
  return { text, action: action("change-source", "Change\u2026") };
}
function sourceChoices(policy, appName) {
  return {
    title: "Choose your AI source",
    intro: "Use included AI or connect your own service. You can change this anytime.",
    included: { label: "Included AI", description: `Uses your ${appName} credits.` },
    own: policy === "off" ? null : {
      label: "My own key",
      // Under `outage_only`, the app uses the user's service only while included AI is unavailable.
      description: policy === "anytime" ? "Uses the service you connect." : "Uses the service you connect when included AI is unavailable."
    }
  };
}
function limitView(input) {
  const { error, entitlement: e } = input;
  const source = e ? input.source : void 0;
  const now = input.now ?? Date.now();
  const { locale, timeZone } = input;
  const dismiss = action("dismiss", "Dismiss");
  const ownKey = action("use-own-key", "Use my own key\u2026");
  const finish = (view2, notice2 = null) => ({
    ...view2,
    notice: notice2,
    announcement: [view2.title, ...view2.lines, ...notice2 ? [notice2] : []].join(". ").replace(/\.\./g, ".")
  });
  if (error instanceof KapaiUnavailableError) {
    const own2 = offersOwnKey(source) ? [ownKey] : [];
    const offline = input.offline ?? (typeof navigator !== "undefined" && navigator.onLine === false);
    const saved = e ? " Your last known plan is saved." : "";
    return finish(
      offline ? { reason: "offline", title: "You're offline", lines: [`Connect to the internet to use included AI.${saved}`], usage: null, actions: [...own2, dismiss, action("try-again", "Try again", true)] } : { reason: "service_unavailable", title: "Included AI is unavailable", lines: [e ? `Try again in a moment.${saved}` : UNAVAILABLE_NO_PLAN], usage: null, actions: [...own2, dismiss, action("try-again", "Try again", true)] }
    );
  }
  if (error instanceof RateLimitedError && (error.code === "rate_limited" || error.code === "concurrency_limited")) {
    const seconds = Math.max(1, Math.ceil(error.retryAfter));
    const line = seconds === 1 ? "Wait 1 second, then try again. Your work is safe." : `Wait ${seconds} seconds, then try again. Your work is safe.`;
    return finish({ reason: "rate_limited", title: "Too many AI uses at once", lines: [line], usage: null, actions: [dismiss, action("try-again", "Try again", true)] });
  }
  if (error instanceof KapaiError && error.code in SETUP_HINTS) {
    const app = input.appName ?? e?.app.name ?? "this app";
    const title = error.code === "install_revoked" ? "Included AI is turned off on this device" : error.code === "app_suspended" ? `Included AI is paused for ${app}` : `Included AI isn't available in ${app} yet.`;
    const keyAllowed = error.code === "origin_not_allowed" || error.code === "invalid_publishable_key";
    const own2 = keyAllowed && offersOwnKey(source) ? [action("use-own-key", "Use my own key\u2026", true)] : [];
    return finish({ reason: "service_unavailable", title, lines: [], usage: null, actions: [action("dismiss", "Dismiss", own2.length === 0), ...own2] });
  }
  if (!(error instanceof QuotaExceededError)) return null;
  const forSale2 = error.upgradeAvailable && (e ? e.products.length > 0 : true);
  const own = offersOwnKey(source) && source.policy === "anytime" ? [ownKey] : [];
  const offer = { reason: "usage_limit", usage: null, actions: [...own, dismiss, ...forSale2 ? [action("see-plans", "Buy credits\u2026", true)] : []] };
  const resets = when(error.resetsAt, now, locale, timeZone);
  const noSale = forSale2 ? null : "This app has nothing for sale now.";
  const view = (title, line, usage = null) => finish({ ...offer, usage, title, lines: [line] }, noSale);
  switch (error.reason) {
    case "insufficient_credits":
      return view("Not enough credits", "This request needs more credits than you have left.", e ? usageView(e, now, locale, timeZone).text : null);
    case "daily_requests": {
      const limit = e?.usage.requestsPerDay;
      if (limit === 0) return view("No AI uses before a purchase", `${e.app.name} gives no AI uses before a purchase.`);
      const lifts = when(error.resetsAt ?? e?.usage.requestsResetAt, now, locale, timeZone);
      return view("You reached today's limit", limit != null ? `You used today's ${limit} AI ${limit === 1 ? "use" : "uses"}. More come ${lifts}.` : `More AI uses come ${lifts}.`);
    }
    case "ip_pool":
      return view("Today's AI is used up on this network", `Devices on this network used today's AI for new users. It comes back ${resets}.`);
    case "app_free_budget":
      return view("AI for new users is paused for now", `It comes back ${resets}.`);
    case "test_budget":
      return view("Your test devices used their share", `It comes back ${resets}.`);
    default:
      return view("You've reached your AI limit", `It lifts ${resets}.`);
  }
}
function readyView(e, bought) {
  const [title, line] = bought === "membership" ? ["Membership is ready", `Your membership is ready to use in ${e.app.name}.`] : ["Credits are ready", `Your credits are ready to use in ${e.app.name}.`];
  return {
    reason: "plan_ready",
    title,
    lines: [line],
    usage: null,
    notice: null,
    actions: [action("dismiss", "Dismiss"), action("retry-request", "Try again", true)],
    announcement: `${title}. ${line}`
  };
}
function brandPair(hex) {
  return { light: reach(hex, "#ffffff", [0, 0, 0]), dark: reach(hex, "#1f1f22", [255, 255, 255]) };
}
function rgb(hex) {
  const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  return [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function luminance([r, g, b]) {
  const lin = (c) => c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function reach(hex, surface, toward) {
  const start = rgb(hex);
  for (let t = 0; t <= 1; t += 0.05) {
    const mixed = start.map((c, i) => Math.round(c + (toward[i] - c) * t));
    const out = `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    const text = Math.max(contrast(out, "#ffffff"), contrast(out, "#111111"));
    if (contrast(out, surface) >= 3 && text >= 4.5) return out;
  }
  return toward[0] === 0 ? "#000000" : "#ffffff";
}

// src/ui/view.ts
function shortDate(iso, now, locale, timeZone) {
  const date = new Date(iso);
  const yearOf = new Intl.DateTimeFormat(locale, { year: "numeric", timeZone });
  const year = yearOf.format(date) === yearOf.format(now) ? void 0 : "numeric";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year, timeZone }).format(date);
}
function planView(entitlement, locale, timeZone, now = Date.now()) {
  const card = cardView({ entitlement, now, locale, timeZone });
  const usage = card.usage;
  return {
    appName: entitlement.app.name,
    plan: card.title,
    actions: card.actions.flatMap((a) => a.id in ACTION_OF ? [{ action: ACTION_OF[a.id], label: a.label, primary: a.primary }] : []),
    canRestore: card.actions.some((a) => a.id === "restore"),
    percent: usage.fraction * 100,
    usageText: usage.text,
    resetsText: usage.reset,
    statusLine: statusLine(entitlement, locale, timeZone, now)
  };
}
var ACTION_OF = { "see-plans": "upgrade", "update-payment": "update_card", manage: "manage" };
function statusLine(entitlement, locale, timeZone, now = Date.now()) {
  const card = cardView({ entitlement, now, locale, timeZone });
  const alerts = card.notices.filter((n) => n.kind === "alert").map((n) => n.text);
  const ended = card.notices.filter((n) => n.text.startsWith("Your membership ended")).map((n) => n.text);
  const parts = card.state === "new" || card.state === "customer" || card.state === "on-hold" ? [...alerts, ...ended] : card.lines;
  if (parts.length === 0) return null;
  return { text: parts.join(" "), alert: card.lineKind === "alert" || alerts.length > 0 };
}
var DEFAULT_BRAND = "#2563eb";
function brandColor(value) {
  return value && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : DEFAULT_BRAND;
}
function luminance2(hex) {
  const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function onBrandText(brand) {
  const bg = luminance2(brandColor(brand));
  const dark = luminance2("#111111");
  return 1.05 / (bg + 0.05) >= (bg + 0.05) / (dark + 0.05) ? "#ffffff" : "#111111";
}
var KIND_LABEL = {
  "openai-compatible": "OpenAI-compatible",
  anthropic: "Anthropic",
  "claude-code": "Claude Code on this computer",
  codex: "Codex on this computer"
};
var kindLabel = (kind) => KIND_LABEL[kind] ?? kind;
var kindHint = (kind) => kind === "openai-compatible" ? "Works with OpenAI, OpenRouter, Ollama, and LM Studio." : "";
var MODEL_ID = "Enter a model ID from your service";
var OPTIONAL_MODEL = { name: "model", label: "Model (optional)", placeholder: "Leave empty for the default", required: false, secret: false };
function fieldsFor(kind) {
  switch (kind) {
    case "openai-compatible":
      return [
        { name: "baseUrl", label: "Base URL", placeholder: "For example, https://api.openai.com/v1", required: true, secret: false },
        { name: "apiKey", label: "API key (optional)", placeholder: "", required: false, secret: true, hint: "Leave blank if your service does not require an API key." },
        { name: "model", label: "Model", placeholder: MODEL_ID, required: true, secret: false }
      ];
    case "anthropic":
      return [
        { name: "apiKey", label: "API key", placeholder: "Paste your API key", required: true, secret: true },
        { name: "model", label: "Model", placeholder: MODEL_ID, required: true, secret: false }
      ];
    case "claude-code":
    case "codex":
      return [OPTIONAL_MODEL];
    default:
      return [];
  }
}
function configFromForm(kind, values, previous) {
  const config = { kind };
  for (const field of fieldsFor(kind)) {
    const value = (values[field.name] ?? "").trim();
    if (value) config[field.name] = value;
    else if (field.secret && previous?.kind === kind && typeof previous[field.name] === "string") {
      config[field.name] = previous[field.name];
    }
  }
  return config;
}
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// src/ui/element.ts
function connectElements(client) {
  pageClient = client;
  for (const element of waiting) element.useClient();
}
var pageClient;
var waiting = /* @__PURE__ */ new Set();
var refusals = /* @__PURE__ */ new WeakMap();
var connected = /* @__PURE__ */ new Set();
function renderAll() {
  for (const element of connected) element.render();
}
var NEUTRAL_BRAND = "#3f3f46";
function brandStyle(entitlement, appColor) {
  const hex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  const brand = [appColor, entitlement?.app.branding.primaryColor].find((c) => typeof c === "string" && hex.test(c)) ?? NEUTRAL_BRAND;
  const { light, dark } = brandPair(brand);
  return `:host { --kapai-default-brand: light-dark(${light}, ${dark}); --kapai-default-on-brand: light-dark(${onBrandText(light)}, ${onBrandText(dark)}); }`;
}
var base;
function kapaiElement() {
  return base ??= makeBase();
}
function makeBase() {
  class KapaiElement extends HTMLElement {
    #client;
    #own = false;
    #lastBack = 0;
    #stop = [];
    /** Internal: the state that the element draws. */
    state = { entitlement: void 0, failed: false, offline: false, page: null, updating: null, pageError: null, fault: null, pageWhere: null, failedBecause: null, refusal: null };
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }
    /** The client. Without one, the element uses the client of `connectElements`. */
    get client() {
      return this.#client ?? pageClient;
    }
    set client(client) {
      this.#client = client;
      this.#own = Boolean(client);
      this.useClient();
    }
    /** Starts to follow the current client. */
    useClient() {
      this.state = { ...this.state, entitlement: void 0, failed: false };
      this.#listen();
      if (this.client) void this.load();
      this.render();
    }
    // An app can move the element, or take it out and put it back. Listen again each time, and read the plan again.
    connectedCallback() {
      if (!this.#own) waiting.add(this);
      connected.add(this);
      this.#listen();
      if (this.client) void this.load();
      this.render();
    }
    disconnectedCallback() {
      waiting.delete(this);
      connected.delete(this);
      this.#unlisten();
    }
    #unlisten() {
      for (const stop of this.#stop) stop();
      this.#stop = [];
    }
    #listen() {
      this.#unlisten();
      const client = this.client;
      if (!client || !this.isConnected) return;
      const set = (patch) => {
        this.state = { ...this.state, ...patch };
        this.render();
      };
      const back = () => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        if (Date.now() - this.#lastBack < 5e3) return;
        this.#lastBack = Date.now();
        void this.load(true);
      };
      addEventListener("focus", back);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", back);
      this.#stop.push(
        () => removeEventListener("focus", back),
        () => typeof document !== "undefined" ? document.removeEventListener("visibilitychange", back) : void 0
      );
      const online = () => {
        set({ offline: false });
        void this.load(true);
      };
      const offline = () => set({ offline: true });
      addEventListener("online", online);
      addEventListener("offline", offline);
      this.state.offline = typeof navigator !== "undefined" && navigator.onLine === false;
      this.state.refusal = client.limit ? client.limit() : refusals.get(client) ?? null;
      this.#stop.push(
        () => removeEventListener("online", online),
        () => removeEventListener("offline", offline),
        client.on("entitlement", (entitlement) => set({ entitlement, failed: false })),
        client.on("connection", () => this.render()),
        client.on("source", () => this.render()),
        // The app or the SDK changed the user's own AI: draw the new source, with no new insert.
        client.on("ownAI", () => this.render()),
        client.on("limit", (refusal) => {
          refusals.set(client, refusal);
          set({ refusal });
        }),
        client.on("paywall", (event) => {
          if (event.type === "opened") set({ page: event.mode, pageWhere: event.where ?? null });
          else if (event.type === "closed") set({ page: null, pageWhere: null, updating: null });
          else if (event.type === "updating") set({ updating: event.mode });
          else if (event.type === "updated") set({ updating: null });
        })
      );
    }
    /** Reads the plan. With `refresh`, it skips the SDK's cache. */
    async load(refresh = false) {
      const client = this.client;
      if (!client) return;
      try {
        const entitlement = await client.entitlement({ refresh });
        if (client === this.client) this.state = { ...this.state, entitlement, failed: false, fault: null, failedBecause: null };
      } catch (err) {
        const code = err instanceof KapaiError && err.code in SETUP_HINTS ? err.code : null;
        const failedBecause = err instanceof KapaiUnavailableError ? "unavailable" : null;
        if (client === this.client) this.state = { ...this.state, failed: true, fault: code, failedBecause };
      }
      this.render();
    }
    /** Offline and unavailable, from the browser and from the client (a mock can set them). */
    connection() {
      const state = this.client?.connection?.();
      return { offline: this.state.offline || state === "offline", unavailable: state === "unavailable" };
    }
    /** The app's own AI state and actions for these elements. */
    managedOwnAI() {
      const client = this.client;
      return client?.managedOwnAIForElements?.() ?? client?.ownAI.managed();
    }
    /** The user's own AI, as the views need it. */
    sourceState() {
      const client = this.client;
      const policy = this.state.entitlement?.app.ownAIPolicy;
      if (!client || policy === void 0) return void 0;
      const managed = this.managedOwnAI()?.state();
      return {
        policy,
        config: client.ownAI.get(),
        preferred: client.ownAI.isPreferred(),
        // Under `off`, the app never offers own AI: the card has no source row and the picker draws nothing.
        supported: policy !== "off" && (managed ? managed.state !== "none" : client.ownAI.kinds().length > 0),
        ...managed ? { managed } : {}
      };
    }
    /**
     * Runs a kit action. The hosted pages open in the SDK's modal. The element fires `kapai-action` first;
     * an app can call `preventDefault()` on it to run the action itself.
     */
    async runAction(action2) {
      const client = this.client;
      if (!client) return;
      this.#said = "";
      const said = this.shadowRoot.querySelector("[data-announce]");
      if (said) said.textContent = "";
      const go = this.dispatchEvent(new CustomEvent("kapai-action", { detail: { action: action2 }, bubbles: true, composed: true, cancelable: true }));
      if (!go) return;
      this.state = { ...this.state, pageError: null, fault: null, pageWhere: null };
      const before = this.state.entitlement;
      const open = (mode, page) => page().then(
        (entitlement) => {
          this.state = { ...this.state, entitlement };
          this.render();
          const bought = purchaseOf(before, entitlement);
          if (bought) this.planReady(bought);
        },
        () => {
          this.state = { ...this.state, pageError: mode };
          this.pageFailed(mode);
          this.render();
        }
      );
      switch (action2) {
        case "see-plans":
          return open("upgrade", () => client.upgrade());
        case "restore":
          return open("restore", () => client.restore());
        case "manage":
          return open("manage", () => client.manage());
        case "update-payment":
          return open("manage", () => client.updatePayment ? client.updatePayment() : client.manage());
        case "try-again":
          return this.load(true);
        case "use-included": {
          const managed = this.managedOwnAI();
          if (managed) {
            await managed.setActive?.(false);
            client.ownAI.changed();
          } else if (this.state.entitlement?.app.ownAIPolicy === "anytime") await client.ownAI.prefer(false);
          this.announce("Using included AI.");
          return renderAll();
        }
        case "change-source":
        case "use-own-key": {
          const managed = this.managedOwnAI();
          if (managed && !managed.setActive && managed.openSettings) return managed.openSettings();
          return void openSourceDialog(this, action2 === "use-own-key" ? "own" : void 0);
        }
        case "dismiss":
          return;
      }
    }
    /** Called when a hosted page did not open. The limit prompt shows itself again. */
    pageFailed(_mode) {
    }
    /** Called when a page that this element opened gave a purchase or a restore. The modal is gone: the element confirms it. */
    planReady(_bought) {
    }
    /** Says a short sentence in the element's status line, for four seconds. */
    announce(text) {
      this.#said = text;
      const status = this.shadowRoot.querySelector("[data-announce]");
      if (status) status.textContent = text;
      clearTimeout(this.#announceTimer);
      this.#announceTimer = setTimeout(() => {
        this.#said = "";
        const now = this.shadowRoot.querySelector("[data-announce]");
        if (now) now.textContent = "";
      }, 4e3);
    }
    #announceTimer;
    #said = "";
    /** Draws again, and gives the focus back to the same action, for keyboard users. */
    render() {
      const root = this.shadowRoot;
      const focused = root.activeElement?.dataset?.action;
      this.draw();
      const status = root.querySelector("[data-announce]");
      if (status && this.#said) status.textContent = this.#said;
      if (!focused) return;
      const same = root.querySelector(`[data-action="${focused}"]:not(:disabled)`);
      (same ?? root.querySelector("[data-action]:not(:disabled)"))?.focus();
    }
  }
  return KapaiElement;
}
function stableParts(root, className) {
  let style = root.querySelector(":scope > style");
  let section = root.querySelector(":scope > section");
  if (!style || !section) {
    style = document.createElement("style");
    section = document.createElement("section");
    section.className = className;
    root.replaceChildren(style, section);
  }
  return { style, section };
}
function openSourceDialog(host, select) {
  const root = host.shadowRoot;
  const client = host.client;
  if (!root || !client) return void 0;
  root.querySelector("dialog.kapai-source")?.remove();
  const dialog = document.createElement("dialog");
  dialog.className = "kapai-source";
  dialog.setAttribute("aria-label", "Choose your AI source");
  const picker = document.createElement("kapai-ai-source");
  if (select) picker.setAttribute("select", select);
  picker.setAttribute("data-nested", "");
  picker.client = client;
  dialog.append(picker);
  root.append(dialog);
  const close = () => dialog.close();
  picker.addEventListener("kapai-cancel", close);
  picker.addEventListener("kapai-source-change", (event) => {
    close();
    const text = event.detail.text;
    host.announce?.(text);
    host.render?.();
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  return dialog;
}
var DIALOG_CSS = `
dialog.kapai-source { padding: 0; border: 1px solid var(--kapai-border); border-radius: var(--kapai-radius); background: var(--kapai-surface);
  color: var(--kapai-text); width: min(480px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; box-shadow: 0 18px 48px rgb(0 0 0 / 0.28); }
dialog.kapai-source::backdrop { background: rgb(15 18 20 / 0.45); }
dialog.kapai-source[open] { animation: kapai-fade 120ms ease-out; }
@media (prefers-reduced-motion: reduce) { dialog.kapai-source[open] { animation: none; } }
`;

// src/ui/styles.ts
var TOKENS = `
/* An element inside another Kapai element (the card in the pill's popover, the picker in its dialog) has
   data-nested. It takes the tokens of its parent, so the app's values reach it. */
:host(:not([data-nested])) {
  --kapai-text: light-dark(#1d1d1f, #f5f5f7);
  --kapai-muted: light-dark(#5b5e66, #a8a8b0);
  --kapai-surface: light-dark(#ffffff, #1f1f22);
  --kapai-panel: light-dark(#f4f4f6, #2a2a2e);
  --kapai-border: light-dark(#d4d4da, #3c3c42);
  --kapai-track: light-dark(#e3e3e8, #3c3c42);
  --kapai-field: light-dark(#ffffff, #18181b);
  --kapai-danger: light-dark(#b8261a, #ff7a6b);
  --kapai-warning: light-dark(#94560a, #f5b04a);
  --kapai-success: light-dark(#1a7f37, #4cc366);
  --kapai-radius: 12px;
  --kapai-gap: 12px;
}
:host {
  display: block;
  min-width: 0;
  max-width: 100%;
}
/* !important: else a page rule that sets display on the element wins, and an empty box shows. */
:host([hidden]) { display: none !important; }
`;
var BASE = `${TOKENS}
.root {
  font-family: var(--kapai-font, inherit); font-size: 13px; line-height: 18px; font-weight: 400; font-style: normal;
  letter-spacing: normal; word-spacing: normal; text-transform: none; text-align: start; text-indent: 0; white-space: normal;
  color: var(--kapai-text); overflow-wrap: anywhere; -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }
p, h2, h3 { margin: 0; }
.label { font-size: 12px; line-height: 16px; font-weight: 600; color: var(--kapai-muted); }
.title { font-size: 17px; line-height: 22px; font-weight: 600; }
.big { font-size: 20px; line-height: 25px; font-weight: 600; }
.sub { font-size: 12px; line-height: 17px; color: var(--kapai-muted); }
.usage { font-weight: 500; font-variant-numeric: tabular-nums; }
.card { background: var(--kapai-surface); border: 1px solid var(--kapai-border); border-radius: var(--kapai-radius); padding: 16px; }
:host([plain]) .card { border: 0; border-radius: 0; background: transparent; }
.notice { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 17px; }
.notice svg { flex: none; width: 14px; height: 14px; margin-top: 1.5px; }
.notice[data-kind=warning] svg { color: var(--kapai-warning); }
.notice[data-kind=alert] svg { color: var(--kapai-danger); }
.notice[data-kind=info] svg, .notice[data-kind=busy] svg { color: var(--kapai-muted); }
.actions { display: flex; flex-wrap: wrap; gap: 4px 8px; }
button {
  font: inherit; font-weight: 500; min-height: 32px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid transparent; background: transparent; color: var(--kapai-text); line-height: 18px; text-align: center;
}
button.primary { background: var(--kapai-brand, var(--kapai-default-brand)); border-color: var(--kapai-brand, var(--kapai-default-brand)); color: var(--kapai-on-brand, var(--kapai-default-on-brand)); }
button.bordered { border-color: var(--kapai-border); background: var(--kapai-surface); }
button:not(.primary):hover:not(:disabled) { background: var(--kapai-panel); }
button.primary:hover:not(:disabled) { filter: brightness(1.06); }
button:disabled { cursor: default; color: var(--kapai-muted); background: var(--kapai-panel); border-color: transparent; }
:focus-visible { outline: 2px solid var(--kapai-brand, var(--kapai-default-brand)); outline-offset: 2px; }
input, select {
  font: inherit; color: var(--kapai-text); background: var(--kapai-field); border: 1px solid var(--kapai-border);
  border-radius: 8px; min-height: 32px; padding: 6px 8px; width: 100%; min-width: 0; text-overflow: ellipsis;
}
.spinner {
  flex: none; width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--kapai-track); border-top-color: var(--kapai-muted);
  animation: kapai-spin 0.9s linear infinite, kapai-appear 0s linear 200ms both;
}
.fade { animation: kapai-fade 120ms ease-out; }
@keyframes kapai-spin { to { transform: rotate(360deg); } }
@keyframes kapai-appear { from { visibility: hidden; } }
@keyframes kapai-fade { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .fade { transition: none; animation: none; }
  .spinner { animation: kapai-appear 0s linear 200ms both; }
}
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;
var ICON_PATHS = {
  // A triangle with an exclamation mark, for a warning or a problem.
  warning: `<path fill="currentColor" d="M8 1.5a1 1 0 0 1 .87.5l6.5 11.25A1 1 0 0 1 14.5 14.75h-13a1 1 0 0 1-.87-1.5L7.13 2A1 1 0 0 1 8 1.5Zm0 4a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5.5Zm0 6.25a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z"/>`,
  // A circle with an "i", for a neutral fact.
  info: `<path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm0 5.75a.75.75 0 0 0-.75.75v3.75a.75.75 0 0 0 1.5 0V7.5A.75.75 0 0 0 8 6.75ZM8 4a.9.9 0 1 0 0 1.8A.9.9 0 0 0 8 4Z"/>`,
  // A clock face, for an allowance that resets.
  clock: `<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5ZM8 4.5V8l2.5 1.5"/>`,
  // A circle with a check mark, for a confirmation.
  check: `<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5ZM5.25 8.25l1.9 1.9 3.6-3.9"/>`,
  // A chevron that points down, for the pill.
  chevron: `<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="m4.5 6.5 3.5 3.5 3.5-3.5"/>`,
  // A window, for the pill while a hosted page is open.
  window: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M2.5 3.5h11v9h-11zM2.5 6h11"/>`,
  // A cloud with a slash, for offline.
  offline: `<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M2 2l12 12M5 12.5H4a2.5 2.5 0 0 1-.4-4.97M6.3 4.9A4 4 0 0 1 12 7.5a2.5 2.5 0 0 1 1.5 4.5"/>`
};
function icon(name) {
  return `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

// src/ui/ticks.ts
var TICKS = 30;
function leftTicks(left, allowance) {
  if (left <= 0) return 0;
  if (allowance <= 0 || left >= allowance) return TICKS;
  return Math.min(TICKS - 1, Math.max(1, Math.round(left / allowance * TICKS)));
}
function tickBar(dark, label) {
  const text = escapeHtml(label);
  const ticks = Array.from({ length: TICKS }, (_, i) => `<i aria-hidden="true"${i < dark ? " data-on" : ""}></i>`).join("");
  return `<div class="ticks" role="meter" aria-valuemin="0" aria-valuemax="${TICKS}" aria-valuenow="${dark}" aria-label="${text}" aria-valuetext="${text}">${ticks}</div>`;
}
var TICKS_CSS = `
.ticks {
  --kapai-tick: light-dark(var(--kapai-brand, var(--kapai-default-brand)), color-mix(in srgb, var(--kapai-brand, var(--kapai-default-brand)) 70%, white));
  container-type: inline-size; display: grid; grid-template-columns: repeat(30, 1fr); gap: 2px;
}
.ticks > i {
  display: block; height: 10px; border-radius: 3px;
  /* An older browser drops a rule that it cannot read, and keeps the rule before it. */
  height: clamp(8px, round((100cqw - 58px) / 20, 1px), 16px); border-radius: calc((100cqw - 58px) / 60);
  background: color-mix(in srgb, var(--kapai-tick) 22%, transparent); transition: background-color 120ms ease-out;
}
.ticks > i[data-on] { background: var(--kapai-tick); }
@media (prefers-reduced-motion: reduce) { .ticks > i { transition: none; } }
`;

// src/ui/account.ts
var CARD_CSS = `
.card { display: grid; }
.head { display: grid; gap: 4px; }
.included { display: grid; gap: 4px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--kapai-border); }
[data-usage] { display: grid; gap: 8px; margin-top: 16px; }
.notices { display: grid; gap: 6px; margin-top: 8px; }
.notices:empty { display: none; }
.loading { display: flex; gap: 8px; align-items: center; }
[data-plan-actions] { display: grid; gap: 4px; margin-top: 16px; }
[data-plan-actions]:empty { display: none; }
[data-plan-actions] > button { width: 100%; }
[data-plan-actions] .more { display: flex; flex-wrap: wrap; justify-content: center; gap: 0 4px; }
.source { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--kapai-border); }
.source span { font-size: 12px; line-height: 17px; color: var(--kapai-muted); }
.source button { flex: none; }
[data-announce] { font-size: 12px; line-height: 17px; color: var(--kapai-success); margin-top: 8px; }
[data-announce]:empty { display: none; }
`;
function defineKapaiAccount(registry = globalThis.customElements, name = "kapai-account") {
  if (!registry || registry.get(name)) return;
  registry.define(name, createElementClass());
}
var button = (a, className = "") => `<button type="button"${className ? ` class="${className}"` : ""} data-action="${a.id}"${a.disabled ? " disabled" : ""}>${escapeHtml(a.label)}</button>`;
var notice = (n) => `<p class="notice" data-kind="${n.kind}"${n.kind === "busy" ? ` role="status"` : ""}>${n.kind === "busy" ? `<span class="spinner"></span>` : icon(n.kind === "warning" || n.kind === "alert" ? "warning" : n.kind === "offline" ? "offline" : "info")}<span>${escapeHtml(n.text)}</span></p>`;
function cardHtml(view) {
  const lines = (list) => list.map((line) => `<p class="sub" data-line>${escapeHtml(line)}</p>`).join("");
  const [first, ...rest] = view.actions;
  const main = first ? button(first, first.primary ? "primary" : "bordered") : "";
  const more = rest.length ? `<div class="more">${rest.map((a) => button(a)).join("")}</div>` : "";
  const usage = view.usage;
  return `
    <div class="head">
      <p class="label">${escapeHtml(view.label)}</p>
      ${view.busy ? `<div class="loading"><span class="spinner" role="img" aria-label="Loading"></span><h2 class="title" data-plan>${escapeHtml(view.title)}</h2></div>` : `<h2 class="title" data-plan>${escapeHtml(view.title)}</h2>`}
      ${view.lineKind === "alert" ? `<p class="notice" data-kind="alert" data-line>${icon("warning")}<span>${escapeHtml(view.lines[0] ?? "")}</span></p>${lines(view.lines.slice(1))}` : lines(view.lines)}
    </div>
    ${view.included ? `<div class="included"><p class="label">${escapeHtml(view.included.title)}</p>${lines(view.included.lines)}</div>` : ""}
    ${usage ? `<div data-usage>
        <p class="usage">${escapeHtml(usage.text)}</p>
        ${tickBar(leftTicks(usage.allowance - usage.used, usage.allowance), usage.text)}
        ${usage.reset ? `<p class="sub" data-reset>${escapeHtml(usage.reset)}</p>` : ""}
        ${usage.daily ? `<p class="sub" data-daily>${escapeHtml(usage.daily)}</p>` : ""}
      </div>` : ""}
    <div class="notices">${view.notices.map(notice).join("")}</div>
    <div data-plan-actions>${main}${more}</div>
    ${view.source ? `<div class="source"><span data-source>${escapeHtml(view.source.text)}</span>${button(view.source.action)}</div>` : ""}
    <p data-announce role="status" aria-live="polite"></p>`;
}
function createElementClass() {
  return class KapaiAccountElement extends kapaiElement() {
    #lastState = "";
    /** The one confirmation of a purchase or a restore from this card: the modal closed by itself. */
    planReady(bought) {
      this.announce(bought === "membership" ? "Membership is ready." : "Credits are ready.");
    }
    draw() {
      const { style, section } = stableParts(this.shadowRoot, "root card");
      section.setAttribute("aria-label", "AI plan");
      style.textContent = `${BASE}${TICKS_CSS}${CARD_CSS}${DIALOG_CSS}${brandStyle(this.state.entitlement, this.client?.brandColor?.())}`;
      section.hidden = !this.client;
      if (!this.client) return;
      const view = cardView({ ...this.state, ...this.connection(), source: this.sourceState(), appName: this.getAttribute("app-name") ?? void 0 });
      section.classList.toggle("fade", false);
      if (this.#lastState !== "" && this.#lastState !== view.state) {
        void section.offsetWidth;
        section.classList.add("fade");
      }
      this.#lastState = view.state;
      section.dataset.state = view.state;
      section.innerHTML = cardHtml(view);
      for (const el of section.querySelectorAll("[data-action]")) {
        el.addEventListener("click", () => void this.runAction(el.dataset.action));
      }
    }
  };
}

// src/ui/limit.ts
var PROMPT_CSS = `
:host { max-width: 440px; container-type: inline-size; }
.root { padding: 24px; }
.mark { width: 24px; height: 24px; color: var(--kapai-muted); }
[data-reason=plan_ready] .mark { color: var(--kapai-success); }
.mark svg { width: 24px; height: 24px; }
h2 { margin-top: 12px; }
.body { display: grid; gap: 4px; margin-top: 8px; }
.usage { margin-top: 8px; }
.no-sale { margin-top: 8px; }
.notice { margin-top: 8px; }
.row { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.row button { min-width: 88px; }
/* Narrow: the main action on its own full-width row first, then the other actions in one row of equal widths. */
@container (max-width: 400px) {
  .row { display: grid; grid-template-columns: repeat(var(--secondary, 1), minmax(0, 1fr)); gap: 8px; }
  .row button { min-width: 0; min-height: 44px; }
  .row .primary { grid-column: 1 / -1; order: -1; }
}
`;
function defineKapaiLimitPrompt(registry = globalThis.customElements, name = "kapai-limit-prompt") {
  if (!registry || registry.get(name)) return;
  registry.define(name, createElementClass2());
}
function createElementClass2() {
  return class KapaiLimitPromptElement extends kapaiElement() {
    #error;
    /** The plan at `show`. A purchase or another plan since then makes the prompt's words out of date. */
    #shownFor;
    /** What a purchase or a restore gave while the prompt showed: it is a confirmation now. */
    #ready = null;
    /** The client's limit at the last draw. A new value shows the prompt, and null removes the limit. */
    #limit = void 0;
    /** The plan at the client's refusal. A purchase after it gets the confirmation. */
    #limitAt;
    connectedCallback() {
      if (!this.#error) this.hidden = true;
      super.connectedCallback();
    }
    /** The content on screen, or null when the prompt is hidden. */
    get view() {
      if (this.hidden || !this.#error && !this.#ready) return null;
      if (this.#ready && this.state.entitlement) return readyView(this.state.entitlement, this.#ready);
      return limitView({ error: this.#error, entitlement: this.state.entitlement, source: this.sourceState(), offline: this.connection().offline, appName: this.getAttribute("app-name") ?? void 0 });
    }
    /** Shows the prompt for a refused request. Returns false for another error. */
    show(error) {
      const view = limitView({ error, entitlement: this.state.entitlement, source: this.sourceState(), offline: this.connection().offline, appName: this.getAttribute("app-name") ?? void 0 });
      if (!view) {
        this.hide();
        return false;
      }
      this.#error = error;
      this.#ready = null;
      this.state = { ...this.state, pageError: null };
      this.#shownFor = void 0;
      this.hidden = false;
      void this.load(true).then(() => this.#shownFor = this.state.entitlement);
      this.render();
      const live = this.shadowRoot.querySelector("[data-announce]");
      if (live) live.textContent = view.announcement;
      return true;
    }
    hide() {
      this.#error = void 0;
      this.#ready = null;
      this.hidden = true;
      this.render();
    }
    /** Follows the client's limit: a new refusal shows, and the end of the limit hides it or confirms a new plan. */
    #follow() {
      const refusal = this.state.refusal;
      if (refusal === this.#limit) return false;
      const first = this.#limit === void 0;
      this.#limit = refusal;
      const e = this.state.entitlement;
      if (refusal && !this.hasAttribute("manual")) {
        this.#error = new QuotaExceededError("quota_exceeded", refusal.message ?? "", 402, { ...refusal, upgradeAvailable: refusal.upgradeAvailable ?? true });
        this.#ready = null;
        this.#shownFor = void 0;
        this.#limitAt = e;
        this.hidden = false;
        return !first;
      }
      if (!refusal && this.#error instanceof QuotaExceededError) {
        const before = this.#limitAt ?? this.#shownFor;
        this.#ready = e && before ? purchaseOf(before, e) : null;
        this.#error = void 0;
        this.hidden = !this.#ready;
      }
      return false;
    }
    draw() {
      const root = this.shadowRoot;
      const announce = this.#follow();
      const e = this.state.entitlement;
      if (this.#error && this.#shownFor && e && e !== this.#shownFor) {
        this.#ready = purchaseOf(this.#shownFor, e);
        if (this.#ready || planKey(e) !== planKey(this.#shownFor)) {
          this.hidden = !this.#ready;
          this.#error = void 0;
        }
      }
      const view = this.#ready && e ? readyView(e, this.#ready) : this.#error ? limitView({ error: this.#error, entitlement: e, source: this.sourceState(), offline: this.connection().offline, appName: this.getAttribute("app-name") ?? void 0 }) : null;
      const { style, section } = stableParts(root, "root card");
      style.textContent = `${BASE}${PROMPT_CSS}${DIALOG_CSS}${brandStyle(this.state.entitlement, this.client?.brandColor?.())}`;
      if (!view) {
        section.replaceChildren();
        return;
      }
      const row = view.actions;
      const button2 = (a, cls) => `<button type="button" class="${cls}" data-action="${a.id}"${a.disabled ? " disabled" : ""}>${escapeHtml(a.label)}</button>`;
      const said = announce ? view.announcement : root.querySelector("[data-announce]")?.textContent ?? "";
      section.dataset.reason = view.reason;
      section.setAttribute("aria-labelledby", "limit-title");
      section.innerHTML = `
          <div class="mark">${icon(view.reason === "plan_ready" ? "check" : view.reason === "usage_limit" ? "clock" : view.reason === "offline" ? "offline" : "warning")}</div>
          <h2 class="title" id="limit-title">${escapeHtml(view.title)}</h2>
          <div class="body">${view.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>
          ${this.state.pageError ? `<p class="notice" data-kind="alert" role="alert">${icon("warning")}<span>${escapeHtml(pageErrorText(this.state.pageError))}</span></p>` : ""}
          ${view.usage ? `<p class="usage sub" data-usage>${escapeHtml(view.usage)}</p>` : ""}
          ${this.state.page && this.state.pageWhere === "tab" ? `<p class="notice" data-kind="info" data-page-open>${icon("info")}<span>${escapeHtml(pageOpenText(this.state.page))}</span></p>` : ""}
          ${view.notice ? `<p class="no-sale" data-no-sale>${escapeHtml(view.notice)}</p>` : ""}
          <div class="row" style="--secondary: ${Math.max(1, row.filter((a) => !a.primary).length)}">${row.map((a) => button2(a, a.primary ? "primary" : "bordered")).join("")}</div>
          <p class="sr" role="status" data-announce>${escapeHtml(said)}</p>`;
      for (const el of section.querySelectorAll("[data-action]")) {
        el.addEventListener("click", () => void this.#act(el.dataset.action));
      }
    }
    async #act(action2) {
      if (action2 === "try-again" || action2 === "retry-request") {
        this.client?.retryConnection?.();
        this.hide();
        this.dispatchEvent(new CustomEvent("kapai-retry", { bubbles: true, composed: true }));
        return;
      }
      if (action2 === "dismiss") return this.hide();
      await this.runAction(action2);
    }
    announce(text) {
      this.hide();
      super.announce(text);
    }
  };
}
var planKey = ({ customer, membership, usage }) => `${customer ? "customer" : "new"}/${membership?.status ?? "none"}/${usage.requestsPerDay !== null && (usage.requestsToday ?? 0) >= usage.requestsPerDay ? "full" : "room"}`;

// src/ui/paywall.ts
var DEFAULT_LABELS = {
  title: "Buy credits",
  intro: "Choose the membership or a top-up.",
  membership: "Membership",
  topup_s: "Top-up S",
  topup_m: "Top-up M",
  topup_l: "Top-up L",
  /** `{credits}` and `{price}` are the product's. */
  topupPrice: "{credits} credits \xB7 {price}",
  /** `{credits}` and `{price}` are the membership's. */
  membershipPrice: "{credits} credits each month \xB7 {price} a month",
  continue: "Continue",
  /** The line when the user presses Continue with no product chosen. */
  choose: "Choose a plan or a top-up.",
  restore: "Restore purchase\u2026",
  manage: "Manage membership\u2026",
  /** `{credits}` is the user's credits now. */
  current: "{credits} credits left.",
  /** The line of a member. */
  member: "Your membership is active.",
  loading: "Loading the products\u2026",
  loadError: "Couldn't load the products.",
  retry: "Try again",
  /** The server sells nothing now. */
  empty: "This app has nothing for sale now."
};
var STYLES = `
.root { display: grid; }
.intro { margin-top: 12px; }
.choices { display: grid; gap: 8px; margin: 12px 0 0; padding: 0; border: 0; min-width: 0; }
.choice { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--kapai-border);
  background: var(--kapai-surface); cursor: pointer; }
.choice:has(input:checked) { border-color: var(--kapai-brand, var(--kapai-default-brand)); box-shadow: inset 0 0 0 1px var(--kapai-brand, var(--kapai-default-brand)); background: color-mix(in srgb, var(--kapai-brand, var(--kapai-default-brand)) 6%, var(--kapai-surface)); }
.choice:has(input:focus-visible) { outline: 2px solid var(--kapai-brand, var(--kapai-default-brand)); outline-offset: 2px; }
.choice input { width: 16px; height: 16px; min-height: 0; margin: 0; padding: 0; accent-color: var(--kapai-brand, var(--kapai-default-brand)); flex: none; }
.choice input:focus-visible { outline: none; }
.choice .name { font-weight: 600; flex: 1; }
.choice .price { text-align: end; font-variant-numeric: tabular-nums; }
::slotted([slot=features]) { margin: 12px 0 0; }
.current { margin-top: 4px; font-size: 12px; line-height: 17px; color: var(--kapai-muted); }
.buttons { display: grid; gap: 4px; margin-top: 16px; }
.buttons button { width: 100%; }
.status { margin-top: 8px; font-size: 12px; line-height: 17px; color: var(--kapai-danger); }
.status:empty { display: none; }
`;
var money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
var forSale = (e) => e.products.filter((p) => p.amountCents > 0).sort((a, b) => Number(b.interval === "month") - Number(a.interval === "month"));
function defineKapaiPaywall(registry = globalThis.customElements, name = "kapai-paywall") {
  if (!registry || registry.get(name)) return;
  registry.define(name, createElementClass3());
}
function createElementClass3() {
  return class KapaiPaywallElement extends kapaiElement() {
    #labels = {};
    #product;
    #status = "";
    get labels() {
      return this.#labels;
    }
    set labels(labels) {
      this.#labels = labels ?? {};
      this.render();
    }
    draw() {
      const { style, section } = stableParts(this.shadowRoot, "root card");
      const e = this.state.entitlement;
      const label = { ...DEFAULT_LABELS, ...this.#labels };
      const text = (key) => escapeHtml(String(label[key]));
      style.textContent = `${BASE}${STYLES}${brandStyle(e, this.client?.brandColor?.())}`;
      section.setAttribute("part", "paywall");
      if (!this.client) {
        section.replaceChildren();
        return;
      }
      if (!e) {
        section.innerHTML = this.state.failed ? `<p role="alert">${text("loadError")}</p><div class="buttons"><button type="button" class="bordered" data-action="retry">${text("retry")}</button></div>` : `<p class="sub">${text("loading")}</p>`;
        section.querySelector("[data-action=retry]")?.addEventListener("click", () => void this.load(true));
        return;
      }
      const products = forSale(e);
      const chosen = products.find((p) => p.id === this.#product);
      const member = hasMembership(e);
      const n = new Intl.NumberFormat();
      const restore = e.restoreAvailable === false || e.customer ? "" : `<button type="button"${products.length === 0 ? ` class="bordered"` : ""} part="button" data-action="restore">${text("restore")}</button>`;
      const manage = member ? `<button type="button" class="${products.length ? "bordered" : "primary"}" part="button" data-action="manage">${text("manage")}</button>` : "";
      const now = member ? label.member : label.current.replaceAll("{credits}", n.format(e.usage.credits.left));
      const current = `<p class="current" part="current">${escapeHtml(now)}</p>`;
      let body;
      if (products.length === 0) {
        body = `<p part="empty" data-empty>${text("empty")}</p>${current}${restore || manage ? `<div class="buttons">${manage}${restore}</div>` : ""}`;
      } else {
        const rows = products.map((p) => {
          const price = (p.interval === "month" ? label.membershipPrice : label.topupPrice).replaceAll("{credits}", n.format(p.credits)).replaceAll("{price}", money.format(p.amountCents / 100));
          return `<label class="choice" part="product" data-product="${p.id}">
              <input type="radio" name="product" value="${p.id}"${p === chosen ? " checked" : ""}>
              <span class="name" part="product-name">${text(p.id)}</span>
              <span class="price" part="price">${escapeHtml(price)}</span>
            </label>`;
        }).join("");
        body = `<slot name="header"><h2 class="big" part="title" id="products-title">${text("title")}</h2></slot>${current}<p class="intro" part="intro">${text("intro")}</p>
          <fieldset class="choices" part="products" role="radiogroup" aria-labelledby="products-title">${rows}</fieldset>
          <slot name="features"></slot>
          <div class="buttons">
            <button type="button" class="primary" part="button" data-action="continue">${text("continue")}</button>
            ${manage}${restore}
          </div>`;
      }
      section.innerHTML = `${body}<slot name="footer"></slot><p class="status" part="status" role="status" aria-live="polite">${escapeHtml(this.#status)}</p>`;
      for (const input of section.querySelectorAll("input[name=product]")) {
        input.addEventListener("change", () => {
          this.#product = input.value;
          this.#status = "";
          this.render();
          this.shadowRoot.querySelector(`input[value=${input.value}]`)?.focus();
        });
      }
      const fail = (err) => {
        this.#status = err instanceof Error ? err.message : String(err);
        this.render();
      };
      const on = (action2, run) => section.querySelector(`[data-action=${action2}]`)?.addEventListener("click", () => {
        this.#status = "";
        run().catch(fail);
      });
      on("continue", async () => {
        if (chosen) return this.client.upgrade({ product: chosen.id });
        this.#status = label.choose;
        this.render();
        this.shadowRoot.querySelector("input[name=product]")?.focus();
      });
      on("manage", () => this.client.manage());
      on("restore", () => this.client.restore());
    }
  };
}

// src/ui/pill.ts
var PILL_CSS = `
:host { display: inline-block; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 28px; min-height: 28px; padding: 0 10px; border-radius: 14px;
  border: 1px solid var(--kapai-border); background: var(--kapai-surface); font-size: 12px; line-height: 16px; font-weight: 500; white-space: nowrap; }
.pill svg { width: 14px; height: 14px; flex: none; }
.pill .lead { color: var(--kapai-muted); }
.pill .lead.warn { color: var(--kapai-warning); }
.pill .chev { color: var(--kapai-muted); width: 12px; height: 12px; }
.pill .spinner { width: 12px; height: 12px; }
.short { display: none; }
@media (max-width: 520px) { .full { display: none; } .short { display: inline; } }
.pop { position: fixed; inset: auto; margin: 0; padding: 0; width: min(340px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow: auto;
  border: 1px solid var(--kapai-border); border-radius: var(--kapai-radius); background: var(--kapai-surface); color: var(--kapai-text);
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.18); }
.pop:popover-open { animation: kapai-fade 120ms ease-out; }
@media (prefers-reduced-motion: reduce) { .pop:popover-open { animation: none; } }
`;
function defineKapaiPlanPill(registry = globalThis.customElements, name = "kapai-plan-pill") {
  if (!registry || registry.get(name)) return;
  registry.define(name, createElementClass4());
}
function createElementClass4() {
  return class KapaiPlanPillElement extends kapaiElement() {
    static observedAttributes = ["usage"];
    attributeChangedCallback() {
      this.render();
    }
    #restoreFocus = false;
    draw() {
      const root = this.shadowRoot;
      if (!root.querySelector(".pill")) {
        root.innerHTML = `<style></style><button type="button" class="pill root" aria-haspopup="dialog" aria-expanded="false" data-action="toggle"></button>
          <div class="pop root" popover="auto" role="dialog" aria-label="AI plan"><kapai-account plain data-nested></kapai-account></div>`;
        const pill2 = root.querySelector(".pill");
        const pop2 = root.querySelector(".pop");
        pill2.addEventListener("click", () => pop2.togglePopover?.());
        const place = () => this.#place(pill2, pop2);
        if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => pop2.matches(":popover-open") && place()).observe(pop2);
        pop2.addEventListener("toggle", (event) => {
          const open = event.newState === "open";
          pill2.setAttribute("aria-expanded", String(open));
          if (open) {
            place();
            addEventListener("resize", place);
          } else removeEventListener("resize", place);
        });
      }
      const card = root.querySelector("kapai-account");
      if (card && this.client && card.client !== this.client) card.client = this.client;
      root.querySelector("style").textContent = `${BASE}${PILL_CSS}${brandStyle(this.state.entitlement, this.client?.brandColor?.())}`;
      const pill = root.querySelector(".pill");
      const pop = root.querySelector(".pop");
      if (this.state.page && pop.matches(":popover-open")) {
        this.#restoreFocus = true;
        pop.hidePopover();
      } else if (!this.state.page && this.#restoreFocus) {
        this.#restoreFocus = false;
        pill.focus();
      }
      pill.hidden = !this.client;
      if (!this.client) return;
      const view = cardView({ ...this.state, ...this.connection(), source: this.sourceState(), appName: this.getAttribute("app-name") ?? void 0 }).pill;
      const lead = view.icon === "spinner" ? `<span class="spinner" aria-hidden="true"></span>` : view.icon === "warning" ? `<span class="lead warn">${icon("warning")}</span>` : view.icon === "offline" ? `<span class="lead">${icon("offline")}</span>` : "";
      pill.setAttribute("aria-label", view.label);
      pill.innerHTML = `${lead}<span class="full">${escapeHtml(this.hasAttribute("usage") ? view.withUsage : view.text)}</span><span class="short">${escapeHtml(this.hasAttribute("usage") ? view.withUsage : view.short)}</span><span class="chev">${icon(view.icon === "window" ? "window" : "chevron")}</span>`;
    }
    /** Puts the popover below the pill when it fits there, else above it, and always inside the window. */
    #place(pill, pop) {
      const rect = pill.getBoundingClientRect();
      const { offsetWidth: width, offsetHeight: height } = pop;
      const left = Math.min(Math.max(8, rect.left), innerWidth - width - 8);
      const below = rect.bottom + 6;
      const top = below + height <= innerHeight - 8 ? below : rect.top - 6 - height;
      pop.style.left = `${Math.max(8, left)}px`;
      pop.style.top = `${Math.min(Math.max(8, top), Math.max(8, innerHeight - height - 8))}px`;
    }
  };
}

// src/ui/source.ts
var PICKER_CSS = `
.root { display: grid; padding: 20px; }
.intro { margin-top: 8px; }
.choices { display: grid; gap: 8px; margin: 20px 0 0; padding: 0; border: 0; min-width: 0; }
.choice { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: start; min-height: 64px; padding: 12px; border-radius: 8px;
  border: 1px solid var(--kapai-border); background: var(--kapai-surface); cursor: pointer; }
.choice:has(input:checked) { border-color: var(--kapai-brand, var(--kapai-default-brand)); box-shadow: inset 0 0 0 1px var(--kapai-brand, var(--kapai-default-brand)); background: color-mix(in srgb, var(--kapai-brand, var(--kapai-default-brand)) 6%, var(--kapai-surface)); }
.choice input { grid-row: span 2; width: 16px; height: 16px; min-height: 0; margin: 1px 0 0; padding: 0; accent-color: var(--kapai-brand, var(--kapai-default-brand)); }
.choice:has(input:focus-visible) { outline: 2px solid var(--kapai-brand, var(--kapai-default-brand)); outline-offset: 2px; }
.choice input:focus-visible { outline: none; }
.choice strong { font-weight: 600; }
.details { display: grid; gap: 8px; margin-top: 16px; }
.details form { display: grid; gap: 10px; margin-top: 4px; }
.details { gap: 8px; }
.field { display: grid; gap: 4px; }
.field label { font-size: 12px; line-height: 16px; font-weight: 600; }
.field .hint { font-size: 12px; line-height: 17px; color: var(--kapai-muted); }
.field-error { display: flex; gap: 6px; font-size: 12px; line-height: 17px; color: var(--kapai-danger); }
.field-error:empty { display: none; }
.field-error svg { flex: none; width: 14px; height: 14px; margin-top: 1.5px; }
input[aria-invalid=true] { border-color: var(--kapai-danger); }
input::placeholder { color: var(--kapai-muted); opacity: 0.8; font-style: italic; }
.test { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.status { display: flex; gap: 8px; margin-top: 12px; font-size: 12px; line-height: 17px; }
.status:empty { display: none; }
.status[data-kind=error] { color: var(--kapai-danger); }
.status[data-kind=error] svg { color: var(--kapai-danger); }
.status[data-kind=ok] { color: var(--kapai-success); }
.status svg { flex: none; width: 14px; height: 14px; margin-top: 1.5px; }
.buttons { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.buttons button { min-width: 88px; }
`;
function defineKapaiAISource(registry = globalThis.customElements, name = "kapai-ai-source") {
  if (!registry || registry.get(name)) return;
  registry.define(name, createElementClass5());
}
function createElementClass5() {
  return class KapaiAISourceElement extends kapaiElement() {
    static observedAttributes = ["select"];
    #choice;
    #kind;
    #busy = false;
    #status = null;
    /** An error next to each field, by field name. */
    #errors = {};
    attributeChangedCallback() {
      this.#choice = void 0;
      this.render();
    }
    /** The choice on screen: the user's preview, the `select` attribute, or the source in use. */
    #current() {
      if (this.#choice) return this.#choice;
      const select = this.getAttribute("select");
      if (select === "own" || select === "included") return select === "own" ? "own" : "kapai";
      return ownKeyInUse(this.sourceState()) ? "own" : "kapai";
    }
    draw() {
      const root = this.shadowRoot;
      const client = this.client;
      const e = this.state.entitlement;
      const source = this.sourceState();
      if (!client || !e || !source) {
        root.innerHTML = `<style>${BASE}</style><div class="root" style="padding:20px"><p class="sub">Setting up included AI\u2026</p></div>`;
        return;
      }
      const words = sourceChoices(source.policy, e.app.name);
      if (!words.own) {
        root.innerHTML = "";
        return;
      }
      const typed = new Map([...root.querySelectorAll("form input")].map((input) => [input.name, input.value]));
      const choice = this.#current();
      const config = source.config;
      const kinds = client.ownAI.kinds();
      const kind = this.#kind ?? (config && kinds.includes(config.kind) ? config.kind : kinds[0]) ?? "";
      const member = hasMembership(e);
      let details;
      if (choice === "kapai") {
        const card = cardView({ entitlement: e, now: Date.now() });
        const warning = card.notices.find((n) => n.kind === "warning");
        details = [
          `<p class="usage" data-plan>${escapeHtml(card.title)}</p>`,
          card.usage ? `<p>${escapeHtml(card.usage.text)}</p>` : "",
          card.usage?.reset ? `<p class="sub">${escapeHtml(card.usage.reset)}</p>` : "",
          warning ? `<p class="notice" data-kind="warning">${icon("warning")}<span>${escapeHtml(warning.text)}</span></p>` : "",
          source.policy === "outage_only" && config ? `<p class="sub">Your saved key will be removed.</p>` : ""
        ].join("");
      } else if (source.managed) {
        const label = "label" in source.managed ? source.managed.label : null;
        const settings = this.managedOwnAI()?.openSettings;
        details = [
          label ? `<p data-connected>Connected to ${escapeHtml(label)}.</p><p class="sub">Included AI usage does not apply to this source.</p>` : `<p>Set up your own key in ${escapeHtml(e.app.name)}.</p>`,
          member ? `<p class="sub">Using your own key does not cancel your membership.</p>` : "",
          settings ? `<div class="test"><button type="button" class="bordered" data-action="open-settings">${label ? "Change key\u2026" : "Set up my own key\u2026"}</button></div>` : ""
        ].join("");
      } else {
        const fields = fieldsFor(kind).map((f) => {
          const saved = typed.get(f.name) ?? (config?.kind === kind && !f.secret ? String(config[f.name] ?? "") : "");
          const kept = Boolean(f.secret && config?.kind === kind && config[f.name]);
          const placeholder = kept ? "Saved. Leave empty to keep it." : f.placeholder;
          const error = this.#errors[f.name] ?? "";
          const id = `field-${f.name}`;
          return `<div class="field">
              <label for="${id}">${escapeHtml(f.label)}</label>
              <input id="${id}" name="${f.name}" type="${f.secret ? "password" : "text"}" value="${escapeHtml(saved)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false"${f.required && !kept ? " required" : ""}${error ? ` aria-invalid="true"` : ""} aria-describedby="${id}-hint ${id}-error">
              ${f.hint ? `<p class="hint" id="${id}-hint" data-hint="${f.name}">${escapeHtml(f.hint)}</p>` : ""}
              <p class="field-error" id="${id}-error" data-error-for="${f.name}">${error ? `${icon("warning")}<span>${escapeHtml(error)}</span>` : ""}</p>
            </div>`;
        }).join("");
        details = [
          config ? `<p data-connected>Connected to ${escapeHtml(sourceName(config))}.</p><p class="sub">Included AI usage does not apply to this source.</p>` : `<p>Connect your service to use your own key.</p>`,
          member ? `<p class="sub">Using your own key does not cancel your membership.</p>` : "",
          `<form novalidate>
            <div class="field">
              <label for="field-kind">Provider</label>
              <select id="field-kind" name="kind" aria-describedby="field-kind-hint">${kinds.map((k) => `<option value="${escapeHtml(k)}"${k === kind ? " selected" : ""}>${escapeHtml(kindLabel(k))}</option>`).join("")}</select>
              ${kindHint(kind) ? `<p class="hint" id="field-kind-hint" data-hint="kind">${escapeHtml(kindHint(kind))}</p>` : ""}
            </div>
            ${fields}
            ${config ? `<div class="test"><button type="button" class="bordered" data-action="test"${this.#busy ? " disabled" : ""}>Test connection</button></div>` : ""}
          </form>`
        ].join("");
      }
      const status = this.#status;
      const radio = (value, label, description) => `<label class="choice"><input type="radio" name="source" value="${value}"${choice === value ? " checked" : ""}><strong>${escapeHtml(label)}</strong><span class="sub">${escapeHtml(description)}</span></label>`;
      root.innerHTML = `<style>${BASE}${PICKER_CSS}${brandStyle(e, this.client?.brandColor?.())}</style>
        <div class="root">
          <h2 class="big" id="title">${escapeHtml(words.title)}</h2>
          <p class="intro">${escapeHtml(words.intro)}</p>
          <fieldset class="choices" role="radiogroup" aria-labelledby="title">
            ${radio("kapai", words.included.label, words.included.description)}
            ${radio("own", words.own.label, words.own.description)}
          </fieldset>
          <div class="details" data-details>${details}</div>
          <p class="status" role="status" aria-live="polite" data-kind="${status?.kind ?? "info"}">${status ? `${status.kind === "error" ? icon("warning") : ""}<span>${escapeHtml(status.text)}${status.detail ? `<br>${escapeHtml(status.detail)}` : ""}</span>` : ""}</p>
          <div class="buttons">
            <button type="button" class="bordered" data-action="cancel">Cancel</button>
            <button type="button" class="primary" data-action="commit"${this.#busy ? " disabled" : ""}>${this.#busy ? "Changing source\u2026" : "Use this source"}</button>
          </div>
        </div>`;
      this.#bind(kind);
    }
    #bind(kind) {
      const root = this.shadowRoot;
      const client = this.client;
      const on = (selector, type, handler) => root.querySelector(selector)?.addEventListener(type, handler);
      const commit = root.querySelector("[data-action=commit]");
      for (const input of root.querySelectorAll("input[name=source]")) {
        input.addEventListener("change", () => {
          this.#choice = input.value;
          this.#status = null;
          this.#errors = {};
          this.render();
          root.querySelector(`input[name=source][value=${input.value}]`)?.focus();
        });
      }
      for (const input of root.querySelectorAll("form input")) {
        const field = fieldsFor(kind).find((f) => f.name === input.name);
        input.addEventListener("input", () => {
          if (this.#errors[input.name]) {
            delete this.#errors[input.name];
            this.#showError(input.name);
          }
          commit.disabled = this.#busy || !this.#ready(this.#current(), kind);
        });
        input.addEventListener("blur", () => {
          if (!input.required || input.value.trim() || !field) return;
          this.#errors[input.name] = `Enter the ${field.label.charAt(0).toLowerCase()}${field.label.slice(1).replace(/ \(optional\)$/, "")}.`;
          this.#showError(input.name);
        });
      }
      commit.disabled = this.#busy || !this.#ready(this.#current(), kind);
      on("select[name=kind]", "change", (event) => {
        this.#kind = event.target.value;
        this.#status = null;
        this.#errors = {};
        for (const input of root.querySelectorAll("form input")) input.value = "";
        this.render();
      });
      on("form", "submit", (event) => {
        event.preventDefault();
        if (!commit.disabled) void this.#commit(kind);
      });
      on("[data-action=cancel]", "click", () => {
        this.#choice = void 0;
        this.#status = null;
        this.#errors = {};
        this.render();
        this.dispatchEvent(new CustomEvent("kapai-cancel", { bubbles: true, composed: true }));
      });
      on("[data-action=commit]", "click", () => void this.#commit(kind));
      on("[data-action=open-settings]", "click", () => {
        this.dispatchEvent(new CustomEvent("kapai-cancel", { bubbles: true, composed: true }));
        this.managedOwnAI()?.openSettings?.();
      });
      on("[data-action=test]", "click", () => {
        this.#busy = true;
        this.#status = { text: "Testing the connection\u2026", kind: "info" };
        this.render();
        void client.ownAI.test().then((result) => {
          this.#busy = false;
          this.#status = result.ok ? { text: "Connection works.", kind: "ok" } : { text: "The connection failed.", detail: result.error.message, kind: "error" };
          this.render();
        });
      });
    }
    /** True when the choice can be saved: Included AI, or each required field of the service has a value. */
    #ready(choice, kind) {
      if (choice !== "own") return true;
      const managed = this.sourceState()?.managed;
      if (managed) return "label" in managed && managed.label !== null;
      const root = this.shadowRoot;
      return fieldsFor(kind).every((f) => {
        const input = root.querySelector(`form input[name=${f.name}]`);
        return !f.required || input !== null && (!input.required || Boolean(input.value.trim()));
      });
    }
    /** Puts the field's error, or none, next to the field, without a new render. */
    #showError(name) {
      const root = this.shadowRoot;
      const slot = root.querySelector(`[data-error-for=${name}]`);
      const input = root.querySelector(`form input[name=${name}]`);
      const error = this.#errors[name];
      if (slot) slot.innerHTML = error ? `${icon("warning")}<span>${escapeHtml(error)}</span>` : "";
      if (error) input?.setAttribute("aria-invalid", "true");
      else input?.removeAttribute("aria-invalid");
    }
    async #commit(kind) {
      const client = this.client;
      const e = this.state.entitlement;
      if (!client || !e || this.#busy) return;
      const root = this.shadowRoot;
      const choice = this.#current();
      const values = {};
      for (const input of root.querySelectorAll("form input")) values[input.name] = input.value;
      this.#busy = true;
      this.#status = { text: "Changing AI source\u2026", kind: "info" };
      this.render();
      let text;
      try {
        const managed = this.managedOwnAI();
        if (managed) {
          await managed.setActive?.(choice === "own");
          client.ownAI.changed();
          const label = this.sourceState()?.managed;
          text = choice === "own" ? `Using ${label && "label" in label && label.label ? label.label : "your own key"}.` : "Using included AI.";
        } else if (choice === "own") {
          const config = configFromForm(kind, values, client.ownAI.get());
          await client.ownAI.configure(config);
          if (e.app.ownAIPolicy === "anytime") await client.ownAI.prefer(true);
          text = e.app.ownAIPolicy === "anytime" ? `Using ${sourceName(config)}.` : `Saved ${sourceName(config)} as a backup.`;
        } else {
          if (e.app.ownAIPolicy === "anytime") await client.ownAI.prefer(false);
          else if (client.ownAI.get()) await client.ownAI.configure(null);
          text = "Using included AI.";
        }
      } catch (err) {
        this.#busy = false;
        const message = err instanceof Error ? err.message : String(err);
        const field = choice === "own" ? fieldsFor(kind).find((f) => message.toLowerCase().includes(f.label.replace(/ \(optional\)$/, "").toLowerCase())) : void 0;
        if (field) this.#errors = { [field.name]: message };
        this.#status = { text: "Couldn't change the AI source. Your previous source is still selected.", ...field ? {} : { detail: message }, kind: "error" };
        this.render();
        return;
      }
      this.#busy = false;
      this.#choice = void 0;
      this.#kind = void 0;
      this.#status = { text, kind: "ok" };
      this.render();
      this.dispatchEvent(new CustomEvent("kapai-source-change", { detail: { source: choice, text }, bubbles: true, composed: true }));
      renderAll();
    }
  };
}

// src/ui/index.ts
defineKapaiAccount();
defineKapaiAISource();
defineKapaiPlanPill();
defineKapaiLimitPrompt();
defineKapaiPaywall();

export {
  longDate,
  resetPhrase,
  usageView,
  sourceName,
  cardView,
  sourceChoices,
  limitView,
  readyView,
  shortDate,
  planView,
  statusLine,
  brandColor,
  onBrandText,
  kindLabel,
  kindHint,
  fieldsFor,
  configFromForm,
  connectElements,
  defineKapaiAccount,
  defineKapaiLimitPrompt,
  defineKapaiPaywall,
  defineKapaiPlanPill,
  defineKapaiAISource
};
