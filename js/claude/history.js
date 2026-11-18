/*
 * The conversation as the Messages API accepts it. The API refuses a request (400) whose messages include an
 * assistant message with empty content or a text block with no non-whitespace text, a tool_use without its
 * tool_result in the next message, or a tool_result without its tool_use in the one before - and once such a
 * message is in the history, every later request of the chat would be refused the same way. The ChatSession does
 * not record an empty reply (a turn of tool calls only, a refusal), but the backend still sends every request
 * through apiMessages, so a history that is wrong by any route cannot wedge the chat.
 *
 *   apiMessages(messages) -> a new array (the input is not changed):
 *     - blank text (a string content, or a text block) is dropped, and a message left with nothing is dropped;
 *     - a tool_use whose id has no tool_result in the next message is dropped, and so is a tool_result whose id
 *       had no tool_use in the message before (after the tool_use pass);
 *     - consecutive messages of the same role are joined into one (the API would join them anyway; joined, the
 *       pairing above stays checkable message by message), and in a user message the tool_result blocks come
 *       first (the API refuses text before them);
 *     - the conversation starts with a user message that answers no tool_use (a leading assistant message, and
 *       the tool_results of a user message left first, are dropped);
 *   these passes repeat until nothing changes. What is left is checked (apiShapeProblem); a conversation that
 *   still is not one the API accepts - nothing left, or no question at the end (the last user message was blank)
 *   - is never sent: apiMessages throws an Error with code 'bad-history', which the turn reports.
 *   A block is kept only where the API takes it: a user message holds text, image, document, search_result and
 *   tool_result blocks (anything else in it is dropped); an assistant message holds what the model sent (text,
 *   thinking, tool_use and the server tools' blocks, passed back as they came), never a user-only block. A block
 *   with no type is dropped, as are a tool_use without a string id or repeating an id in its message, and a
 *   tool_result without a string tool_use_id or answering an id already answered in its message.
 *   A thinking block is kept as it came: it carries the signature the API checks.
 */
const USER_ONLY = new Set(['image', 'document', 'search_result', 'tool_result']);
const USER_BLOCKS = new Set(['text', ...USER_ONLY]);
const fits = (role, b) => typeof b.type === 'string' && (role === 'user' ? USER_BLOCKS.has(b.type) : !USER_ONLY.has(b.type));
const isId = (v) => typeof v === 'string' && v.length > 0;
const blank = (s) => typeof s !== 'string' || !s.trim();
const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
const isThinking = (b) => b.type === 'thinking' || b.type === 'redacted_thinking';
const ids = (m, type, key) => new Set(typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === type).map((b) => b[key]));

export function apiMessages(messages) {
  // blank text out, empty messages out
  let list = [];
  for (const m of messages || []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (typeof m.content === 'string') { if (!blank(m.content)) list.push({ role: m.role, content: m.content }); continue; }
    const content = blocksOf(m.content).filter((b) => b && typeof b === 'object' && fits(m.role, b) && !(b.type === 'text' && blank(b.text))
      && !(b.type === 'tool_use' && !isId(b.id)) && !(b.type === 'tool_result' && !isId(b.tool_use_id)));
    if (content.length) list.push({ role: m.role, content });
  }
  // a tool_use id once in its message (a later one with the same id is dropped)
  for (const m of list) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const used = new Set();
    m.content = m.content.filter((b) => b.type !== 'tool_use' || (!used.has(b.id) && used.add(b.id)));
  }
  // each pass can expose more to drop (a message emptied, two of one role brought together), so until it settles
  for (let pass = 0, before = null; pass < 64; pass++) {
    const now = JSON.stringify(list);
    if (now === before) break;
    before = now;
    list = tidy(list);
  }
  const problem = apiShapeProblem(list);
  if (problem) throw Object.assign(new Error(`The conversation could not be sent (${problem}).`), { code: 'bad-history' });
  return list;
}

function tidy(list) {
  // join runs of one role, so a tool_use and its tool_result are in neighbouring messages
  list = join(list);
  // tool_use needs its tool_result in the next message; then tool_result needs its tool_use in the one before
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const answered = list[i + 1] && list[i + 1].role === 'user' ? ids(list[i + 1], 'tool_result', 'tool_use_id') : new Set();
    m.content = m.content.filter((b) => b.type !== 'tool_use' || answered.has(b.id));
  }
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    const asked = i > 0 && list[i - 1].role === 'assistant' ? ids(list[i - 1], 'tool_use', 'id') : new Set();
    const answered = new Set();
    m.content = m.content.filter((b) => b.type !== 'tool_result' || (asked.has(b.tool_use_id) && !answered.has(b.tool_use_id) && answered.add(b.tool_use_id)));
  }
  // a message left with nothing, or an assistant message left with only thinking (its tool_use gone), says nothing
  list = list.filter((m) => typeof m.content === 'string' || m.content.some((b) => !isThinking(b)));
  list = join(list).map((m) => (m.role === 'user' ? { role: 'user', content: resultsFirst(m.content) } : m));
  // the conversation opens with the person's question
  while (list.length && list[0].role !== 'user') list.shift();
  return list;
}

function join(list) {
  const out = [];
  for (const m of list) {
    const last = out[out.length - 1];
    if (!last || last.role !== m.role) { out.push(m); continue; }
    if (typeof last.content === 'string' && typeof m.content === 'string') last.content = `${last.content}\n\n${m.content}`;
    else last.content = [...blocksOf(last.content), ...blocksOf(m.content)];
  }
  return out;
}
// a user message's tool_result blocks before anything else in it (the order otherwise kept)
function resultsFirst(content) {
  if (typeof content === 'string') return content;
  return [...content.filter((b) => b.type === 'tool_result'), ...content.filter((b) => b.type !== 'tool_result')];
}

// what the Messages API would refuse in this conversation (a message for the error), or null: none at all, not
// starting with the person's question or ending without one, blank text, an empty message, a tool_use not answered
// in the next message, a tool_result not asked in the one before or after other content
export function apiShapeProblem(list) {
  if (!Array.isArray(list) || !list.length) return 'no messages';
  if (list[0].role !== 'user') return 'it does not start with a question';
  if (list[list.length - 1].role !== 'user') return 'it does not end with a question';
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role !== 'user' && m.role !== 'assistant') return `message ${i} has role ${m.role}`;
    if (i && list[i - 1].role === m.role) return `messages ${i - 1} and ${i} have the same role`;
    if (typeof m.content === 'string') { if (blank(m.content)) return `message ${i} is blank`; continue; }
    if (!Array.isArray(m.content) || !m.content.length) return `message ${i} is empty`;
    let other = false;
    const answered = new Set(), seen = new Set();   // ids in this message: each once
    for (const b of m.content) {
      if (!b || typeof b !== 'object') return `message ${i} has a block that is not one`;
      if (!fits(m.role, b)) return `message ${i} has a ${b.type} block where it cannot be`;
      if (b.type === 'tool_use') { if (!isId(b.id) || seen.has(b.id)) return `message ${i} has a tool_use with a missing or repeated id`; seen.add(b.id); }
      if (b.type === 'tool_result') { if (!isId(b.tool_use_id) || answered.has(b.tool_use_id)) return `message ${i} has a tool_result with a missing or repeated id`; answered.add(b.tool_use_id); }
      if (b.type === 'text' && blank(b.text)) return `message ${i} has a blank text block`;
      if (b.type === 'tool_use' && !(m.role === 'assistant' && list[i + 1] && ids(list[i + 1], 'tool_result', 'tool_use_id').has(b.id))) return `message ${i} has a tool_use without its tool_result`;
      if (b.type === 'tool_result') {
        if (!(m.role === 'user' && i > 0 && ids(list[i - 1], 'tool_use', 'id').has(b.tool_use_id))) return `message ${i} has a tool_result without its tool_use`;
        if (other) return `message ${i} has text before a tool_result`;
      } else other = true;
    }
    if (m.role === 'assistant' && m.content.every(isThinking)) return `message ${i} has only thinking`;
  }
  return null;
}
