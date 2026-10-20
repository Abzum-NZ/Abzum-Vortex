/** Controls inside a cell keep their own pointer and keyboard meaning. */
const INTERACTIVE_IN_GRID =
  "a,button,input,select,textarea,label,summary,[role='button'],[role='checkbox'],[role='radio'],[role='menuitem'],[role='switch'],[contenteditable='true']";

export const isInteractiveGridTarget = (
  target: EventTarget | null,
  container: HTMLElement,
): boolean => {
  if (!(target instanceof Element)) return false;
  const control = target.closest(INTERACTIVE_IN_GRID);
  return control !== null && control !== container && container.contains(control);
};

/** The Records grid's own root: a grid, or a tree grid while it draws sub-rows. */
export const GRID_ROOT = "[role='grid'],[role='treegrid']";
