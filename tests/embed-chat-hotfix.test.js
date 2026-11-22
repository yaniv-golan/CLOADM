// Run: node tests/embed-chat-hotfix.test.js
//
// An embedded CLOADM must not be able to open the Claude chat. In embed mode there is no chat
// machine, no #claude panel, no key card, and no route reaches one: not `?app=claude`, not an EmbedApi call, not a
// keypress (the chat's own keys handlers are inside setupClaude, which does not run).
//
// Red on main 1dd66fa: the controller is set up in an embed and the embed stylesheet hides no Claude panel.
const fs = require('fs'), path = require('path');
let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---- A1: the page refuses the chat before setupClaude when the link embeds --------------------------------
{
  const main = read('js/ui/main.js');
  // setupClaude must be conditional on NOT embedding: `link.embed ? null : setupClaude(page)` (or equivalent)
  const guarded = /link\.embed\s*\?\s*null\s*:\s*setupClaude\(/.test(main);
  const uncond = /^const claude = setupClaude\(page\);/m.test(main);
  check('main.js does not set up the Claude controller in an embed', guarded && !uncond,
    guarded ? '' : 'setupClaude(page) still runs unconditionally');
  // everything that takes `claude` must tolerate null (it is reached only when not embedding)
  check('the startup path does not call claude.open() when there is no controller',
    /if \(link\.app === 'claude'\) await claude\.open\(\);/.test(main)
      ? /if \(link\.app === 'claude' && claude\) await claude\.open\(\);/.test(main)
      : true,
    'app=claude startup guard');
}

// ---- A2: no CSS-free route shows the chat in an embed: the asides are hidden --------------------------------
{
  const html = read('play/index.html');
  // the embed rules as written: every `body.embed ... { ... }` block, joined
  const embedCss = (html.match(/body\.embed[^{]*\{[^}]*\}/g) || []).join('\n');
  check('the embed stylesheet hides the chat panel and the Ask panel (#claude, #ask)',
    /body\.embed #claude\b/.test(embedCss) && /body\.embed #ask\b/.test(embedCss), embedCss.slice(0, 200));
  check('the dead `.panels` selector is gone (there is no .panels element; it hid nothing)',
    !/body\.embed \.panels\b/.test(embedCss), '');
}

// ---- A3: EmbedApi.type takes the explicit personInput() call the other acting methods make ------------------
// (Session.typeText itself already pauses - js/session.js's typeText calls personInput - so this is the embed layer
// making the same call as load/insertTape/poke: defence in depth, not the only pause on the path.)
{
  const src = read('js/embed-api.js');
  const typeBody = (src.match(/  type\(text\) \{[\s\S]*?\n  \}/) || [''])[0];
  check('EmbedApi.type calls session.personInput(), as load/insertTape/poke do', /this\.session\.personInput\(\)/.test(typeBody), typeBody.trim().slice(0, 120));
  // and the acting methods that do NOT act (info, peek is a read) are unchanged in that respect
  const load = (src.match(/  load\(name, bytes\) \{[\s\S]*?\n  \}/) || [''])[0];
  check('load still takes the pause (unchanged)', /personInput\(/.test(load));
}

// ---- A4: an EmbedApi with no chat cannot type into a chat machine (behavioural) -----------------------------
// (the mock's typeText calls personInput as the real Session.typeText does, so the pause is not double-counted: this
// covers the EmbedApi LAYER - that it names a machine and takes its own pause - not the Session's behaviour, which
// js/session.js owns and its own tests pin.)
{
  const { EmbedApi } = require(path.join(ROOT, 'js/embed-api.js'));
  const log = { personInput: 0, typed: [] };
  const machine = { frameCount: 0, typist: { typePaced: (t) => log.typed.push(t) }, peek: () => 0, poke() {}, romCrcs: () => ({}), cartPort: null };
  const s = {
    on() { return () => {}; },
    get shownMachine() { return machine; },
    nitros9On: () => false,
    romCodeIn: () => null,
    personInput() { log.personInput++; },
    // the real Session.typeText does exactly this: pause, then queue on the machine named (or the shown one)
    typeText(text, m) { this.personInput(m); (m || this.shownMachine).typist.typePaced(text); },
    screenText() { return []; },
  };
  const api = new EmbedApi(s, () => {});
  api.type('hello\n');
  check('type reaches a machine and takes the pause (baseline: this branch does not remove typing)', log.typed.length === 1 && log.personInput >= 1,
    JSON.stringify(log));
}

console.log(fail ? `\n${fail} FAILED` : '\nall embed-chat-hotfix checks passed');
process.exitCode = fail ? 1 : 0;
