import {
  KapaiError,
  KapaiOwnAI,
  KapaiUnavailableError,
  MAX_TOOLS,
  OwnAIError,
  QuotaExceededError,
  RateLimitedError,
  abortReason,
  canonicalJwk,
  classifyResponse,
  devPill,
  errorFromResponse,
  isOwnAIActive,
  leadingZeroBits,
  openPage,
  powInput,
  purchaseOf,
  raceAbort,
  streamErrorStatus,
  throwIfAborted,
  tokenSigningInput
} from "./chunk-E7V4HG2S.js";

// src/internal/http.ts
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
  const tracked = config.trackUpload ? await trackedBody(init) : null;
  let answered = false;
  try {
    const response = await withTimeout(
      (async () => {
        if (signal?.aborted) throw abortReason(signal);
        const response2 = await config.fetch(`${config.baseUrl}${path}`, { ...init, ...tracked?.init, signal: controller.signal });
        answered = true;
        if (tracked && response2.status >= 300 && response2.status < 400) {
          await response2.body?.cancel();
          throw new KapaiUnavailableError("bad_response", "Kapai sent an answer that the SDK cannot read.", response2.status);
        }
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
    const upload = !answered && brokeUpload(err, tracked?.state ?? null);
    const error = new KapaiUnavailableError("network_error", "Kapai is not reachable. Check the network connection.", 0, {
      cause: err instanceof Error ? err.message : String(err),
      ...upload ? { upload: true } : {}
    });
    if (!answered && tracked?.state.done) sentWhole.add(error);
    throw error;
  }
}
var uploadFailed = (err) => err instanceof KapaiUnavailableError && err.details.upload === true;
var sentWhole = /* @__PURE__ */ new WeakSet();
var bodySentWhole = (err) => err instanceof KapaiUnavailableError && sentWhole.has(err);
var BROKEN = /* @__PURE__ */ new Set(["EPIPE", "ECONNRESET", "UND_ERR_SOCKET"]);
var CHUNK = 64 * 1024;
function brokeUpload(err, upload) {
  if (!upload || upload.pulls < 2 || upload.done) return false;
  for (let cause = err; cause instanceof Error; cause = cause.cause) {
    const { code } = cause;
    if (typeof code === "string" && BROKEN.has(code)) return true;
  }
  return false;
}
async function trackedBody(init) {
  if (!(typeof init.body === "string" || init.body instanceof FormData) || (init.redirect ?? "follow") !== "follow") return null;
  const encoded = new Request("http://kapai.invalid/", { method: "POST", body: init.body });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  if (bytes.byteLength <= 1) return null;
  const chunk = Math.min(CHUNK, Math.ceil(bytes.byteLength / 2));
  const headers = new Headers(init.headers);
  const type = encoded.headers.get("content-type");
  if (type && !headers.has("content-type")) headers.set("content-type", type);
  headers.set("content-length", String(bytes.byteLength));
  const state = { pulls: 0, done: false };
  let at = 0;
  const body = new ReadableStream(
    {
      pull(stream) {
        state.pulls += 1;
        stream.enqueue(bytes.subarray(at, at += chunk));
        if (at >= bytes.byteLength) {
          state.done = true;
          stream.close();
        }
      }
    },
    // No pull before the fetch reads.
    { highWaterMark: 0 }
  );
  return { init: { body, headers, duplex: "half", redirect: "manual" }, state };
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

// src/internal/audio.ts
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
  if (!(error instanceof KapaiUnavailableError) || uploadFailed(error)) return false;
  if (error.status === 0) return error.code !== "timeout" && error.code !== "registration_timeout";
  return error.code === "unavailable" || error.code === "bad_response";
}

// src/incomplete.ts
function incompleteOf(status) {
  return status === "incomplete" ? { incomplete: { reason: "max_output_tokens" } } : {};
}

// src/internal/sse.ts
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

// src/internal/responses.ts
function markIncomplete(output, incomplete) {
  return incomplete ? output.map((item) => item.type === "function_call" ? { ...item, status: "incomplete" } : item) : output;
}
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
  if (item?.type !== "function_call" || !("providerData" in item || "status" in item)) return item;
  const { providerData: _, status: _status, ...rest } = item;
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
        const incomplete = incompleteOf(response.status);
        yield { type: "done", text: response.output_text, toolCalls, output: markIncomplete(output, incomplete.incomplete), ...response.usage ? { usage: response.usage } : {}, ...incomplete };
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

// src/internal/media.ts
var MAX_MEDIA_ITEMS = 4;
var MAX_MEDIA_ITEM_BYTES = 4 * 1024 * 1024;
var MAX_IMAGE_EDGE = 1024;
var MAX_MEDIA_BODY_BYTES = 6 * 1024 * 1024;
var MAX_BODY_BYTES = 1024 * 1024;
var MAX_DECODE_PIXELS = 5e7;
var MAX_BROWSER_FILE_BYTES = 25 * 1024 * 1024;
var MEDIA_UPLOAD_TIMEOUT_MS = 6e4;
var IMAGE_FORMATS = ["png", "jpeg", "webp"];
var PDF_FORMATS = ["pdf"];
var MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", pdf: "application/pdf" };
var NAME = { png: "PNG image", jpeg: "JPEG image", webp: "WebP image", pdf: "PDF document" };
var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
var NO_SIZE = "Kapai cannot read the size of this image.";
var EDGE_MESSAGE = "An image is larger than 1,024 pixels on its long edge. Make it smaller before you send it.";
var SHRINK_MESSAGE = "Make the image smaller before you send it, for example with sharp.";
var BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var JPEG_QUALITY = 0.85;
var issue = (path, message) => new KapaiError("invalid_request", message, 0, { issues: [{ path, message }] });
var startsWithAnyCase = (text, prefix) => text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
var take = (bytes, at, n) => at + n <= bytes.length ? bytes.subarray(at, at + n) : void 0;
var be16 = (b, at) => {
  const d = take(b, at, 2);
  return d ? d[0] << 8 | d[1] : void 0;
};
var be32 = (b, at) => {
  const d = take(b, at, 4);
  return d ? (d[0] << 24 | d[1] << 16 | d[2] << 8 | d[3]) >>> 0 : void 0;
};
var le16 = (b, at) => {
  const d = take(b, at, 2);
  return d ? d[0] | d[1] << 8 : void 0;
};
var le24 = (b, at) => {
  const d = take(b, at, 3);
  return d ? d[0] | d[1] << 8 | d[2] << 16 : void 0;
};
var le32 = (b, at) => {
  const d = take(b, at, 4);
  return d ? (d[0] | d[1] << 8 | d[2] << 16 | d[3] << 24) >>> 0 : void 0;
};
var same = (bytes, of) => bytes !== void 0 && bytes.length === of.length && of.every((byte, at) => bytes[at] === byte);
var ascii2 = (text) => [...text].map((character) => character.charCodeAt(0));
function pngSize(bytes) {
  if (!same(take(bytes, 0, 8), PNG_SIGNATURE) || be32(bytes, 8) !== 13 || !same(take(bytes, 12, 4), ascii2("IHDR"))) return void 0;
  const width = be32(bytes, 16);
  const height = be32(bytes, 20);
  if (width === void 0 || height === void 0) return void 0;
  let at = 8;
  for (; ; ) {
    const length = be32(bytes, at);
    const end = length === void 0 ? void 0 : at + 12 + length;
    if (end === void 0 || end > bytes.length) return void 0;
    const kind = take(bytes, at + 4, 4);
    if (same(kind, ascii2("IDAT"))) return [width, height];
    if (same(kind, ascii2("acTL"))) return void 0;
    at = end;
  }
}
function jpegSize(bytes) {
  if (!same(take(bytes, 0, 2), [255, 216])) return void 0;
  let at = 2;
  for (; ; ) {
    if (bytes[at] !== 255) return void 0;
    const marker = bytes[at + 1];
    if (marker === void 0) return void 0;
    if (marker === 255) {
      at += 1;
      continue;
    }
    if (marker === 1 || marker >= 208 && marker <= 216) {
      at += 2;
      continue;
    }
    if (marker === 0 || marker === 217 || marker === 218) return void 0;
    const length = be16(bytes, at + 2);
    if (length === void 0) return void 0;
    const end = at + 2 + length;
    if (length < 2 || end > bytes.length) return void 0;
    if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
      if (length < 7) return void 0;
      const height = be16(bytes, at + 5);
      const width = be16(bytes, at + 7);
      return height === void 0 || width === void 0 ? void 0 : [width, height];
    }
    at = end;
  }
}
function webpSize(bytes) {
  if (!same(take(bytes, 0, 4), ascii2("RIFF")) || !same(take(bytes, 8, 4), ascii2("WEBP"))) return void 0;
  const riff = le32(bytes, 4);
  const whole = riff === void 0 ? void 0 : take(bytes, 0, riff + 8);
  if (whole === void 0) return void 0;
  let at = 12;
  let canvas;
  let frame;
  while (at < whole.length) {
    const length = le32(whole, at + 4);
    const data = length === void 0 ? void 0 : take(whole, at + 8, length);
    const kind = take(whole, at, 4);
    if (length === void 0 || data === void 0 || kind === void 0) return void 0;
    const id = String.fromCharCode(...kind);
    if (id === "VP8X" && canvas === void 0) {
      if ((take(data, 0, 1)?.[0] ?? 0) & 2) return void 0;
      const width = le24(data, 4);
      const height = le24(data, 7);
      if (width === void 0 || height === void 0) return void 0;
      canvas = [width + 1, height + 1];
    } else if (id === "VP8 " && frame === void 0) {
      if (!same(take(data, 3, 3), [157, 1, 42])) return void 0;
      const width = le16(data, 6);
      const height = le16(data, 8);
      if (width === void 0 || height === void 0) return void 0;
      frame = [width & 16383, height & 16383];
    } else if (id === "VP8L" && frame === void 0) {
      if (!same(take(data, 0, 1), [47])) return void 0;
      const bits = le32(data, 1);
      if (bits === void 0) return void 0;
      frame = [(bits & 16383) + 1, (bits >> 14 & 16383) + 1];
    } else if (id === "ANIM" || id === "ANMF" || id === "VP8X" || id === "VP8 " || id === "VP8L") {
      return void 0;
    }
    at += 8 + length + (length & 1);
  }
  if (frame === void 0 || at !== whole.length) return void 0;
  return canvas === void 0 || canvas[0] === frame[0] && canvas[1] === frame[1] ? frame : void 0;
}
function imageSize(format, bytes) {
  const size = format === "png" ? pngSize(bytes) : format === "jpeg" ? jpegSize(bytes) : webpSize(bytes);
  return size !== void 0 && size[0] > 0 && size[1] > 0 ? { width: size[0], height: size[1] } : void 0;
}
function starts(format, bytes) {
  if (format === "png") return same(take(bytes, 0, 8), PNG_SIGNATURE);
  if (format === "jpeg") return same(take(bytes, 0, 3), [255, 216, 255]);
  if (format === "webp") return same(take(bytes, 0, 4), ascii2("RIFF")) && same(take(bytes, 8, 4), ascii2("WEBP"));
  return same(take(bytes, 0, 5), ascii2("%PDF-"));
}
function imageFormat(bytes) {
  return starts("png", bytes) ? "png" : starts("jpeg", bytes) ? "jpeg" : starts("webp", bytes) ? "webp" : void 0;
}
var decode = (data) => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
};
var encode = (bytes) => {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(binary);
};
function utf8Length(text) {
  let length = text.length;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code >= 128) length += code < 2048 || code >= 55296 && code <= 57343 ? 1 : 2;
  }
  return length;
}
function outsideMediaRefusal(body) {
  if (body.length <= MAX_BODY_BYTES) return void 0;
  const largest = new Array(MAX_MEDIA_ITEMS + 1).fill(0);
  let found = false;
  let at = 0;
  for (let start = body.indexOf(34); start >= 0; start = body.indexOf(34, at)) {
    at = start + 1;
    while (at < body.length && body[at] !== 34) at += body[at] === 92 ? 2 : 1;
    at = Math.min(at + 1, body.length);
    const head = take(body, start + 1, 5);
    if (head && String.fromCharCode(...head).toLowerCase() === "data:") {
      found = true;
      const smallest = largest.indexOf(Math.min(...largest));
      largest[smallest] = Math.max(largest[smallest], at - start);
    }
  }
  if (body.length - largest.reduce((sum, length) => sum + length, 0) <= MAX_BODY_BYTES) return void 0;
  return new KapaiError("input_too_large", found ? "The request body is larger than 1 MB without its images and documents." : "The request body is larger than 1 MB.", 0);
}
function checkDataUrl(path, value, formats) {
  const dataUrl = typeof value === "string" ? value : "";
  const image = formats.some((format2) => format2 !== "pdf");
  if (!startsWithAnyCase(dataUrl, "data:")) throw issue(path, `Send the ${image ? "image" : "document"} as a data URL. Kapai does not fetch addresses.`);
  const rest = dataUrl.slice(5);
  const format = formats.find((each) => startsWithAnyCase(rest, MIME[each]) && startsWithAnyCase(rest.slice(MIME[each].length), ";base64,"));
  if (format === void 0) throw issue(path, `Expected a base64 data URL of ${image ? "a PNG, JPEG, or WebP image" : "a PDF document"}.`);
  const data = rest.slice(MIME[format].length + 8);
  const length = utf8Length(data);
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const symbols = length - padding;
  if (Math.floor(symbols / 4) * 3 + Math.floor(symbols % 4 * 3 / 4) > MAX_MEDIA_ITEM_BYTES) {
    throw new KapaiError("input_too_large", "An image or a document is larger than 4 MB.", 0, { maxMediaBytes: MAX_MEDIA_ITEM_BYTES });
  }
  if (!BASE64.test(data) || data.length % 4 !== 0) throw issue(path, "The data URL does not hold valid base64.");
  const last = data.length - 1 - padding;
  if (padding > 0 && BASE64_ALPHABET.indexOf(data[last]) % (padding === 2 ? 16 : 4) !== 0) throw issue(path, "The data URL does not hold valid base64.");
  const bytes = decode(data);
  if (!starts(format, bytes)) throw issue(path, `The bytes are not a ${NAME[format]}, as the label says.`);
  if (format === "pdf") return;
  const size = imageSize(format, bytes);
  if (size === void 0) throw issue(path, NO_SIZE);
  if (Math.max(size.width, size.height) > MAX_IMAGE_EDGE) throw new KapaiError("input_too_large", EDGE_MESSAGE, 0, { maxImageEdge: MAX_IMAGE_EDGE });
}
function checkPlaces(places) {
  if (places.length > MAX_MEDIA_ITEMS) {
    throw new KapaiError("input_too_large", `A request takes at most ${MAX_MEDIA_ITEMS} media items: images, image options, and PDF pages.`, 0, {
      maxMediaItems: MAX_MEDIA_ITEMS
    });
  }
  for (const place2 of places) checkDataUrl(place2.path, place2.value, place2.kind === "image" ? IMAGE_FORMATS : PDF_FORMATS);
}
var PART_KINDS = {
  input_image: ["image", "image_url"],
  input_file: ["document", "file_data"],
  input_audio: ["audio", ""],
  input_video: ["video", ""]
};
function chatParts(request) {
  const parts = [];
  for (const [at, item] of (Array.isArray(request.input) ? request.input : []).entries()) {
    const message = item;
    if (message.type !== void 0 && message.type !== "message" || !Array.isArray(message.content)) continue;
    message.content.forEach((part, index) => {
      const type = part?.type;
      const known = typeof type === "string" && Object.hasOwn(PART_KINDS, type) ? PART_KINDS[type] : void 0;
      if (!known) return;
      const [kind, member] = known;
      const contentPath = `input.${at}.content.${index}`;
      parts.push({ contentPath, path: member ? `${contentPath}.${member}` : contentPath, value: part[member], kind, role: message.role });
    });
  }
  return parts;
}
var hasMedia = (request) => chatParts(request).length > 0;
var MEDIA_OFF = "Media input is off for this app. The developer turns it on in the dashboard, in the app's Settings, after Kapai turns it on for the developer.";
function modalityRefusal(kind) {
  const message = {
    // The server names the app's model, which the SDK does not know. shortcut: a PDF goes to no source until the SDK
    // counts its pages (plan, Task 14b); let the adapters name `document` then.
    document: "The model that answers for this app does not take PDF documents. Send the request without them, or choose a model that takes them in the app's Settings.",
    audio: "No Kapai AI model takes audio in a request. Send a recording to speech to text (/v1/transcriptions).",
    video: "No Kapai AI model takes video."
  }[kind];
  return new KapaiError("modality_not_supported", message, 0, { modality: kind });
}
function checkMedia(request, capabilities) {
  const parts = chatParts(request);
  if (parts.length === 0) return;
  const body = responsesBody(request);
  const bytes = utf8Length(body);
  if (bytes > MAX_MEDIA_BODY_BYTES) throw new KapaiError("input_too_large", "The request body is larger than 6 MB.", 0);
  const outside = bytes > MAX_BODY_BYTES ? outsideMediaRefusal(new TextEncoder().encode(body)) : void 0;
  if (outside) throw outside;
  for (const part of parts) if (part.role !== "user") throw issue(part.contentPath, "Images and documents go in a user message.");
  if (capabilities && !capabilities.includes("media")) throw new KapaiError("capability_off", MEDIA_OFF, 0, { capability: "media" });
  const other = parts.find((part) => part.kind !== "image");
  if (other) throw modalityRefusal(other.kind);
  checkPlaces(parts);
}
async function toJpeg(blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const draw = (context) => {
    if (context === null) throw new KapaiError("invalid_request", "The browser cannot make this image smaller.", 0);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
  };
  const failed = () => new KapaiError("invalid_request", "The browser cannot make this image smaller.", 0);
  let jpeg;
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    draw(canvas.getContext("2d"));
    jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext("2d"));
    jpeg = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(failed()), "image/jpeg", JPEG_QUALITY));
  }
  bitmap.close();
  return new Uint8Array(await jpeg.arrayBuffer());
}
async function imagePart(input) {
  const blob = input instanceof Blob ? input : new Blob([input]);
  const browser = typeof createImageBitmap === "function";
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!browser && bytes.length > MAX_MEDIA_ITEM_BYTES) throw new KapaiError("input_too_large", SHRINK_MESSAGE, 0, { maxMediaBytes: MAX_MEDIA_ITEM_BYTES });
  const format = imageFormat(bytes);
  if (format === void 0) {
    if (browser && bytes.length <= MAX_BROWSER_FILE_BYTES) return { type: "input_image", image_url: `data:image/jpeg;base64,${encode(await toJpeg(blob))}` };
    throw new KapaiError("invalid_request", "Expected a PNG, JPEG, or WebP image.", 0);
  }
  const size = imageSize(format, bytes);
  if (size === void 0) throw new KapaiError("invalid_request", NO_SIZE, 0);
  if (browser) {
    if (size.width * size.height > MAX_DECODE_PIXELS) {
      throw new KapaiError("input_too_large", "This image has too many pixels for the browser to make it smaller. Send a smaller image.", 0, { maxImagePixels: MAX_DECODE_PIXELS });
    }
    return { type: "input_image", image_url: `data:image/jpeg;base64,${encode(await toJpeg(blob))}` };
  }
  if (Math.max(size.width, size.height) > MAX_IMAGE_EDGE) throw new KapaiError("input_too_large", SHRINK_MESSAGE, 0, { maxImageEdge: MAX_IMAGE_EDGE });
  return { type: "input_image", image_url: `data:${MIME[format]};base64,${encode(bytes)}` };
}
async function filePart(input, filename) {
  const bytes = new Uint8Array(input instanceof Blob ? await input.arrayBuffer() : input instanceof Uint8Array ? input : new Uint8Array(input));
  if (!starts("pdf", bytes)) throw new KapaiError("invalid_request", "Expected a PDF document.", 0);
  if (bytes.length > MAX_MEDIA_ITEM_BYTES) throw new KapaiError("input_too_large", "The document is larger than 4 MB.", 0, { maxMediaBytes: MAX_MEDIA_ITEM_BYTES });
  const name = filename ?? (input instanceof Blob ? input.name : void 0);
  return { type: "input_file", file_data: `data:application/pdf;base64,${encode(bytes)}`, ...name ? { filename: name } : {} };
}

// src/tools.ts
var states = globalThis[/* @__PURE__ */ Symbol.for("kapai.toolRunStates")] ??= /* @__PURE__ */ new WeakMap();
function toolRunState(error) {
  return typeof error === "object" && error !== null || typeof error === "function" ? states.get(error) : void 0;
}
var NO_TOOL = '{"error":"The app has no tool with this name."}';
var BAD_ARGUMENTS = '{"error":"The arguments are not valid JSON."}';
var NOT_JSON = '{"error":"The tool ran, but its result is not JSON."}';
var NOT_RUN = '{"error":"The round of this call stopped before its end. The call did not run."}';
var NOT_KNOWN = '{"error":"The run stopped while this tool ran. Its result is not known."}';
var StoppedWhileRunning = class {
  constructor(error) {
    this.error = error;
  }
  error;
};
var HandlerError = class {
  constructor(error, call) {
    this.error = error;
    this.call = call;
  }
  error;
  call;
};
async function runTools(respond, request, options) {
  const maxRounds = options.maxRounds ?? 5;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new KapaiError("invalid_request", "Expected maxRounds to be a whole number of 1 or more.", 0);
  const run = { input: typeof request.input === "string" ? [{ role: "user", content: request.input }] : withoutCutCalls(request.input), rounds: 0 };
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let kapaiOnly = false;
  try {
    for (let rounds = 1; ; rounds++) {
      await runPending(run, options.handlers, request.signal);
      throwIfAborted(request.signal);
      const input = run.input;
      const { toolChoice, ...rest } = request;
      const last = await respond({ ...rest, ...rounds === 1 || toolChoice === "auto" || toolChoice === "none" ? { toolChoice } : {}, input }, kapaiOnly);
      run.rounds = rounds;
      kapaiOnly ||= last.source === "kapai" && hasMedia({ input });
      if (last.usage) for (const key of ["input_tokens", "output_tokens", "total_tokens"]) usage[key] += last.usage[key];
      const end = (stopped, pendingCalls) => ({ text: last.text, last, rounds, usage, stopped, pendingCalls, input: run.input });
      if (last.incomplete) return end("incomplete", []);
      run.input = [...input, ...last.output.map(inputOf)];
      if (last.toolCalls.length === 0) return end("done", []);
      if (rounds >= maxRounds) {
        run.input = withBadArguments(run.input, options.handlers);
        const pending = new Set(pendingOf(run.input).map((call) => call.callId));
        return end("max_rounds", last.toolCalls.filter((call) => pending.delete(call.callId)));
      }
    }
  } catch (err) {
    run.input = withBadArguments(run.input, options.handlers);
    const state = { input: run.input, pendingCalls: pendingOf(run.input), rounds: run.rounds, usage };
    throw withState(err, state);
  }
}
function withState(err, state) {
  const handler = err instanceof HandlerError ? err : void 0;
  const error = handler ? handler.error : err;
  if (typeof error === "object" && error !== null || typeof error === "function") {
    states.set(error, state);
    return error;
  }
  const wrapped = handler ? new KapaiError("tool_handler_failed", `The handler of the tool ${handler.call.name} failed: ${String(error)}`, 0, {}, { cause: error }) : new KapaiError("tool_run_failed", `The tool run stopped: ${String(error)}`, 0, {}, { cause: error });
  states.set(wrapped, state);
  return wrapped;
}
function pendingOf(input) {
  const answered = new Set(input.flatMap((item) => item.type === "function_call_output" ? [item.call_id] : []));
  return input.flatMap((item) => item.type === "function_call" && !answered.has(item.call_id) && answered.add(item.call_id) ? [{ callId: item.call_id, name: item.name, arguments: item.arguments }] : []);
}
function withoutCutCalls(input) {
  const answered = new Set(input.flatMap((item) => item.type === "function_call_output" ? [item.call_id] : []));
  const pending = (item) => item.type === "function_call" && !answered.has(item.call_id);
  let start = input.length;
  let text = false;
  while (start > 0) {
    const item = input[start - 1];
    if (pending(item)) start--;
    else if (isAssistant(item) && !text) {
      text = true;
      start--;
    } else break;
  }
  const calls = input.slice(start).filter(pending);
  let kept = input;
  if (calls.some(isCut)) {
    const names = calls.map((call) => `${call.call_id} (${call.name})`).join(", ");
    console.warn(`Kapai: runTools dropped the calls at the end of input that have no output, ${names}, and the assistant text of that round, because one of them is incomplete or has arguments that are not JSON. It asks the model again for that round.`);
    if (start === 0) throw new KapaiError("invalid_request", `runTools dropped the cut calls at the end of input, ${names}, and no input was left. Send the input of the round before them.`, 0);
    kept = input.slice(0, start);
  }
  const dropped = kept !== input;
  const cutBatches = new Set(batchesOf(kept).filter((batch) => batch.some((item) => pending(item) && isCut(item))).flat());
  const notRun = kept.flatMap((item) => pending(item) && (dropped || cutBatches.has(item)) && answered.add(item.call_id) ? [{ type: "function_call_output", call_id: item.call_id, output: NOT_RUN }] : []);
  return place([...kept], notRun);
}
var isAssistant = (item) => item?.role === "assistant";
function place(input, outputs) {
  if (outputs.length === 0) return input;
  const byCall = new Map(outputs.map((output) => [output.call_id, output]));
  return batchesOf(input).flatMap((batch) => [
    ...batch,
    ...batch.flatMap((item) => {
      const output = item.type === "function_call" ? byCall.get(item.call_id) : void 0;
      if (output) byCall.delete(output.call_id);
      return output ? [output] : [];
    })
  ]);
}
function batchesOf(input) {
  const parts = [];
  let i = 0;
  while (i < input.length) {
    let end = i + 1;
    if (input[i].type === "function_call") {
      while (end < input.length && (input[end].type === "function_call" || isAssistant(input[end]))) end++;
      while (end < input.length && input[end].type === "function_call_output") end++;
    }
    parts.push(input.slice(i, end));
    i = end;
  }
  return parts;
}
function withBadArguments(input, handlers) {
  const answered = new Set(input.flatMap((item) => item.type === "function_call_output" ? [item.call_id] : []));
  const outputs = input.flatMap(
    (item) => (
      // The first call of an id decides, as a live round runs only the first call of an id.
      item.type === "function_call" && !answered.has(item.call_id) && answered.add(item.call_id) && !parses(item.arguments) ? [{ type: "function_call_output", call_id: item.call_id, output: handlerOf(handlers, item.name) ? BAD_ARGUMENTS : NO_TOOL }] : []
    )
  );
  return place(input, outputs);
}
function handlerOf(handlers, name) {
  return Object.hasOwn(handlers, name) ? handlers[name] : void 0;
}
var MAX_ARGUMENT_DEPTH = 64;
function parses(args) {
  if (deeperThanMax(args)) return false;
  try {
    JSON.parse(args || "{}");
    return true;
  } catch {
    return false;
  }
}
function deeperThanMax(text) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") {
      if (++depth > MAX_ARGUMENT_DEPTH) return true;
    } else if (c === "]" || c === "}") depth--;
  }
  return false;
}
function isCut(call) {
  const status = call.status;
  if (status !== void 0 && status !== "completed") return true;
  return !parses(call.arguments);
}
function inputOf(item) {
  if (item.type === "function_call") return { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments, ...item.providerData !== void 0 ? { providerData: item.providerData } : {} };
  return { role: "assistant", content: item.content.map((part) => part.text).join("") };
}
async function runPending(run, handlers, signal) {
  const answered = new Set(run.input.flatMap((item) => item.type === "function_call_output" ? [item.call_id] : []));
  const calls = run.input.filter((item) => item.type === "function_call" && !answered.has(item.call_id));
  const base = run.input;
  const done3 = [];
  for (const item of calls) {
    if (answered.has(item.call_id)) continue;
    throwIfAborted(signal);
    answered.add(item.call_id);
    let output;
    try {
      output = await outputOf({ callId: item.call_id, name: item.name, arguments: item.arguments }, handlers, signal);
    } catch (err) {
      if (!(err instanceof StoppedWhileRunning)) throw err;
      done3.push({ type: "function_call_output", call_id: item.call_id, output: NOT_KNOWN });
      run.input = place(base, done3);
      throw err.error;
    }
    done3.push({ type: "function_call_output", call_id: item.call_id, output });
    run.input = place(base, done3);
  }
}
async function outputOf(call, handlers, signal) {
  const handler = handlerOf(handlers, call.name);
  if (!handler) return NO_TOOL;
  if (!parses(call.arguments)) return BAD_ARGUMENTS;
  const args = JSON.parse(call.arguments || "{}");
  const ran = Promise.resolve().then(() => handler(args, call)).catch((error) => {
    throw new HandlerError(error, call);
  });
  let result;
  try {
    result = await raceAbort(ran, signal);
  } catch (err) {
    if (err instanceof HandlerError || !signal?.aborted) throw err;
    const ended = await Promise.race([ran.then((value) => ({ value }), () => void 0), new Promise((resolve) => setTimeout(resolve, 0))]);
    if (!ended) throw new StoppedWhileRunning(err);
    result = ended.value;
  }
  if (typeof result === "string") return result;
  if (result === void 0) return "null";
  try {
    const text = JSON.stringify(result);
    if (text !== void 0) return text;
  } catch {
  }
  console.warn(`Kapai: the handler of the tool ${call.name} returned a result that is not JSON, such as a BigInt, a Symbol, or a cycle. runTools sent an error output for call ${call.callId}.`);
  return NOT_JSON;
}

// src/internal/systemone.ts
var SYSTEMONE_TIMEOUT_MS = 15e4;
var MAX_QUESTIONS = 32;
var MAX_FIELDS = 64;
var systemOneNeedsIncludedAI = () => new KapaiError("included_ai_only", "Decisions and extraction work only with the included AI. Switch to the included AI.", 0);
var invalid2 = (message) => new KapaiError("invalid_request", message, 0);
var DATA_URL = /^data:(?:[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*)?(?:;[a-z0-9!#$&^_.+=-]+)*,/i;
function isDataUrl(value) {
  return DATA_URL.test(value.slice(0, 200).replace(/^[\s\u0085\uFEFF\u200B]+/, ""));
}
var MAX_STATE_IMAGES = 1;
var STATE_IMAGES = "A decision takes one state image.";
var MISPLACED_DATA_URL = "A data URL goes only in images, documents, or an image option.";
function mediaPlaces(body) {
  const places = [];
  let misplaced = null;
  const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const plain = (value, path) => {
    if (typeof value === "string") {
      if (isDataUrl(value)) misplaced ??= path.join(".");
    } else if (Array.isArray(value)) value.forEach((item, at) => plain(item, [...path, String(at)]));
    else if (isObject(value)) for (const [key, member] of Object.entries(value)) plain(member, [...path, key]);
  };
  const option = (value, path) => {
    if (!isObject(value) || typeof value.image !== "string") return false;
    if (!Object.entries(value).every(([key, member]) => (key === "image" || key === "text") && typeof member === "string")) return false;
    places.push({ path: [...path, "image"].join("."), value: value.image, kind: "image" });
    if (value.text !== void 0) plain(value.text, [...path, "text"]);
    return true;
  };
  const instructions = (value, path) => {
    if (option(value, path)) return;
    if (Array.isArray(value)) value.forEach((item, at) => instructions(item, [...path, String(at)]));
    else if (isObject(value)) for (const [key, member] of Object.entries(value)) instructions(member, [...path, key]);
    else plain(value, path);
  };
  const question = (value, path) => {
    if (!isObject(value)) return plain(value, path);
    const options = value.type === "choice" || value.type === "noul";
    for (const [key, member] of Object.entries(value)) {
      const at = [...path, key];
      if (key === "instructions") instructions(member, at);
      else if (key === "criteria" && options && isObject(member)) {
        for (const [name, criterion] of Object.entries(member)) if (!option(criterion, [...at, name])) plain(criterion, [...at, name]);
      } else plain(member, at);
    }
  };
  for (const [key, value] of Object.entries(body)) {
    if (key === "images" || key === "documents") {
      if (Array.isArray(value))
        value.forEach((item, at) => {
          if (typeof item === "string") places.push({ path: `${key}.${at}`, value: item, kind: key === "images" ? "image" : "document" });
        });
    } else if (key === "questions" && isObject(value)) for (const [name, item] of Object.entries(value)) question(item, ["questions", name]);
    else plain(value, [key]);
  }
  return { places, misplaced };
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
  const { places, misplaced } = mediaPlaces(body);
  if (misplaced !== null) throw new KapaiError("invalid_request", MISPLACED_DATA_URL, 0, { issues: [{ path: misplaced, message: MISPLACED_DATA_URL }] });
  if (shape === "questions" && body.documents !== void 0) {
    const message = "Decisions do not take PDF documents. Send the document to an extraction, or send its pages as images.";
    throw new KapaiError("modality_not_supported", message, 0, { modality: "document" });
  }
  const { images } = body;
  if (shape === "questions" && Array.isArray(images) && images.length > MAX_STATE_IMAGES) {
    throw new KapaiError("invalid_request", STATE_IMAGES, 0, { issues: [{ path: "images", message: STATE_IMAGES }] });
  }
  checkPlaces(places);
  const issue2 = shape === "fields" ? fieldIssue(map) : null;
  if (issue2) throw new KapaiError("invalid_request", issue2.message, 0, { issues: [issue2] });
  return body;
}
var FIELD_TYPES = ["text", "number", "date", "time", "datetime", "duration", "boolean", "enum", "object", "list", "compute", "estimate", "forecast"];
function fieldIssue(fields) {
  for (const [name, value] of Object.entries(fields)) {
    const spec = typeof value === "object" && value !== null ? value : {};
    const missing = (member, message) => spec[member] === void 0 ? { path: `fields.${name}.${member}`, message } : null;
    let issue2 = null;
    if (spec.type === "list") {
      issue2 = missing("items", "A list needs items: the type of each item, such as text.");
      if (!issue2 && (typeof spec.items !== "string" || spec.items === "boolean" || !FIELD_TYPES.includes(spec.items))) {
        issue2 = { path: `fields.${name}.items`, message: "items must be the type of each item as a text, other than boolean, such as text, number, or date." };
      }
    } else if (spec.type === "enum") issue2 = missing("enum", "An enum needs enum: the list of its values.");
    else if (spec.type === "object") issue2 = missing("properties", "An object needs properties: the field spec of each member.");
    else if (spec.type === "estimate") issue2 = missing("min", "An estimate needs min and max.") ?? missing("max", "An estimate needs min and max.");
    if (issue2) return issue2;
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
  const imageTokens = mediaItems(body) * MEDIA_ITEM_TOKENS;
  const each = (map, answer) => Object.fromEntries(Object.entries(map).map(([key, value]) => [key, answer(value)]));
  if (fields) {
    const answers2 = each(fields, (spec) => {
      const value = sample(spec);
      return { type: spec.type, value, valid: true, complete: true, confidence: 0, p_null: value === null ? 1 : 0 };
    });
    const usage = { state_tokens: 0, image_tokens: imageTokens, schema_tokens: 0, input_tokens: imageTokens, output_tokens: 0, passes: 0 };
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
  return { answers, model: model ?? "djev", usage: { input_tokens: imageTokens, output_tokens: 0, ...imageTokens > 0 ? { image_tokens: imageTokens } : {} } };
}
var MEDIA_ITEM_TOKENS = 1550;
function mediaItems(value) {
  if (typeof value === "string") return isDataUrl(value) ? 1 : 0;
  if (typeof value !== "object" || value === null) return 0;
  return Object.values(value).reduce((sum, member) => sum + mediaItems(member), 0);
}

// src/own-ai/messages.ts
function textOf(content) {
  return typeof content === "string" ? content : content.filter((part) => part.type === "input_text" || part.type === "output_text").map((part) => part.text).join("\n");
}
var isMediaPart = (part) => part.type === "input_image" || part.type === "input_file";
function mediaOf(input) {
  const kinds = /* @__PURE__ */ new Set();
  if (typeof input === "string") return [];
  for (const item of input) {
    if (!isMessage(item) || typeof item.content === "string") continue;
    for (const part of item.content) if (isMediaPart(part)) kinds.add(part.type === "input_image" ? "image" : "document");
  }
  return [...kinds];
}
function toOpenAIContent(content) {
  if (typeof content === "string" || !content.some(isMediaPart)) return textOf(content);
  return content.map(
    (part) => part.type === "input_image" ? { type: "image_url", image_url: { url: part.image_url } } : part.type === "input_file" ? { type: "file", file: { file_data: part.file_data, ...part.filename !== void 0 ? { filename: part.filename } : {} } } : { type: "text", text: part.text }
  );
}
function sourceOf(url) {
  const comma = url.indexOf(",");
  return { type: "base64", media_type: url.slice("data:".length, url.indexOf(";")).toLowerCase(), data: url.slice(comma + 1) };
}
function toAnthropicContent(content) {
  if (typeof content === "string" || !content.some(isMediaPart)) return textOf(content);
  return content.map(
    (part) => part.type === "input_image" ? { type: "image", source: sourceOf(part.image_url) } : part.type === "input_file" ? { type: "document", source: sourceOf(part.file_data) } : { type: "text", text: part.text }
  );
}
var isMessage = (item) => item.type === void 0 || item.type === "message";
var messagesOf = (input) => input.filter(isMessage);
function toChatMessages(input, instructions, toContent = toOpenAIContent) {
  const messages = instructions ? [{ role: "system", content: instructions }] : [];
  if (typeof input === "string") return [...messages, { role: "user", content: input }];
  for (const message of messagesOf(input)) {
    if (message.role === "system" || message.role === "developer") messages.push({ role: "system", content: textOf(message.content) });
    else messages.push({ role: message.role, content: toContent(message.content) });
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
    else if (isMessage(item) && item.role === "assistant" && calls && messages.at(-1)?.content === null) {
      messages.at(-1).content = textOf(item.content);
      continue;
    } else if (isMessage(item)) {
      const content = item.role === "developer" || item.role === "system" ? textOf(item.content) : toOpenAIContent(item.content);
      messages.push({ role: item.role === "developer" ? "system" : item.role, content });
    } else continue;
    calls = void 0;
  }
  return messages;
}
function splitSystem(input, instructions, toContent = toOpenAIContent) {
  const all = toChatMessages(input, instructions, toContent);
  const system = all.flatMap((message) => message.role === "system" ? [message.content] : []);
  const messages = all.flatMap((message) => message.role === "system" ? [] : [message]);
  return { system: system.length > 0 ? system.join("\n\n") : void 0, messages };
}
var blocksOf = (content) => typeof content === "string" ? [{ type: "text", text: content }] : content;
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
    return splitSystem(input, instructions, toAnthropicContent);
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
      if (item.role === "system" || item.role === "developer") system.push(textOf(item.content));
      else {
        const content = toAnthropicContent(item.content);
        const last = messages.at(-1);
        if (item.role === "user" && last?.role === "user" && Array.isArray(last.content)) last.content.push(...blocksOf(content));
        else if (item.role === "assistant" && wasInRun && last?.role === "assistant" && Array.isArray(last.content)) {
          if (content !== "") last.content.push(...blocksOf(content));
          inRun = true;
        } else messages.push({ role: item.role, content });
      }
    }
  }
  return { ...system.length > 0 ? { system: system.join("\n\n") } : {}, messages };
}
function toPrompt(input) {
  if (typeof input === "string") return input;
  const turns = messagesOf(input).filter((m) => m.role === "user" || m.role === "assistant");
  if (turns.length === 1) return textOf(turns[0].content);
  return turns.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${textOf(m.content)}`).join("\n\n");
}

// src/own-ai/http.ts
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
async function postForStream(fetchFn, url, headers, body, kind, request) {
  const signal = request.signal;
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
    const text = mediaOf(request.input).length > 0 ? void 0 : await providerMessage(response);
    throw new OwnAIError("own_ai_failed", `Your AI provider returned HTTP ${response.status}${text ? `: ${text}` : "."}`, {
      kind,
      status: response.status,
      ...text ? { details: { providerMessage: text } } : {}
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
function mediaRefused(err, request) {
  if (!(err instanceof OwnAIError) || mediaOf(request.input).length === 0 || err.status === 0) return err;
  const later = (Array.isArray(request.input) ? request.input : []).some((item) => item.type === "function_call" || item.type === "function_call_output");
  const [code, message] = later || err.status !== 400 && err.status !== 422 ? ["own_ai_failed", `Your AI provider returned HTTP ${err.status}.`] : (request.tools?.length ?? 0) > 0 ? ["own_ai_failed", `Your AI provider refused the request (HTTP ${err.status}). It had tools and an image or a document, so the SDK cannot tell which one the provider refused.`] : [
    "own_ai_no_media",
    `Your AI provider refused the request with an image or a document (HTTP ${err.status}). The model may not take them. Choose a model that takes them, or switch to the included AI.`
  ];
  return new OwnAIError(code, message, { kind: err.kind, status: err.status });
}
var providerText = (request, text) => mediaOf(request.input).length > 0 ? void 0 : text;
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

// src/own-ai/anthropic.ts
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
    // A PDF waits for the SDK's page counter (Task 14b).
    media: ["image"],
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
        request
      ).catch((err) => {
        throw mediaRefused(toolsRefused(err, request), request);
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
          const message = providerText(request, event.error?.message ?? event.error?.type ?? "unknown error");
          throw new OwnAIError("own_ai_failed", `Anthropic failed${message ? `: ${message}` : "."}`, { kind: KIND });
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

// src/own-ai/openai-compatible.ts
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
  const media = Array.isArray(fields.media) && fields.media.includes("image") ? ["image"] : void 0;
  return {
    tools: true,
    ...media ? { media } : {},
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
        request
      ).catch((err) => {
        throw mediaRefused(toolsRefused(err, request), request);
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
          const message = providerText(request, typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? "Unknown error.");
          throw new OwnAIError("own_ai_failed", `Your AI provider failed${message ? `: ${message}` : "."}`, { kind: KIND2 });
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
      const ordered = cut ? [] : [...calls].sort(([a], [b]) => a - b).map(([, c]) => ({ ...c, arguments: c.arguments || "{}" }));
      if (ordered.some((call) => !call.name)) throw callWithNoName(KIND2);
      for (const call of ordered) yield { type: "tool_call", call };
      yield { type: "done", ...usage ? { usage } : {}, ...cut ? { incomplete: { reason: cut === "content_filter" ? "content_filter" : "max_output_tokens" } } : {} };
    }
  };
}

// src/own-ai/registry.ts
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

// src/storage-idb.ts
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

// src/internal/encoding.ts
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

// src/crypto/sha256.ts
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

// src/crypto/keys.ts
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

// src/storage.ts
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
      const database = await open();
      if (!database) return memory.create();
      const keys = await generateKeyPair(false);
      try {
        await done2(store(database, "readwrite").add({ publicKey: keys.publicKey, privateKey: keys.privateKey }, name));
        return keys;
      } catch (err) {
        const reason = err?.name;
        if (reason === "ConstraintError") {
          const first = await load();
          if (first) return first;
        }
        if (reason !== "DataCloneError") throw err;
        db = Promise.resolve(null);
        return memory.create();
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

// src/circuit.ts
var BASE_COOLDOWN_MS = 3e4;
var MAX_COOLDOWN_MS = 5 * 6e4;
var onlineEvents = 0;
if (typeof window !== "undefined") window.addEventListener("online", () => onlineEvents++);
var CircuitBreaker = class {
  constructor(now, onChange) {
    this.now = now;
    this.onChange = onChange;
  }
  now;
  onChange;
  until = null;
  nextCooldown = BASE_COOLDOWN_MS;
  onlineAtOutage = onlineEvents;
  retry = false;
  probe;
  /** True while the outage lasts: during the cooldown, and until the browser reports that it is online again. */
  isOpen() {
    return this.probe !== void 0 || this.until !== null && this.now() < this.until && this.onlineAtOutage === onlineEvents;
  }
  canRequest() {
    return !this.probe && (!this.isOpen() || this.retry || this.onlineAtOutage !== onlineEvents);
  }
  allowProbe() {
    if (this.isOpen() && !this.probe) this.retry = true;
  }
  /** Returns a probe token, undefined for a normal request, or null when the request must wait. */
  startRequest() {
    if (this.until === null) return void 0;
    if (!this.canRequest()) return null;
    this.retry = false;
    this.onlineAtOutage = onlineEvents;
    return this.probe = /* @__PURE__ */ Symbol();
  }
  releaseProbe(probe) {
    if (probe && this.probe === probe) {
      this.probe = void 0;
      this.retry = true;
    }
  }
  /** The time (ms) when the breaker lets calls through again, or null when it never opened. */
  openUntil() {
    return this.until;
  }
  recordOutage(probe) {
    const wasOpen = this.isOpen();
    if (probe ? this.probe !== probe : wasOpen) return;
    this.probe = void 0;
    this.retry = false;
    this.onlineAtOutage = onlineEvents;
    this.until = this.now() + this.nextCooldown;
    this.nextCooldown = Math.min(this.nextCooldown * 2, MAX_COOLDOWN_MS);
    this.onChange?.();
  }
  recordSuccess(probe) {
    if (probe ? this.probe === probe : !this.isOpen()) this.reset();
  }
  reset() {
    const hadOutage = this.until !== null;
    this.until = null;
    this.nextCooldown = BASE_COOLDOWN_MS;
    this.retry = false;
    this.probe = void 0;
    if (hadOutage) this.onChange?.();
  }
};

// src/internal/return.ts
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

// src/internal/runtime.ts
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
function nodeFetch() {
  const versions = globalThis.process?.versions;
  return detectPlatform().runtime === "node" && Boolean(versions?.undici) && !versions?.bun && !versions?.deno;
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

// src/crypto/pow.ts
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

// src/internal/session.ts
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

// src/internal/state.ts
var KEYS = ["install", "token", "clockOffset", "entitlement", "ownAI", "debugToken"];
var isWireV2 = (value) => Array.isArray(value?.products) && typeof value?.usage?.credits?.left === "number";
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
      const value = JSON.parse(raw);
      if (key === "entitlement" && !isWireV2(value?.value)) return;
      this.values[key] = value;
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

// src/source.ts
function selectSource(inputs) {
  if (inputs.policy !== void 0 && inputs.policy !== "off" && inputs.hasConfig && (inputs.circuitOpen || inputs.policy === "anytime" && inputs.prefersOwnAI)) return "own";
  return inputs.circuitOpen ? "unavailable" : "kapai";
}

// src/client.ts
var isSetupFault = (err) => err instanceof KapaiError && (err.code === "origin_not_allowed" || err.code === "invalid_publishable_key");
var DEFAULT_IDLE_TIMEOUT_MS = 6e4;
var ENTITLEMENT_MAX_AGE_MS = 6e4;
var MEDIA_SWITCH_RECHECK_MS = 5e3;
var CLAIM_WARNINGS = {
  debug_token_invalid: "Kapai: the debug token is not valid. It expired, was revoked, or belongs to another app. Create a new token in the dashboard.",
  test_device_limit: "Kapai: this app has its most test devices. Remove a test mark on the Devices page, or raise the limit on the Test devices page.",
  test_device_has_customer: "Kapai: this install has a purchase. A test device cannot have one. Claim the token on another install.",
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
function testStateChanged(before, now) {
  return before?.testDevice != null && now.testDevice?.state !== before.testDevice.state;
}
function limitLifted(refusal, now) {
  const { requestsToday, requestsPerDay } = now.usage;
  return refusal.reason === "daily_requests" && (requestsPerDay === null || (requestsToday ?? 0) < requestsPerDay);
}
function answerAdapter(respond, media) {
  let warned = false;
  return {
    tools: true,
    ...media ? { media } : {},
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
var ownAINoMedia = (kind) => new OwnAIError("own_ai_no_media", "Your own AI cannot take images or documents. Switch to the included AI, or choose an AI source that takes them.", { kind });
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
        yield { type: "done", text, source: "own", toolCalls, output: markIncomplete(output, event.incomplete), ...event.usage ? { usage: event.usage } : {}, ...event.incomplete ? { incomplete: event.incomplete } : {} };
        return;
      }
    }
  } catch (err) {
    if (err instanceof OwnAIError || request.signal?.aborted) throw err;
    if (mediaOf(request.input).length > 0) throw new OwnAIError("own_ai_failed", "Your own AI failed.", { kind: options.kind() });
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
    stream: (request) => this.run(request),
    /** Runs a tool loop: each round is one `respond`, and `handlers` run the calls of the model. 5 rounds by default. */
    runTools: (request, options) => runTools((round, kapaiOnly) => this.respond(round, kapaiOnly), request, options),
    /**
     * Sends one recording to speech to text and returns its text. Only the included AI transcribes.
     * It checks the size and the type before the upload.
     */
    transcribe: (audio, options) => this.transcribe(audio, options),
    /**
     * Asks typed questions about a state: `noul` (yes or no), `choice`, and `score`. Only the included AI decides.
     * Before the request, it checks the state, the number of questions, the media items, and a data URL at a place
     * that takes none. It refuses a `fields` member.
     */
    decide: async (request) => this.included("/v1/systemone", { method: "POST", body: JSON.stringify(systemOneBody("questions", request)) }, request.signal, SYSTEMONE_TIMEOUT_MS, systemOneNeedsIncludedAI),
    /**
     * Reads typed fields from a state, each with a confidence. Only the included AI extracts.
     * Before the request, it checks the state, the number of fields, the media items, and a data URL at a place that
     * takes none. It refuses a `questions` member.
     */
    extract: async (request) => this.included("/v1/systemone", { method: "POST", body: JSON.stringify(systemOneBody("fields", request)) }, request.signal, SYSTEMONE_TIMEOUT_MS, systemOneNeedsIncludedAI),
    /**
     * An image as a content part of a user message. A browser scales it to a long edge of 1,024 pixels at most and
     * sends a JPEG with no EXIF data. Node sends the bytes as they are, and refuses one above the limits.
     */
    imagePart: (input) => imagePart(input),
    /** A PDF document as a content part of a user message, at most 4 MiB. A `File` gives its name. */
    filePart: (input, filename) => filePart(input, filename),
    /**
     * The app's AI switches that are on, from the entitlement that the client holds (`app.capabilities`). Undefined
     * before the first entitlement read, or from an older server that does not send them.
     */
    capabilities: () => this.state.get("entitlement")?.value.app.capabilities
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
     * True when the known policy and Kapai's state let the user's own AI answer.
     * With an app-managed own AI, the app checks this before it sends a request to the user's service.
     */
    canUse: () => {
      const policy = this.state.get("entitlement")?.value.app.ownAIPolicy;
      if (policy === void 0 || policy === "off") return false;
      const managed = this.managedOwnAI?.state().state;
      const configured = managed === void 0 ? this.ownAI.get() !== null : managed !== "none" && managed !== "notSetUp";
      return configured && (policy === "anytime" || !this.breaker.canRequest() || this.setupFailed);
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
    connection: /* @__PURE__ */ new Set(),
    source: /* @__PURE__ */ new Set(),
    paywall: /* @__PURE__ */ new Set(),
    ownAI: /* @__PURE__ */ new Set(),
    limit: /* @__PURE__ */ new Set()
  };
  breaker;
  managedOwnAI;
  managedOwnAIView;
  /** The adapter of the app's `respond`, made at the first request. */
  appAdapter;
  setupFailed = false;
  noteSetupFault(err) {
    if (isSetupFault(err)) this.setupFailed = true;
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
      firstByteTimeoutMs: options.firstByteTimeoutMs ?? 2e4,
      trackUpload: !options.fetch && nodeFetch()
    };
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const clock = options.clock ?? Date.now;
    this.clock = clock;
    this.breaker = new CircuitBreaker(clock, () => this.emit("connection", this.connection()));
    this.openUrl = options.openUrl;
    this.showPage = options.showPage;
    this.appearance = options.appearance;
    this.managedOwnAI = options.ownAI;
    this.managedOwnAIView = this.managedOwnAI && this.routed(this.managedOwnAI);
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
   * It also clears when a fresh plan shows a larger allowance or requests left today, such as after the developer raised a limit.
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
    const policy = this.state.get("entitlement")?.value.app.ownAIPolicy;
    return selectSource({ policy, prefersOwnAI: this.prefersOwn(), hasConfig, circuitOpen: !this.breaker.canRequest() });
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
   * Reports the source that answers once the policy is known. With `respond`, the SDK routes each request.
   */
  routed(app) {
    return {
      state: () => {
        const own = app.state();
        if (own.state === "none" || own.state === "notSetUp") return own;
        const policy = this.state.get("entitlement")?.value.app.ownAIPolicy;
        if (policy === void 0) return { state: "available", label: own.label };
        if (!app.respond) return own;
        if (policy === "off") return { state: "none" };
        if (policy === "anytime" && this.prefersOwn()) return own.state === "invalid" ? own : { state: "active", label: own.label };
        if (!this.breaker.canRequest() || this.setupFailed) return { state: "fallback", label: own.label };
        return { state: "available", label: own.label };
      },
      setActive: app.setActive?.bind(app) ?? (app.respond ? (active) => this.ownAI.prefer(active) : void 0),
      openSettings: app.openSettings?.bind(app)
    };
  }
  /** @internal The state and actions that the elements use. */
  managedOwnAIForElements() {
    return this.managedOwnAIView;
  }
  /**
   * How the SDK reaches Kapai now: "unavailable" while Kapai is down (the SDK waits before it calls again), else
   * "online". The browser's own online state comes on top. The elements show it on the card.
   */
  connection() {
    return this.breaker.isOpen() ? "unavailable" : "online";
  }
  /** @internal Lets the next request probe Kapai after the user clicks Try again. */
  retryConnection() {
    this.breaker.allowProbe();
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
    const fresh = this.freshEntitlement();
    if (!options.refresh && fresh) return fresh;
    this.fetchingEntitlement ??= this.fetchEntitlement().finally(() => this.fetchingEntitlement = null);
    try {
      return await this.fetchingEntitlement;
    } catch (err) {
      this.noteSetupFault(err);
      const last = this.state.get("entitlement");
      if (last && err instanceof KapaiUnavailableError) return last.value;
      throw err;
    }
  }
  /** The cached entitlement when it is fresh. A pending debug token changes the plan, so its claim comes first. */
  freshEntitlement() {
    const cached = this.state.get("entitlement");
    return cached && !this.entitlementStale && !this.pendingDebug && this.clock() - cached.fetchedAt < ENTITLEMENT_MAX_AGE_MS ? cached.value : void 0;
  }
  /**
   * `app.capabilities` when a fresh entitlement has the media switch off, else undefined: then the SDK does not refuse,
   * and the server decides. A cached entitlement with the switch off that is older than `MEDIA_SWITCH_RECHECK_MS` is
   * read again first, so a switch that the developer turned on works at the next request. The own AI costs Kapai
   * nothing, so an outage skips the read.
   */
  async mediaSwitch(request) {
    const off = (entitlement) => {
      const capabilities = entitlement?.app.capabilities;
      return capabilities && !capabilities.includes("media") ? capabilities : void 0;
    };
    const cached = this.state.get("entitlement");
    if (!hasMedia(request) || !off(cached?.value)) return void 0;
    const recent = cached !== void 0 && this.clock() - cached.fetchedAt < MEDIA_SWITCH_RECHECK_MS;
    if (!recent && !this.breaker.isOpen()) await this.entitlement({ refresh: true }).catch(() => void 0);
    return off(this.freshEntitlement());
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
      this.setupFailed = false;
      if (generation !== this.session.generation) return value;
      await this.cacheEntitlement(value);
      if (this.limitNow && this.limitNow === limit) {
        if (purchaseOf(this.limitPlan, value) || limitLifted(this.limitNow, value) || testStateChanged(this.limitPlan, value)) this.setLimit(null);
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
   * With `product`, it skips the product list: use that for your own pricing UI.
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
   * The products that the app sells now, with their prices, for your own pricing UI.
   * Start the purchase of one with `kapai.upgrade({ product })`.
   */
  async products() {
    return (await this.entitlement()).products;
  }
  /** Opens the account page: change or cancel the plan, update the card, see invoices and devices. */
  manage(options = {}) {
    return this.paywall("manage", options);
  }
  /**
   * Opens the developer page of a test device: refill the starting credits, act as each test state, use the offline AI,
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
  /**
   * @internal One round of a tool loop that runs in another process (the Electron bridge). `kapaiOnly`: see `run`.
   */
  streamRound(request, kapaiOnly) {
    return this.run(request, kapaiOnly);
  }
  async respond(request, kapaiOnly = false) {
    for await (const event of this.run(request, kapaiOnly)) {
      if (event.type === "done") {
        const { type: _type, ...result } = event;
        return result;
      }
    }
    throw new KapaiError("no_answer", "The answer ended too early.");
  }
  /**
   * Picks the source (spec 6.3) and streams the answer.
   * With `kapaiOnly` (a later round of a tool loop with media, after a charged Kapai round), the request goes to Kapai
   * or fails: the own AI would get the image again, and the user would pay two providers (design 11).
   */
  async *run(request, kapaiOnly = false) {
    checkRequest(request, (name) => {
      if (this.memberWarned.has(name)) return;
      this.memberWarned.add(name);
      console.warn(memberWarning(name));
    });
    const { policy, own, choice } = await this.source();
    if (choice === "unavailable" || kapaiOnly && !this.breaker.canRequest()) throw this.circuitOpenError();
    checkMedia(request, await this.mediaSwitch(request));
    const media = mediaOf(request.input);
    const takesMedia = media.every((kind) => own?.media?.includes(kind) ?? false);
    const hasPlan = this.state.get("entitlement")?.value.app.ownAIPolicy !== void 0;
    const fallback = hasPlan && !kapaiOnly && own && (own.tools === true || !isToolRequest(request)) && takesMedia ? own : null;
    if (hasPlan && choice === "own" && !kapaiOnly) {
      if (!fallback) {
        if (!this.breaker.canRequest()) throw this.circuitOpenError();
        throw takesMedia ? ownAINoTools(this.ownAI.get()?.kind) : ownAINoMedia(this.ownAI.get()?.kind);
      }
      yield* this.streamOwn(fallback, request);
      return;
    }
    const probe = this.breaker.startRequest();
    if (probe === null) {
      if (fallback) {
        yield* this.streamOwn(fallback, request);
        return;
      }
      throw this.circuitOpenError();
    }
    let sent = false;
    let posted = false;
    try {
      const errorContext = { canUseOwnAI: policy === "anytime" && fallback !== null, upgrade: () => this.upgrade() };
      for await (const event of this.streamKapai(request, errorContext, probe, () => posted = true)) {
        if (event.type !== "done") sent = true;
        yield event;
      }
    } catch (err) {
      this.noteSetupFault(err);
      const backup = !sent && this.state.get("entitlement")?.value.app.ownAIPolicy !== void 0 ? fallback : null;
      if (isSetupFault(err) && backup) {
        this.breaker.recordSuccess(probe);
        yield* this.streamOwn(backup, request);
        return;
      }
      if (!(err instanceof KapaiUnavailableError)) {
        if (err instanceof KapaiError && err.status > 0) this.breaker.recordSuccess(probe);
        throw err;
      }
      if (uploadFailed(err)) throw err;
      if (err.code !== "registration_timeout") this.breaker.recordOutage(sent ? void 0 : probe);
      else this.breaker.releaseProbe(probe);
      const uncharged = !posted || err.code === "network_error" && !bodySentWhole(err) || err.status > 0 && err.code !== "unavailable";
      if (backup && (media.length === 0 || uncharged)) {
        yield* this.streamOwn(backup, request);
        return;
      }
      throw err;
    } finally {
      this.breaker.releaseProbe(probe);
    }
  }
  /** The source of the next AI request (spec 6.3), with the policy and the user's own AI that it used. */
  async source() {
    await this.state.ready;
    const adapter = this.ownAdapter();
    const prefersOwnAI = this.prefersOwn();
    const policy = await this.policy(prefersOwnAI && adapter !== null);
    const own = policy === void 0 || policy === "off" ? null : adapter;
    const choice = selectSource({ policy, prefersOwnAI, hasConfig: own !== null, circuitOpen: !this.breaker.canRequest() });
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
    if (choice === "own" && this.breaker.canRequest()) throw ownError();
    if (choice !== "kapai") throw this.circuitOpenError();
    const probe = this.breaker.startRequest();
    if (probe === null) throw this.circuitOpenError();
    let failure;
    try {
      const { response } = await this.authorized(path, init, signal, { upgrade: () => this.upgrade() }, timeoutMs);
      const result = await readJson(response);
      this.breaker.recordSuccess(probe);
      return result;
    } catch (err) {
      failure = err;
      this.noteSetupFault(err);
      if (serverDown(err)) this.breaker.recordOutage(probe);
      else if (err instanceof KapaiError && err.status > 0) this.breaker.recordSuccess(probe);
      throw err;
    } finally {
      this.breaker.releaseProbe(probe);
      this.syncAfterCall(failure);
    }
  }
  /** `onSend` runs before each POST of the request: from then on, Kapai can charge it. */
  async *streamKapai(request, errorContext, probe, onSend) {
    let first = true;
    let failure;
    try {
      const started = Date.now();
      const timeoutMs = this.http.firstByteTimeoutMs + (hasMedia(request) ? MEDIA_UPLOAD_TIMEOUT_MS : 0);
      const { response, controller } = await this.authorized("/v1/responses", { method: "POST", body: responsesBody(request) }, request.signal, errorContext, timeoutMs, onSend);
      const remaining = Math.max(0, timeoutMs - (Date.now() - started));
      for await (const event of readResponseStream(response.body, {
        firstEventTimeoutMs: remaining,
        idleTimeoutMs: this.idleTimeoutMs,
        controller,
        errorContext,
        ...request.signal ? { signal: request.signal } : {}
      })) {
        if (first) {
          first = false;
          this.breaker.recordSuccess(probe);
          this.setSource("kapai");
        }
        yield event.type === "done" ? { ...event, source: "kapai" } : event;
      }
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      this.syncAfterCall(failure);
    }
  }
  /**
   * Plan sync after a Kapai AI call. The plan can change on another device, on the account page, or when a payment fails.
   * A 402 can show a new plan. Then it refreshes also with no listener.
   * A 429 uses no quota, so the cache stays fresh. This prevents a refresh for each 429 while the install is rate limited.
   * Other calls can use quota, so the cached usage is out of date. Listeners get a refresh after these calls.
   * A successful answer also starts the first plan read for a client with its own AI.
   */
  syncAfterCall(failure) {
    if (failure instanceof QuotaExceededError) {
      this.setLimit({ reason: failure.reason, resetsAt: failure.resetsAt, message: failure.message, upgradeAvailable: failure.upgradeAvailable });
    } else if (!failure) this.setLimit(null);
    const cached = this.state.get("entitlement")?.value;
    const status = failure instanceof KapaiError ? failure.status : void 0;
    const planChanged = cached !== void 0 && status === 402;
    if (status === 429 && !planChanged) return;
    this.markEntitlementStale();
    const needsOwnAIPolicy = !failure && cached === void 0 && (this.ownAI.get() !== null || this.managedOwnAI !== void 0);
    this.refreshEntitlementSoon(planChanged || needsOwnAIPolicy);
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
  /** The app's own-AI policy from the cached entitlement. */
  async policy(needed) {
    const entry = this.state.get("entitlement");
    if (!entry && needed && !this.breaker.isOpen()) await this.entitlement().catch(() => void 0);
    else if (entry && needed && !this.breaker.isOpen() && this.clock() - entry.fetchedAt >= ENTITLEMENT_MAX_AGE_MS) this.refreshEntitlementSoon(true);
    return this.state.get("entitlement")?.value.app.ownAIPolicy;
  }
  ownAdapter() {
    const app = this.managedOwnAI;
    if (app) {
      const respond = app.respond;
      const state = this.managedOwnAIView.state().state;
      return respond && state !== "none" && state !== "notSetUp" ? this.appAdapter ??= answerAdapter(respond.bind(app), app.media) : null;
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
      if (!this.state.get("entitlement")) await this.entitlement();
      if (this.state.get("entitlement")?.value.app.ownAIPolicy === void 0) {
        throw new OwnAIError("own_ai_failed", "Load the plan before testing your own AI.");
      }
      const adapter = createOwnAIAdapter(config, { fetch: this.http.fetch });
      let text = "";
      for await (const event of this.streamOwn(adapter, { input: "Reply with the word OK." }, false)) {
        if (event.type === "done") text = event.text;
      }
      return { ok: true, text };
    } catch (err) {
      if (err instanceof KapaiError && !(err instanceof OwnAIError)) {
        return { ok: false, error: new OwnAIError(err.code, err.message, { status: err.status, details: err.details }) };
      }
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
  async authorized(path, init, signal, errorContext = {}, timeoutMs = this.http.firstByteTimeoutMs, onSend) {
    await this.claimPending(signal);
    return this.request(path, init, signal, errorContext, timeoutMs, onSend);
  }
  /**
   * Sends an authorized request. It gets a new token once on `token_expired` or `invalid_token`,
   * and registers a new install once on `install_unknown`. A revoked install (`install_revoked`) is final.
   * `timeoutMs` replaces `firstByteTimeoutMs` for this request. `onSend` runs before each send of the request.
   */
  async request(path, init, signal, errorContext = {}, timeoutMs = this.http.firstByteTimeoutMs, onSend) {
    let reauthenticated = false;
    let reregistered = false;
    for (; ; ) {
      const token = await this.session.accessToken(signal);
      const installId = this.session.installId();
      const headers = init.body instanceof FormData ? { authorization: `Bearer ${token}` } : jsonHeaders(token);
      onSend?.();
      const sent = await send({ ...this.http, firstByteTimeoutMs: timeoutMs }, path, { ...init, headers }, signal);
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

// src/mock.ts
var MOCK_STATES = [
  "loading",
  "new",
  "near-limit",
  "daily-limit",
  "low-credits",
  "out-of-credits",
  "member",
  "member-ending",
  "past-due",
  "on-hold",
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
var DEFAULT_INPUTS = ["text", "image"];
var OFF = {
  transcriptions: "Speech to text is off for this app. The developer turns it on in the dashboard, in the app's Settings, after Kapai turns it on for the developer.",
  decisions: "Decisions are off for this app. The developer turns them on in the dashboard, in the app's Settings, after Kapai turns them on for the developer.",
  extractions: "Extraction is off for this app. The developer turns it on in the dashboard, in the app's Settings, after Kapai turns it on for the developer.",
  tools: "Tool calls are off for this app. The developer turns them on in the dashboard, in the app's Settings, after Kapai turns them on for the developer.",
  media: MEDIA_OFF
};
var CAPABILITIES = Object.keys(OFF);
var BOTH_OFF = "Decisions and extraction are off for this app. The developer turns them on in the dashboard, in the app's Settings, after Kapai turns them on for the developer.";
var APP_MODEL = { id: "glm-5.3-flash", label: "GLM 5.3 Flash" };
var modalityOf = (type) => type === "input_image" ? "image" : type === "input_file" ? "document" : type === "input_audio" ? "audio" : type === "input_video" ? "video" : void 0;
function* partsOf(request) {
  for (const item of Array.isArray(request.input) ? request.input : []) {
    const message = item;
    if (message.type !== void 0 && message.type !== "message" || !Array.isArray(message.content)) continue;
    yield* message.content;
  }
}
function tokensIn(text) {
  let ascii3 = 0;
  let other = 0;
  for (const character of text) if (character.charCodeAt(0) < 128) ascii3 += 1;
  else other += 1;
  return Math.ceil(ascii3 / 4) + other;
}
function estimateInputTokens(request) {
  const text = (value) => tokensIn(typeof value === "string" ? value : "");
  let tokens = text(request.instructions);
  if (request.textFormat !== void 0) tokens += tokensIn(JSON.stringify(request.textFormat));
  if (request.tools?.length) tokens += tokensIn(JSON.stringify(request.tools.map((tool) => ({ type: "function", ...tool }))));
  if (typeof request.input === "string") return tokens + tokensIn(request.input);
  for (const item of request.input) {
    tokens += 4;
    const { type, content, name, arguments: args, output } = item;
    if (type === "function_call") tokens += text(name) + text(args);
    else if (type === "function_call_output") tokens += text(output);
    else if (typeof content === "string") tokens += tokensIn(content);
    else for (const part of Array.isArray(content) ? content : []) tokens += modalityOf(part?.type) ? MEDIA_ITEM_TOKENS : text(part?.text);
  }
  return tokens;
}
function mediaRefusal(request, limits, inputs = DEFAULT_INPUTS) {
  const modalities = [];
  for (const part of partsOf(request)) {
    const modality = modalityOf(part?.type);
    if (modality !== void 0 && !modalities.includes(modality)) modalities.push(modality);
  }
  if (modalities.length === 0) return void 0;
  for (const modality of modalities) {
    if (modality === "audio") return new KapaiError("modality_not_supported", "No Kapai AI model takes audio in a request. Send a recording to speech to text (/v1/transcriptions).", 400, { modality });
    if (modality === "video") return new KapaiError("modality_not_supported", "No Kapai AI model takes video.", 400, { modality });
    if (!inputs.includes(modality)) {
      const what = modality === "image" ? "images" : "PDF documents";
      const message = `${APP_MODEL.label}, the model that answers for this app, does not take ${what}. Send the request without them, or choose a model that takes them in the app's Settings.`;
      return new KapaiError("modality_not_supported", message, 400, { modality, model: APP_MODEL.id });
    }
  }
  if (limits === void 0) return void 0;
  const limit = isToolRequest(request) ? limits.toolsMaxInputTokens ?? limits.maxInputTokens : limits.maxInputTokens;
  if (estimateInputTokens(request) <= limit) return void 0;
  return new KapaiError("input_too_large", "The input is too long for this plan.", 413, { maxInputTokens: limit });
}
var DAY = 864e5;
var REQUEST_CREDITS = 5;
var PRODUCTS = [
  { id: "topup_s", amountCents: 750, credits: 3e4, interval: null },
  { id: "topup_m", amountCents: 1500, credits: 66e3, interval: null },
  { id: "topup_l", amountCents: 3750, credits: 18e4, interval: null },
  { id: "membership", amountCents: 1800, credits: 1e5, interval: "month" }
];
var TOPUPS = PRODUCTS.filter((p) => p.interval === null);
var PAID_LIMITS = { maxInputTokens: 64e3, toolsMaxInputTokens: 64e3, maxOutputTokens: 4096 };
function mockEntitlement(state, options = {}) {
  const now = options.now ?? Date.now();
  const at = (days) => new Date(now + days * DAY).toISOString();
  const tomorrow = new Date(now + DAY);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const fresh = (left, requestsToday) => ({
    credits: { left, used: 600 - left, allowance: 600, resetsAt: null },
    requestsToday,
    requestsPerDay: 15,
    requestsResetAt: tomorrow.toISOString()
  });
  const customer = (left, allowance, membership2 = null) => ({
    customer: { email: "you@example.com" },
    limits: PAID_LIMITS,
    usage: { credits: { left, used: allowance - left, allowance, resetsAt: membership2?.renewsAt ?? null }, requestsToday: null, requestsPerDay: null, requestsResetAt: null },
    membership: membership2,
    products: membership2 && membership2.status !== "canceled" ? TOPUPS : PRODUCTS
  });
  const membership = (fields = {}) => ({
    status: "active",
    creditsPerMonth: 1e5,
    renewsAt: at(20),
    endsAt: null,
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
    ...fields
  });
  const states2 = {
    "near-limit": { usage: fresh(540, 12) },
    "daily-limit": { usage: fresh(525, 15) },
    "low-credits": customer(2400, 30600),
    "out-of-credits": { usage: fresh(0, 3) },
    member: customer(64e3, 100600, membership()),
    "member-ending": customer(64e3, 100600, membership({ renewsAt: null, endsAt: at(12), cancelAtPeriodEnd: true })),
    "past-due": customer(64e3, 100600, membership({ status: "past_due", renewsAt: null, endsAt: at(5), graceEndsAt: at(5) })),
    "on-hold": customer(1200, 30600, membership({ status: "past_due", renewsAt: null, endsAt: at(-3), graceEndsAt: at(-3) })),
    "nothing-for-sale": { products: [] }
  };
  if (state === "loading" || state === "setup-failed" || state === "revoked" || state === "suspended") return void 0;
  return {
    installId: "ins_mock",
    usage: fresh(570, 1),
    limits: { maxInputTokens: 8e3, toolsMaxInputTokens: 16e3, maxOutputTokens: 1024 },
    app: {
      id: "app_mock",
      slug: "mock",
      name: options.appName ?? "My App",
      branding: { primaryColor: options.primaryColor ?? "#2563eb", logoUrl: null },
      ownAIPolicy: options.ownAIPolicy ?? "outage_only",
      capabilities: CAPABILITIES.filter((capability) => !options.off?.includes(capability)),
      inputs: options.inputs ?? DEFAULT_INPUTS
    },
    customer: null,
    membership: null,
    products: PRODUCTS,
    ...states2[state],
    ...options.testDevice !== void 0 ? { testDevice: options.testDevice } : {}
  };
}
function today(usage) {
  const { requestsToday, requestsResetAt } = usage;
  const resetAt = requestsResetAt === null ? NaN : Date.parse(requestsResetAt);
  if (requestsToday === null || !(resetAt <= Date.now())) return { requestsToday, requestsResetAt };
  const days = Math.floor((Date.now() - resetAt) / DAY) + 1;
  return { requestsToday: 0, requestsResetAt: new Date(resetAt + days * DAY).toISOString() };
}
function mockKapai(state, options = {}) {
  let entitlement = options.noPlan && (state === "offline" || state === "service-down") ? void 0 : mockEntitlement(state, options);
  let config = null;
  let preferred = false;
  const appKey = options.ownAI ?? (state === "own-key" ? KapaiOwnAI.fixed({ state: "active", label: "api.openai.com" }) : void 0);
  let keyPreferred = true;
  const ownKey = appKey ? {
    ...appKey,
    state: () => {
      const own = appKey.state();
      if (own.state === "none" || own.state === "notSetUp") return own;
      const policy = entitlement?.app.ownAIPolicy;
      if (policy === void 0) return { state: "available", label: own.label };
      if (!appKey.respond) return own;
      if (policy === "off") return { state: "none" };
      if (policy === "anytime" && (appKey.isActive ? appKey.isActive() : keyPreferred)) return own.state === "invalid" ? own : { state: "active", label: own.label };
      return current === "offline" || current === "service-down" ? { state: "fallback", label: own.label } : { state: "available", label: own.label };
    },
    ...appKey.respond && !appKey.setActive ? { setActive: (active) => (keyPreferred = active, ownAIChanged()) } : {}
  } : void 0;
  const listeners = { entitlement: /* @__PURE__ */ new Set(), connection: /* @__PURE__ */ new Set(), source: /* @__PURE__ */ new Set(), paywall: /* @__PURE__ */ new Set(), ownAI: /* @__PURE__ */ new Set(), limit: /* @__PURE__ */ new Set() };
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
  let current = state;
  const refusal = () => {
    switch (current) {
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
      default:
        return quota();
    }
  };
  const quota = () => {
    if (!entitlement) return null;
    const { customer, products } = entitlement;
    const usage = { ...entitlement.usage, ...today(entitlement.usage) };
    const details = { resetsAt: usage.requestsResetAt, upgradeAvailable: products.length > 0 };
    if (!customer && usage.requestsPerDay !== null && (usage.requestsToday ?? 0) >= usage.requestsPerDay) {
      return new QuotaExceededError("quota_exceeded", "Today's limit is reached.", 402, { ...details, reason: "daily_requests" });
    }
    if (usage.credits.left < REQUEST_CREDITS) return new QuotaExceededError("quota_exceeded", "Not enough credits.", 402, { ...details, resetsAt: usage.credits.resetsAt, reason: "insufficient_credits" });
    return null;
  };
  const spend = () => {
    if (!entitlement) return;
    const { credits } = entitlement.usage;
    const day = today(entitlement.usage);
    const requestsToday = day.requestsToday === null ? null : day.requestsToday + 1;
    const usage = { ...entitlement.usage, ...day, credits: { ...credits, left: credits.left - REQUEST_CREDITS, used: credits.used + REQUEST_CREDITS }, requestsToday };
    entitlement = { ...entitlement, usage };
    emit("entitlement", entitlement);
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
  const systemOneMediaRefusal = (body) => {
    if (mediaItems(body) === 0) return null;
    if (options.off?.includes("media")) return new KapaiError("capability_off", OFF.media, 403, { capability: "media" });
    if (!Array.isArray(body.documents) || body.documents.length === 0) return null;
    const model = body.model ?? "clairic-flash";
    const label2 = model === "clairic-flash" ? "Clairic Flash" : model;
    const message = `${label2}, the model of this request, does not take PDF documents. Send the request without them, or choose a model that takes them.`;
    return new KapaiError("modality_not_supported", message, 400, { modality: "document", model });
  };
  const systemOne = async (shape, request) => {
    const body = systemOneBody(shape, request);
    const own = ownKey?.state().state;
    if (own === "active" || own === "invalid") throw systemOneNeedsIncludedAI();
    throwIfAborted(request.signal);
    const capability = shape === "questions" ? "decisions" : "extractions";
    const error = (options.off?.includes(capability) ? featureRefusal(capability) : null) ?? systemOneMediaRefusal(body) ?? refusal();
    syncLimit(error);
    if (error) throw error;
    return offlineAnswer(body);
  };
  let keyAdapter;
  let calls = 0;
  async function* stream(request) {
    checkRequest(request, () => {
    });
    checkMedia(request, entitlement?.app.capabilities);
    throwIfAborted(request.signal);
    const respond2 = answeringKey();
    if (respond2) {
      yield* streamOwnAI(keyAdapter ??= answerAdapter(respond2), request, { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, kind: () => void 0, onFirst: () => setSource("own"), onDone: () => setLimit(null) });
      return;
    }
    let failure;
    try {
      const off = isToolRequest(request) && options.off?.includes("tools") ? featureRefusal("tools") : null;
      if (off) throw off;
      const media = mediaRefusal(request, entitlement?.limits, entitlement?.app.inputs);
      if (media) throw media;
      const error = refusal();
      if (error) throw error;
      const last = typeof request.input === "string" ? void 0 : request.input.at(-1);
      const tool = request.tools?.length ? typeof request.toolChoice === "object" ? request.toolChoice.name : request.tools[0].name : void 0;
      if (tool && request.toolChoice !== "none" && last?.type !== "function_call_output") {
        const call = { callId: `call_mock_${++calls}`, name: tool, arguments: "{}" };
        setSource("kapai");
        yield { type: "tool_call", call };
        throwIfAborted(request.signal);
        const item = { type: "function_call", call_id: call.callId, name: tool, arguments: "{}", id: `fc_mock_${calls}`, status: "completed" };
        spend();
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
      spend();
      yield { type: "done", text, source: "kapai", toolCalls: [], output: [outputMessage("msg_mock", text)] };
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      syncLimit(failure);
    }
  }
  const buy = (e, product) => {
    const { credits } = e.usage;
    const member = product.id === "membership";
    const month = mockEntitlement("member", options);
    return {
      ...e,
      customer: e.customer ?? { email: "you@example.com" },
      limits: PAID_LIMITS,
      usage: {
        credits: { ...credits, left: credits.left + product.credits, allowance: credits.allowance + product.credits, resetsAt: member ? month.usage.credits.resetsAt : credits.resetsAt },
        requestsToday: null,
        requestsPerDay: null,
        requestsResetAt: null
      },
      ...member ? { membership: month.membership, products: e.products.filter((p) => p.id !== "membership") } : {}
    };
  };
  const page = (mode) => async (pageOptions = {}) => {
    if (!entitlement) throw refusal() ?? new KapaiUnavailableError("unavailable", "Kapai is not available.", 0);
    emit("paywall", { type: "opened", mode });
    const product = entitlement.products.find((p) => p.id === (pageOptions.product ?? "membership")) ?? entitlement.products[0];
    if (mode === "upgrade" && product) {
      entitlement = buy(entitlement, product);
      current = null;
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
      extract: (request) => systemOne("fields", request),
      imagePart,
      filePart,
      capabilities: () => entitlement?.app.capabilities
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
      canUse: () => entitlement !== void 0 && entitlement.app.ownAIPolicy !== "off" && (Boolean(ownKey) || config !== null)
    },
    entitlement: async () => {
      if (state === "loading") return new Promise(() => void 0);
      if (!entitlement) throw refusal();
      return entitlement;
    },
    products: async () => entitlement?.products ?? [],
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

export {
  TRANSCRIBE_TIMEOUT_MS,
  audioForm,
  readLines,
  imagePart,
  filePart,
  toolRunState,
  runTools,
  SYSTEMONE_TIMEOUT_MS,
  splitSystem,
  toPrompt,
  registerOwnAIAdapter,
  ownAIKinds,
  indexedDbStorage,
  memoryStorage,
  webStorage,
  memoryKeyStore,
  indexedDbKeyStore,
  Kapai,
  MOCK_STATES,
  mockEntitlement,
  mockKapai
};
