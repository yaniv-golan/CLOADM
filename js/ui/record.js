/*
 * ?record=1 (URL only; no control on the page leads here): the screen alone, for recording a video of it. No page
 * chrome (the app bar, the drawer, the controls, the toasts and hints), the picture integer-scaled and centred in a
 * fixed 4:3 frame, or with &aspect=16:9 in a 16:9 frame with black bars beside the 4:3 picture (pillarbox). The
 * frame is the largest that fits the window; the CSS is play/index.html's body.record rules. The display changes are
 * for this visit only (never stored). Unlike ?embed=1 there is no API: the page is the person's own.
 */
export function setupRecord(page, aspect) {
  document.body.classList.add('record');
  document.body.dataset.recordAspect = aspect === '16:9' ? '16:9' : '4:3';
  page.session.setDisplay({ integer: true, aspect: '4:3' }, { remember: false });
}
