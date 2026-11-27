/*
 * Settings -> "Claude features: On / Off" (the Machine tab). Off: the body gets .claude-off, which hides the app bar's
 * Ask button, the Ask panel and its rail, and the Programs row "Chat with Claude" (play/index.html), and the command
 * box leaves out its Claude rows and the "Ask Claude" row (js/ui/command-box.js reads session.claudeFeatures). The
 * welcome menu's own Claude item stays: it is the firmware's. On is the default; the choice is Session.claudeFeatures,
 * kept with the settings (and so in a settings export).
 *
 * Under it, "Suggest questions with Claude" (Session.claudeSuggest, off by default, also in a settings export): hidden
 * while Claude features is Off; shown but disabled, "Needs your API key" beside it, without a key (nothing is sent).
 * While it is on, the note under Claude features says an empty chat sends too (NOTE_SUGGEST).
 */
import { $ } from './page.js';

export const NOTE = 'Off hides Ask Claude, Claude in the command box and Chat with Claude. Nothing goes to Claude either way until you ask.';
export const NOTE_SUGGEST = 'Off hides Ask Claude, Claude in the command box and Chat with Claude. Nothing goes to Claude until you ask, or open an empty chat with Suggest questions on.';

export function setupClaudeFeatures(page, { closeAsk = () => {}, claude = null } = {}) {
  const { session } = page;
  const on = $('btnClaudeOn'), off = $('btnClaudeOff'), input = $('cmdInput'), foot = document.querySelector('#cmdBox .cmdfoot');
  const words = { place: input.placeholder, foot: foot.textContent };   // the box's words with Claude in it
  function sync() {
    const yes = session.claudeFeatures;
    // the command box offers no question for Claude while Off, and says so
    input.placeholder = yes ? words.place : 'Find a command';
    input.setAttribute('aria-label', input.placeholder);
    foot.textContent = yes ? words.foot : 'Type to filter. Commands run here.';
    document.body.classList.toggle('claude-off', !yes);
    on.setAttribute('aria-pressed', String(yes));
    off.setAttribute('aria-pressed', String(!yes));
    // Suggest questions with Claude
    const key = session.hasClaudeKey, sug = session.claudeSuggest;
    $('claudeSuggestBox').hidden = !yes;
    $('chkClaudeSuggest').checked = sug;
    $('chkClaudeSuggest').disabled = !key;
    $('claudeSuggestNoKey').hidden = key;
    const note = sug ? NOTE_SUGGEST : NOTE;
    if ($('claudeFeaturesNote').textContent !== note) $('claudeFeaturesNote').textContent = note;
  }
  $('chkClaudeSuggest').onchange = (e) => session.setClaudeSuggest(e.target.checked);
  on.onclick = () => session.setClaudeFeatures(true);
  // Off: a turn running is stopped, the full-screen chat ends and the panel closes; no door can start another
  // (js/ui/claude.js checks session.claudeFeatures on every one)
  off.onclick = () => {
    session.setClaudeFeatures(false);
    if (claude) { if (session.claudeStatus) claude.stop(); if (session.claudeView === 'full') claude.closeFull(); }
    closeAsk();
  };
  session.on((ev) => { if (ev === 'claudefeatures' || ev === 'claudesuggest') sync(); });
  // (a key saved or forgotten: the checkbox is enabled or disabled)
  if (claude) claude.onChange(sync);
  sync();
  return { sync };
}
