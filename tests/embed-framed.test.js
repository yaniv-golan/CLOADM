// Run: node tests/embed-framed.test.js
//
// A CLOADM shown inside someone else's page must not offer the Claude chat, whether it got there through the
// documented embed (`?embed=1`) or by being framed without it.
//
// RED-FIRST, against the merged tree before the fix: `link.embed` is only the URL flag, so a third-party page that
// frames /play/?app=claude with no embed=1 gets the full UI, the chat and the key card.
//
// The rule is decided in js/config.js as a pure function so it can be tested here and used by the page:
//   claudeOffered(link, framedInOtherPage) -> boolean
// `framedInOtherPage` is `window.top !== window` where the page can ask; in Node it is passed in.
const path = require('path');
let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

(async () => {
  const { claudeOffered } = await import(path.join(__dirname, '../js/config.js'));

  check('the decision is a function the page can call', typeof claudeOffered === 'function', typeof claudeOffered);

  const link = (embed = false) => ({ embed, app: null });

  // --- the chat is offered only when the page is a top-level, non-embed page ---
  check('a normal top-level visit is offered the chat', claudeOffered(link(false), false) === true);
  check('?embed=1 is NOT offered the chat (the documented embed)', claudeOffered(link(true), false) === false);
  check('a top-level page is not "framed", so the flag does not change it', claudeOffered(link(false), false) === true);
  // the case this branch exists for: framed in someone else's page with NO embed=1
  check('FRAMED in another page WITHOUT embed=1 is NOT offered the chat (the redress case)',
    claudeOffered(link(false), true) === false);
  check('framed AND embed=1 is also not offered (no double negative)', claudeOffered(link(true), true) === false);
  // a missing/unknown frame signal must fail closed, not open
  check('an unknown frame signal (undefined) is NOT offered the chat: fail closed',
    claudeOffered(link(false), undefined) === false, String(claudeOffered(link(false), undefined)));

  console.log(fail ? `\n${fail} FAILED` : '\nall embed-framed checks passed');
  process.exitCode = fail ? 1 : 0;
})();
