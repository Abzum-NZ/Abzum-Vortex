/**
 * Where an address leads. An internal destination is a root-relative path of this application
 * (navigated in place, the document never reloads); an external one is a credential-free web
 * address, a mail address or a telephone number (left to the browser). Anything else is refused.
 * Callers keep their own stricter rules (for example https only) before they hand an address on.
 */
export type Destination =
  | Readonly<{ kind: "internal"; path: string }>
  | Readonly<{ kind: "server_route"; path: string }>
  | Readonly<{ kind: "fragment"; address: string }>
  | Readonly<{ kind: "external"; address: string; web: boolean }>;

/** A control character (C0 or delete) never belongs in an address. */
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
const INTERNAL_BASE = "https://vortex.invalid";

/**
 * Internal addresses answered by a server route, not a page: the browser follows them as a document
 * request and they are never prefetched (ending a session must not happen because a link was
 * pointed at).
 */
const SERVER_ROUTES: readonly string[] = [
  "/api",
  "/auth/session",
  "/auth/session-ended",
  "/health",
];
const isServerRoute = (path: string): boolean =>
  SERVER_ROUTES.some(
    (route) => path === route || path.startsWith(`${route}/`) || path.startsWith(`${route}?`),
  );

/** The destination an address names, or undefined when it is neither internal nor a safe external one. */
export function destinationOf(address: string): Destination | undefined {
  if (address.length === 0 || hasControlCharacter(address) || address.includes("\\"))
    return undefined;
  // A place on the page shown now (a skip link, or a design canvas whose links lead nowhere).
  if (address.startsWith("#")) return { kind: "fragment", address };
  if (address.startsWith("/") && !address.startsWith("//")) {
    try {
      const url = new URL(address, INTERNAL_BASE);
      if (url.origin !== INTERNAL_BASE) return undefined;
      return isServerRoute(address)
        ? { kind: "server_route", path: address }
        : { kind: "internal", path: address };
    } catch {
      return undefined;
    }
  }
  if (/^(mailto|tel):/i.test(address)) return { kind: "external", address, web: false };
  if (!/^https?:/i.test(address)) return undefined;
  try {
    const url = new URL(address);
    if (url.username !== "" || url.password !== "" || url.hostname === "") return undefined;
    return { kind: "external", address, web: true };
  } catch {
    return undefined;
  }
}

/**
 * The one landing resolver after sign-in: it opens the person's only organisation's application
 * page, or offers the organisation chooser when there are several.
 */
export const SIGNED_IN_LANDING_PATH = "/signed-in";
