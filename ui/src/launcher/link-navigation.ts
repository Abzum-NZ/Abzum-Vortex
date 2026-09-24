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
  /** The same-origin address a new browsing context opens for an internal target. */
  resolveInternalAddress: (target: LinkTarget) => string;
}>;

/** One external anchor's attributes: a validated address opened in a new browsing context. */
export type ExternalLinkActivation = Readonly<{
  href: string;
  target: "_blank";
  rel: "noopener noreferrer";
}>;

const refusedExternalAddress = (): DefinitionRenderError =>
  new DefinitionRenderError(
    "INVALID_COMPOSITION",
    "An external link requires an HTTPS address without credentials, at most 2048 characters",
  );

/** True when leaving the current surface may proceed; absent guard means nothing to protect. */
const mayDiscardUnsavedWork = (guard: UnsavedWorkGuard | undefined): boolean =>
  guard === undefined || !guard.hasUnsavedWork() || guard.confirmDiscardUnsavedWork();

/** Opens a new browsing context with no opener access and no referrer; never a server fetch. */
const openNewContext = (address: string): void => {
  window.open(address, "_blank", "noopener,noreferrer");
};

/**
 * Resolves the shell's address for an internal target against this document and accepts it only
 * when it stays on this origin, so an internal link can never be turned into an external one.
 */
const sameOriginAddress = (address: string): string | undefined => {
  try {
    const resolved = new URL(address, window.location.origin);
    return resolved.origin === window.location.origin ? resolved.href : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The anchor attributes for one external link tile. The address is validated against the shared
 * bounded HTTPS contract (HTTPS only, no embedded credentials, at most the shared length limit)
 * before render, and an invalid address fails the render closed rather than being shown. The anchor
 * opens a new browsing context with no opener access or referrer, so the current surface and its
 * unsaved work stay in place. The platform never fetches the address on the person's behalf.
 */
export function externalLinkActivation(address: unknown): ExternalLinkActivation {
  const parsed = safeHttpsUrlSchema.safeParse(address);
  if (!parsed.success) throw refusedExternalAddress();
  return Object.freeze({
    href: parsed.data,
    target: "_blank" as const,
    rel: "noopener noreferrer" as const,
  });
}

/**
 * Activates one declared link target under its declared open behaviour. An external address is
 * validated, then opened by full document navigation after unsaved-work protection (`replace`) or
 * in a new browsing context without opener access or referrer (`new_page`); it is never fetched.
 * An internal target is re-checked on the server first and refused when it is no longer available;
 * `replace` then transitions client-side after unsaved-work protection, and `new_page` opens its
 * same-origin address in a new browsing context. A new browsing context never leaves the current
 * surface, so it needs no unsaved-work prompt. Returns true only when navigation was started.
 */
export async function activateLinkTarget(
  target: LinkTarget,
  behavior: LinkOpenBehavior,
  environment: LinkNavigationEnvironment,
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (target.kind === "external") {
    const address = safeHttpsUrlSchema.safeParse(target.address);
    if (!address.success) return false;
    if (behavior === "new_page") {
      openNewContext(address.data);
      return true;
    }
    if (!mayDiscardUnsavedWork(environment.unsavedWork)) return false;
    window.location.assign(address.data);
    return true;
  }
  if (!(await environment.recheckInternalTarget(target))) return false;
  if (behavior === "new_page") {
    const address = sameOriginAddress(environment.resolveInternalAddress(target));
    if (address === undefined) return false;
    openNewContext(address);
    return true;
  }
  if (!mayDiscardUnsavedWork(environment.unsavedWork)) return false;
  environment.navigateInternal(target);
  return true;
}
