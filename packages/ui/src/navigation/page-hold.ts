/**
 * Whether the page rendering now is a client-side page change or the first document. A page always
 * arrives complete (no streamed reads), so a page change keeps the current page on screen until the
 * next one is ready; only entrance motion asks which kind of render this is.
 */

let documentHydrated = false;

/** Marks the document as hydrated; called once by the application frame's first effect. */
export const markDocumentHydrated = (): void => {
  documentHydrated = true;
};

/** Whether a page rendering now is a client-side page change rather than the first document. */
export const isClientPageChange = (): boolean => typeof window !== "undefined" && documentHydrated;
