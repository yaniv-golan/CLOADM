/*
 * Settings -> "Claude features: On / Off" (the Machine tab). Off: the body gets .claude-off, which hides the app bar's
 * Ask button, the Ask panel and its rail, and the Programs row "Chat with Claude" (play/index.html), and the command
 * box leaves out its Claude rows and the "Ask Claude" row (js/ui/command-box.js reads session.claudeFeatures). The
 * welcome menu's own Claude item stays: it is the firmware's. On is the default; the choice is Session.claudeFeatures,
 * kept with the settings (and so in a settings export).
 */
import { $ } from './page.js';

export function setupClaudeFeatures(page, { closeAsk = () => {} } = {}) {
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
  }
  on.onclick = () => session.setClaudeFeatures(true);
  off.onclick = () => { session.setClaudeFeatures(false); closeAsk(); };
  session.on((ev) => { if (ev === 'claudefeatures') sync(); });
  sync();
  return { sync };
}
