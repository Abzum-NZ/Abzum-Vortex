"use client";

import { safeHttpsUrlSchema } from "@vortex/contracts";
import { DefinitionRenderError } from "../definition-error";

/**
 * The two open behaviours a link may declare (spec 07). `replace` uses a client-side transition for
 * an internal target and a full document navigation for an external one; `new_page` opens a new
 * browsing context without opener access or referrer.
 */
export type LinkOpenBehavior = "replace" | "new_page";

export const LINK_OPEN_BEHAVIORS: readonly LinkOpenBehavior[] = Object.freeze([
  "replace",
  "new_page",
]);

/**
 * One declared link target. The target is definition or record data and grants no access to what
 * it names; an internal target is only ever resolved against the viewer's current server-side
 * access, never trusted from the browser.
 */
export type LinkTarget =
  | Readonly<{ kind: "page"; pageId: string }>
  | Readonly<{ kind: "application"; applicationRootId: string }>
  | Readonly<{ kind: "external"; address: string }>;

/**
 * Unsaved-work protection supplied by the shell: `hasUnsavedWork` reports whether the current
 * surface holds input that leaving would discard, and `confirmDiscardUnsavedWork` asks the person
 * and returns true only when they agree. This module never invents that product decision.
 */
export type UnsavedWorkGuard = Readonly<{
  hasUnsavedWork: () => boolean;
  confirmDiscardUnsavedWork: () => boolean;
}>;

/** Shell services a link activation needs; all browser and server effects stay with the shell. */
export type LinkNavigationEnvironment = Readonly<{
  unsavedWork?: UnsavedWorkGuard;
  /**
   * Re-checks an internal target on the server through the page/access projection at the moment of
   * activation. A target that is missing, refused or withdrawn returns false and is not opened.
   */
  recheckInternalTarget: (target: LinkTarget) => Promise<boolean> | boolean;
  /** Performs the client-side transition for an internal target; the shell stays mounted. */
  navigateInternal: (target: LinkTarget) => void;
  /** The address a new browsing context opens for an internal target. */
  resolveInternalAddress: (target: LinkTarget) => string;
}>;

/** One external anchor's activation: a validated address plus its fail-closed click guard. */
export type ExternalLinkActivation = Readonly<{
  href: string;
  target: "_blank";
  rel: "noopener noreferrer";
  onClick: (event: { preventDefault: () => void }) => void;
}>;

/**
 * Validates one external address against the shared bounded HTTPS contract: HTTPS only, no embedded
 * credentials and at most the shared length limit. An invalid address fails the render closed
 * rather than being silently opened.
 */
const requireSafeExternalAddress = (address: unknown): string => {
  const parsed = safeHttpsUrlSchema.safeParse(address);
  if (!parsed.success)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "An external link requires an HTTPS address without credentials, at most 2048 characters",
    );
  return parsed.data;
};

/** True when leaving the current surface may proceed; absent guard means nothing to protect. */
const mayDiscardUnsavedWork = (guard: UnsavedWorkGuard | undefined): boolean =>
  guard === undefined || !guard.hasUnsavedWork() || guard.confirmDiscardUnsavedWork();

/** Opens a new browsing context with no opener access and no referrer; never a server fetch. */
const openNewContext = (address: string): void => {
  if (typeof window === "undefined") return;
  window.open(address, "_blank", "noopener,noreferrer");
};

/** Navigates the current document to an external address after unsaved-work protection. */
const assignFullDocument = (address: string): void => {
  if (typeof window === "undefined") return;
  window.location.assign(address);
};

/**
 * The activation props for one external link tile. The address is validated once; the anchor opens
 * a new browsing context with no opener access or referrer, and the click handler only enforces the
 * unsaved-work guard, so a refused activation never navigates. The platform never fetches the
 * address on the person's behalf.
 */
export function externalLinkActivation(
  address: unknown,
  unsavedWork?: UnsavedWorkGuard,
): ExternalLinkActivation {
  const href = requireSafeExternalAddress(address);
  return Object.freeze({
    href,
    target: "_blank" as const,
    rel: "noopener noreferrer" as const,
    onClick: (event: { preventDefault: () => void }): void => {
      if (!mayDiscardUnsavedWork(unsavedWork)) event.preventDefault();
    },
  });
}

/**
 * Activates one declared link target under its declared open behaviour. An external address is
 * validated, protected for unsaved work, then opened by full document navigation (`replace`) or in
 * a new browsing context without opener access or referrer (`new_page`); it is never fetched. An
 * internal target is re-checked on the server first, and a target that is no longer available is
 * refused so the surface stays unchanged. Returns true when navigation was started or allowed.
 */
export async function activateLinkTarget(
  target: LinkTarget,
  behavior: LinkOpenBehavior,
  environment: LinkNavigationEnvironment,
): Promise<boolean> {
  if (target.kind === "external") {
    const address = requireSafeExternalAddress(target.address);
    if (!mayDiscardUnsavedWork(environment.unsavedWork)) return false;
    if (behavior === "new_page") openNewContext(address);
    else assignFullDocument(address);
    return true;
  }
  if (!(await environment.recheckInternalTarget(target))) return false;
  if (!mayDiscardUnsavedWork(environment.unsavedWork)) return false;
  if (behavior === "new_page")
    openNewContext(requireSafeExternalAddress(environment.resolveInternalAddress(target)));
  else environment.navigateInternal(target);
  return true;
}
