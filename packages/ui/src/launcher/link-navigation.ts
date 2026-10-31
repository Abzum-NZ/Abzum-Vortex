"use client";

import type { JsonValue } from "@vortex/platform/schema";
import type { FlowIntent } from "../flow-runtime/intents";

/**
 * One declared link target. The target is definition or record data and grants no access to what
 * it names; an internal target is only ever resolved against the viewer's current server-side
 * access, never trusted from the browser.
 */
type LinkTarget = Readonly<{
  kind: "page";
  pageId: string;
  /** Parameters of the Navigate task that opened it; the shell decides how a page uses them. */
  parameters?: Readonly<Record<string, JsonValue>>;
}>;

/**
 * Unsaved-work protection supplied by the shell: `hasUnsavedWork` reports whether the current
 * surface holds input that leaving would discard, and `confirmDiscardUnsavedWork` asks the person
 * and returns true only when they agree. This module never invents that product decision.
 */
export type UnsavedWorkGuard = Readonly<{
  hasUnsavedWork: () => boolean;
  confirmDiscardUnsavedWork: () => Promise<boolean>;
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
}>;

/** True when leaving the current surface may proceed; absent guard means nothing to protect. */
const mayDiscardUnsavedWork = async (guard: UnsavedWorkGuard | undefined): Promise<boolean> =>
  guard === undefined || !guard.hasUnsavedWork() || (await guard.confirmDiscardUnsavedWork());

/** The page target a Navigate task intent names; undefined when it names no valid page. */
const linkTargetForNavigateIntent = (intent: FlowIntent): LinkTarget | undefined => {
  const { page, parameters } = intent.properties;
  if (intent.kind !== "navigate" || typeof page !== "string" || page.length === 0) return undefined;
  const bag =
    typeof parameters === "object" && parameters !== null && !Array.isArray(parameters)
      ? parameters
      : undefined;
  return { kind: "page", pageId: page, ...(bag === undefined ? {} : { parameters: bag }) };
};

/**
 * The browser implementation of the Navigate task (`interface.navigate`). The page is re-checked on
 * the server first and refused when it is no longer available; navigation then follows unsaved-work
 * protection. Returns true only when navigation was started.
 */
export async function performNavigateTask(
  intent: FlowIntent,
  environment: LinkNavigationEnvironment,
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const target = linkTargetForNavigateIntent(intent);
  if (target === undefined) return false;
  if (!(await environment.recheckInternalTarget(target))) return false;
  if (!(await mayDiscardUnsavedWork(environment.unsavedWork))) return false;
  environment.navigateInternal(target);
  return true;
}
