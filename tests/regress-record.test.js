// `node tests/regress.test.js --update` must rewrite tests/regress-hashes.json with the SAME key order it already
// had, so a re-record only shows the entries whose values actually changed. Before this, the writer serialised the
// freshly computed `actual` object in the order the cases are registered in regress.test.js, which differs from the
// file's order ("trace coco multifdc" is registered below the FDC write loops but recorded above them), so every
// re-record moved unrelated entries and buried the real change in churn.
// Run: node tests/regress-record.test.js
const fs = require('fs'), path = require('path');
const { recordText } = require('./regress-record.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const FILE = path.join(__dirname, 'regress-hashes.json');
const existingText = fs.readFileSync(FILE, 'utf8');
const existing = JSON.parse(existingText);

// Rebuilding `actual` in a different insertion order must still produce the file exactly as it stands.
// A reversed order is the strongest form of "different": if the writer honours `actual`'s order at all, this
// cannot come out byte-identical by accident.
{
  const reversed = {};
  for (const k of Object.keys(existing).reverse()) reversed[k] = existing[k];
  const out = recordText(existingText, reversed);
  check('a re-record with unchanged values is byte-identical', out === existingText,
    out === existingText ? `(${existingText.length} bytes, ${Object.keys(existing).length} entries)`
      : `first difference at byte ${[...existingText].findIndex((c, i) => c !== out[i])}`);
}

// ...and the same for the gate's own order specifically. The file records "trace coco multifdc" ABOVE "trace
// dgnalpha alphafdc write"; regress.test.js registers them the other way round (multifdc is registered below the
// FDC write loops). Build that order explicitly, so this is the real code order and not a restatement of the file's.
{
  const fileOrder = Object.keys(existing);
  const codeOrder = [...fileOrder];
  const above = codeOrder.indexOf('trace coco multifdc'), below = codeOrder.indexOf('trace dgnalpha alphafdc write');
  codeOrder.splice(above, 1);
  codeOrder.splice(codeOrder.indexOf('trace dgnalpha alphafdc write') + 1, 0, 'trace coco multifdc');
  check('the test really does reorder them', above < below && codeOrder.indexOf('trace coco multifdc') > codeOrder.indexOf('trace dgnalpha alphafdc write'));
  const actual = {};
  for (const k of codeOrder) actual[k] = existing[k];
  const out = recordText(existingText, actual);
  check('a re-record in the gate\'s own case order is byte-identical too', out === existingText,
    out === existingText ? '' : 'the file would be reordered');
}

// The order must come from the file, and a changed value must still be written.
{
  const actual = {};
  for (const k of Object.keys(existing)) actual[k] = existing[k];
  const first = Object.keys(existing)[0];
  actual[first] = Object.assign({}, existing[first], { hash: 'deadbeef' });
  const out = recordText(existingText, actual);
  const reparsed = JSON.parse(out);
  check('a changed value is recorded', reparsed[first].hash === 'deadbeef');
  check('...and only that value changed', out.replace(first, '') !== existingText.replace(first, ''));
  check('...with every other key still in place', Object.keys(reparsed).join() === Object.keys(existing).join());
  // the only textual difference is the one hash
  const a = existingText.split('\n'), b = out.split('\n');
  const diffs = a.map((l, k) => (l === b[k] ? null : k)).filter((k) => k !== null);
  check('...and the diff is a single line', diffs.length === 1 && b[diffs[0]].includes('deadbeef'),
    `${diffs.length} line(s) differ`);
}

// A key the file does not have yet is appended at the end, not inserted in the middle.
{
  const actual = {};
  for (const k of Object.keys(existing)) actual[k] = existing[k];
  actual['trace a brand new case'] = { hash: '0000beef', instructions: 1, halted: true };
  const out = recordText(existingText, actual);
  const keys = Object.keys(JSON.parse(out));
  check('a new key is appended at the end', keys[keys.length - 1] === 'trace a brand new case');
  check('...and the existing keys keep their order', keys.slice(0, -1).join() === Object.keys(existing).join());
  // The existing entries are repeated verbatim, with only the separator and the new entry added: everything up to
  // the old file's last entry's closing brace is unchanged text.
  const lastClose = existingText.lastIndexOf('\n  }') + 4;
  check('...leaving every existing entry byte-identical', out.startsWith(existingText.slice(0, lastClose)),
    `checked ${lastClose} bytes`);
  check('...with the new entry after them', out.indexOf('trace a brand new case') > lastClose);
}

// A key that is no longer produced is dropped -- the file records what this version of the gate computes, and a
// stale entry would be a hash nothing checks. Say so, so the behaviour is deliberate rather than incidental.
{
  const keys = Object.keys(existing);
  const actual = {};
  for (const k of keys.slice(1)) actual[k] = existing[k];
  const out = Object.keys(JSON.parse(recordText(existingText, actual)));
  check('a case that no longer exists is dropped from the file', out.length === keys.length - 1 && out[0] === keys[1]);
}

// No file yet: the first record writes the computed set in its own order, formatted like every later one.
{
  const out = recordText(null, { a: { hash: '01' }, b: { hash: '02' } });
  check('with no existing file the computed order is used', out === '{\n  "a": {\n    "hash": "01"\n  },\n  "b": {\n    "hash": "02"\n  }\n}\n');
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
