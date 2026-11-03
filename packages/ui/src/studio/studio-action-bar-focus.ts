/**
 * The More button of each selected block's action bar, by block id, so a dialog that the bar's menu
 * opened gives the keyboard focus back to the block it acted on (Studio's own element, found by
 * registration and never by reading the canvas).
 */
const buttons = new Map<string, HTMLElement>();

/** A focus asked for a block whose bar is not drawn yet (it is drawn again after a move or a wrap). */
let pending: { id: string; until: number } | null = null;

/** A bar registers its More button while it is on the canvas; the returned function withdraws it. */
export const registerStudioActionBarMore = (id: string, button: HTMLElement): (() => void) => {
  buttons.set(id, button);
  if (pending !== null && pending.id === id && Date.now() <= pending.until) {
    pending = null;
    button.focus({ preventScroll: true });
  }
  return () => {
    if (buttons.get(id) === button) buttons.delete(id);
  };
};

/**
 * What a closing dialog gives focus back to: the block's More button when it is drawn. When the
 * block's bar is about to be drawn again (the dialog's change moved the block), the focus is taken
 * when it is, within a moment, and the dialog moves none itself.
 */
export const studioActionBarMore = (id: string): HTMLElement | false => {
  const button = buttons.get(id);
  if (button?.isConnected === true) return button;
  pending = { id, until: Date.now() + 3000 };
  return false;
};
