const loggedRequestFailures = new WeakSet<object>();

/**
 * The request runner logs every answer that is not available, once, and marks the error it caught.
 * A caller that catches that same error, or throws a new one restating the answer (marked here),
 * adds no second line. A mark is no property of the error: its identity and output are unchanged.
 * It lives apart from the runner and its classification so the installation errors, which the
 * classification names, can mark an error without importing the runner back.
 */
export const requestFailureLogged = (error: unknown): boolean =>
  typeof error === "object" && error !== null && loggedRequestFailures.has(error);

export const markRequestFailureLogged = <Failure>(error: Failure): Failure => {
  if (typeof error === "object" && error !== null) loggedRequestFailures.add(error);
  return error;
};
