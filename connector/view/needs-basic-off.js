// The "needs BASIC" detector (js/needs-basic.js) is not available in the side panel: the side panel has no card to show
// what it finds, so connector/build.js folds this module in its place and the inline view stays inside its size budget
// (tests/connector.test.js). There is no detector: the Session's needsBasic is null, a load arms nothing, a reset clears
// nothing, and there is no Run again (it is the detector's: Session.needsBasic.runAgain).
export const NeedsBasic = null;
