// Fills every [data-version-stamp] on the page with "v<version> · <short commit>" (js/version.js): Help, About and the
// settings drawer's credits line. Loaded as a module by those pages; the emulator imports it from js/ui/main.js.
import { versionStamp } from '../version.js';

export function fillVersionStamps(root = document) {
  for (const el of root.querySelectorAll('[data-version-stamp]')) el.textContent = versionStamp();
}
fillVersionStamps();
