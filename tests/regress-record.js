// Serialising tests/regress-hashes.json for `regress.test.js --update`.
//
// The write is its own module so it can be tested without running the gate: a test hands it the existing file's
// contents and a freshly computed result set, and compares the text it returns with what is on disk. Running the
// real --update to test --update would re-run every trace and frame, which is the whole gate.
//
// Why the order is taken from the existing file: the cases are registered in regress.test.js in an order that is
// not the file's ("trace coco multifdc" is registered below the FDC write loops but recorded above them, where it
// reads with the other controllers). Writing the computed object verbatim therefore moves unrelated entries on
// every re-record, and a one-hash change arrives as a diff full of churn. Keeping the file's order makes a
// re-record show only what changed; new cases are appended, where a reader sees them as an addition.

// The key order to write: every key the existing file has that this run produced, in the file's order, then any
// key this run produced that the file does not have, in the run's order. A key in the file that this run did not
// produce is dropped -- the file records what this version of the gate computes, and a stale entry is a hash
// nothing checks.
const orderOf = (existing, actual) => {
  const keys = Object.keys(actual);
  if (!existing) return keys;
  const known = new Set(keys);
  const kept = Object.keys(existing).filter((k) => known.has(k));
  const added = keys.filter((k) => !Object.prototype.hasOwnProperty.call(existing, k));
  return kept.concat(added);
};

// `existing` is the file's current text (or null when there is none). Values always come from `actual`; only the
// order comes from the file. `actual`'s own key order is used within an entry, so the shape each hash function
// returns is the shape recorded.
const recordText = (existing, actual) => {
  let parsed = null;
  if (existing != null) {
    try { parsed = JSON.parse(existing); } catch (e) { parsed = null; }   // unreadable: fall back to actual's order
  }
  const ordered = {};
  for (const k of orderOf(parsed, actual)) ordered[k] = actual[k];
  return JSON.stringify(ordered, null, 2) + '\n';
};

module.exports = { recordText };
