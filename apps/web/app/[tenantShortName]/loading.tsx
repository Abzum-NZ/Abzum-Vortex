/**
 * The first load of an organisation address (its launcher or one of its applications). The shape
 * of the page is not known yet, so nothing is drawn: the frame and page arrive together, and a
 * placement whose own data is still being read shows its own skeleton, the one loading visual.
 * Moving between pages of an application never shows this; the current page stays until the next
 * one is ready.
 */
export default function Loading() {
  return (
    <div className="min-h-svh" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
    </div>
  );
}
