/**
 * The More button of each selected block's action bar, by block id, so a dialog that the bar's menu
 * opened gives the keyboard focus back to the block it acted on (Studio's own element, found by
 * registration and never by reading the canvas).
 */
const buttons = new Map<string, HTMLElement>();

/** A bar registers its More button while it is on the canvas; the returned function withdraws it. */
export const registerStudioActionBarMore = (id: string, button: HTMLElement): (() => void) => {
  buttons.set(id, button);
  return () => {
    if (buttons.get(id) === button) buttons.delete(id);
  };
};

/** Where focus returns after a block's dialog closes: that block's More button, when it is drawn. */
export const studioActionBarMore = (id: string): HTMLElement | null => buttons.get(id) ?? null;
