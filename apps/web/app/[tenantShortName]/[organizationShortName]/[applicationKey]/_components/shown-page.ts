/**
 * The data re-read of the application page shown now, whichever application's frame shows it. A
 * change an earlier page started and finished after that page had gone (an Undo carried to the next
 * page, even in another application) re-reads only the placements the shown page reads.
 */
let shownPageRefresh: (() => void) | undefined;

/** Registers the shown page's re-read; returns the withdrawal for when that page leaves. */
export const registerShownPageRefresh = (refresh: () => void): (() => void) => {
  shownPageRefresh = refresh;
  return () => {
    if (shownPageRefresh === refresh) shownPageRefresh = undefined;
  };
};

/** Re-reads the data of the page shown now, when one is shown. */
export const refreshShownPage = (): void => shownPageRefresh?.();
