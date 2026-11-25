#!/usr/bin/env node
// A black-box case as a typing sheet, for running it on a real Dragon 64 by hand (docs/clean-room-basic.md section 7):
// what to type and press, step by step, with the case's directives spelt out. Write down every line the screen shows,
// in order (lines that scroll off the top too), lower case where the screen shows inverse letters; then
// tools/basic-bb/import.js turns the written transcripts into the same JSONL tools/basic-bb/run.js writes.
//   node tools/basic-bb/sheet.js CASE.bas...       print the sheets
const fs = require('fs'), path = require('path');
const { lintCase } = require('./lint.js');

function sheet(name, text) {
  const out = [`=== ${name}`, '1. Switch on (or press reset) and wait for OK.', '2. Type CLS and press ENTER. Write down the screen from here on.'];
  let step = 3, nowait = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^#(\S*)\s?(.*)$/.exec(line);
    let what;
    if (!m) {
      what = `Type:  ${line}  and press ENTER; ${nowait ? 'it then waits for typing' : `wait until ${/^\s*\d/.test(line) ? 'the cursor is back' : 'OK is shown'}`}.`;
      nowait = false;
    }
    else if (m[1] === '') continue;
    else if (m[1] === 'type') what = `Type:  ${m[2].replace(/\\n/g, '  ENTER  ')}  (as the program asks for it).`;
    else if (m[1] === 'keys') what = `Press ${m[2].split('+').join(' and ')} together, then let go.`;
    else if (m[1] === 'break') what = 'Press BREAK; wait until OK is shown.';
    else if (m[1] === 'frames') what = `Wait ${(Number(m[2]) / 50).toFixed(1)} seconds.`;
    else if (m[1] === 'wait-text') what = `Wait until the screen shows ${m[2]}.`;
    else if (m[1] === 'nowait') { nowait = true; continue; }
    else if (m[1] === 'screenshot') what = `Photograph the screen (picture "${m[2]}").`;
    else if (m[1] === 'wav') what = `Start recording the speaker (sound "${m[2]}").`;
    else if (m[1] === 'wav-stop') what = 'Stop recording the speaker.';
    else if (m[1] === 'joy') { const [n, v] = m[2].trim().split(/\s+/); what = `Set the ${n < 2 ? 'right' : 'left'} joystick's ${n % 2 ? 'up-down' : 'left-right'} position so that JOYSTK(${n}) reads ${v} (0-63).`; }
    else continue;                                   // #timeout: nothing to do by hand
    out.push(`${step++}. ${what}`);
  }
  out.push(`${step}. Done: write "=== ${name}" above what you wrote down.`, '');
  return out.join('\n');
}
module.exports = { sheet };

if (require.main === module) {
  for (const f of process.argv.slice(2)) {
    const text = fs.readFileSync(f, 'utf8'), problems = lintCase(text);
    if (problems.length) { console.error(`${f}: refused by the lint:\n  ${problems.join('\n  ')}`); process.exitCode = 1; continue; }
    process.stdout.write(sheet(path.basename(f, '.bas'), text) + '\n');
  }
}
