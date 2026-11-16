// Run: node tests/claude-failuretext.test.js
//
// ui/claude.js's failureText: the line a PERSON sees for a failed tool call. The model gets the JSON
// ({"error":{code,remedy,detail}}); the page must show the remedy instead - a person reading the activity log
// should not be shown an error object, and above all not "[object Object]".
//
// The last check is the one that matters most: it feeds failureText exactly what a String(result) regression
// would produce and requires the result to differ, so a regression to the old shape fails here rather than
// reaching the page.
const fs = require('fs');
const path = require('path');
const Emu = require('./load')();
const { failureText } = require('../js/ui/claude.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// a coded error, built the way the tools build one
const err = new Emu.ToolError(Emu.TOOL_CODES.BAD_ADDRESS, 70000);

// 1. a ToolError shows its remedy, exactly
const shown = failureText(err);
check('a ToolError shows its remedy', shown === Emu.TOOL_ERRORS[Emu.TOOL_CODES.BAD_ADDRESS], JSON.stringify(shown));
check('and that equals the code\'s remedy', shown === err.tool.remedy);

// 2. it is a plain line: no JSON braces, and none of the code/remedy JSON the model received
check('the line has no JSON braces', !shown.includes('{') && !shown.includes('}'), JSON.stringify(shown));
check('the line is not the code\'s JSON', !shown.includes('"code"') && !shown.includes('"remedy"') && !/bad-address/.test(shown), JSON.stringify(shown));

// 3. the regression this test exists for: failureText must not behave like String(result).
//    String(err) is "ToolError: bad-address: use an address from 0 to 65535 (got 70000)" - it CONTAINS the
//    remedy and carries the code prefix. So equality or containment alone would not catch a regression: the
//    line must be the remedy ALONE, with no code token and not the Error's own rendering anywhere in it.
const asString = String(err);
const BAD_ADDRESS = Emu.TOOL_CODES.BAD_ADDRESS;
check('the line differs from String(error), so a String() regression fails', shown !== asString, JSON.stringify({ shown, asString }));
check('the line carries no code prefix (String(error) contains the remedy, so this is the check that catches it)',
  !shown.startsWith(`${BAD_ADDRESS}:`) && !shown.includes(BAD_ADDRESS) && !shown.includes('ToolError'), JSON.stringify(shown));
//    and String() of the tool result OBJECT is what the page would show if it stringified the result: "[object Object]"
check('the line is never "[object Object]"', shown !== '[object Object]' && !shown.includes('[object Object]'), JSON.stringify(shown));

// 4. a plain error (no code): its message, and not the JSON shape
const plain = failureText(new Error('poke needs at least one byte'));
check('a plain error shows its message', plain === 'poke needs at least one byte', JSON.stringify(plain));
check('and no braces either', !plain.includes('{'), JSON.stringify(plain));

// 5. long messages are cut, so one tool cannot fill the activity log
check('a long message is cut to 80 characters', failureText(new Error('x'.repeat(300))).length === 80);

// 6. nothing at all does not throw and does not print "undefined"/"null" as the word
check('a missing value gives a plain word', failureText(null) === 'failed' && failureText(undefined) === 'failed');

// 7. the page's own call site must still use it (a regression that deletes the call is caught here)
const ui = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui', 'claude.js'), 'utf8');
check('the activity log calls failureText for a failed tool', /✗ \$\{name\}: \$\{failureText\(value\)\}/.test(ui));

console.log(`\n${n - fail}/${n} failureText checks passed`);
process.exitCode = fail ? 1 : 0;
