import "server-only";

import { revisionSchema, type NavigationItem } from "@vortex/contracts";
import type { ResolvedPageComposition } from "./page-composition-resolution";
import {
  projectNavigation,
  type NavigationPermissionDecisions,
  type ProjectedNavigation,
} from "./navigation-projection";
import {
  projectPageCapability,
  type PageCapabilityState,
  type ProjectedPageCapability,
} from "./page-capability-projection";

/**
 * The exact revisions a projected page, its navigation and its read models were decided under.
 * `accessVersion` comes from the verified organisation scope and `applicationReleaseRevision` from
 * the installed application context, so both are server-owned and never browser input. A client
 * presents the pair when it restores history, a back/forward cache or a late response.
 *
 * The pair is comparable only within one organisation, application and page: an Access version
 * belongs to one organisation, so callers key accepted content by that exact scope and never
 * compare revisions across scopes.
 */
export type PageContentRevisions = Readonly<{
  accessVersion: number;
  applicationReleaseRevision: number;
}>;

/**
 * `current`: the same decision revisions. `advanced`: decided under a newer Access version.
 * `stale`: decided under an older Access version. `conflicting`: the same Access version under a
 * different installed release, so neither side proves it is the current one.
 */
export type PageContentRevisionRelation = "stale" | "current" | "advanced" | "conflicting";

const safeRevision = revisionSchema.max(Number.MAX_SAFE_INTEGER);

/**
 * Reads the revisions a projected page or read-model value declares. Anything missing, malformed,
 * non-integer or out of range is `undefined`, so a caller refuses it as unusable instead of trusting
 * a look-alike payload.
 */
export const readPageContentRevisions = (payload: unknown): PageContentRevisions | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Readonly<Record<string, unknown>>;
  const accessVersion = safeRevision.safeParse(candidate.accessVersion);
  const applicationReleaseRevision = safeRevision.safeParse(candidate.applicationReleaseRevision);
  return accessVersion.success && applicationReleaseRevision.success
    ? {
        accessVersion: accessVersion.data,
        applicationReleaseRevision: applicationReleaseRevision.data,
      }
    : undefined;
};

/**
 * Relates an incoming revision pair to the one already accepted. The organisation Access version
 * only ever increases, so it orders decisions in time. The installed release revision is an exact
 * identity, not an order: an explicit rollback reinstalls an earlier release, so a lower release
 * revision under a newer Access version is the current installation, and a different release under
 * the same Access version cannot be ordered at all and fails closed as `conflicting`.
 */
export const pageContentRevisionRelation = (
  accepted: PageContentRevisions,
  incoming: PageContentRevisions,
): PageContentRevisionRelation => {
  if (incoming.accessVersion < accepted.accessVersion) return "stale";
  if (incoming.accessVersion > accepted.accessVersion) return "advanced";
  return incoming.applicationReleaseRevision === accepted.applicationReleaseRevision
    ? "current"
    : "conflicting";
};

/**
 * True when an incoming payload must not be rendered over the accepted content: it was decided under
 * an older Access version, or under a different release at the same Access version. History, a
 * back/forward cache or a late response is then refused rather than restored.
 */
export const isRefusedPageContentRevision = (
  accepted: PageContentRevisions,
  incoming: PageContentRevisions,
): boolean => {
  const relation = pageContentRevisionRelation(accepted, incoming);
  return relation === "stale" || relation === "conflicting";
};

/** One accepted projection of a page and its navigation, together with the revisions it belongs to. */
export type PageContentProjection = Readonly<{
  revisions: PageContentRevisions;
  page: ProjectedPageCapability;
  navigation: ProjectedNavigation;
}>;

/**
 * The fresh server-owned inputs to project a page. The capability state is the viewer's current
 * permission result; the navigation decisions are one decision per declared navigation key.
 */
export type PageContentReprojection = Readonly<{
  revisions: PageContentRevisions;
  resolved: ResolvedPageComposition;
  capability: PageCapabilityState;
  navigation: readonly NavigationItem[];
  navigationDecisions: NavigationPermissionDecisions;
}>;

/**
 * Projects a page and its navigation from fresh server-owned inputs. The envelope revisions are
 * authoritative and are stamped onto the page and carried beside the navigation, so a later payload
 * can prove which revisions it was decided under.
 */
export const projectPageContent = (input: PageContentReprojection): PageContentProjection =>
  Object.freeze({
    revisions: input.revisions,
    page: projectPageCapability(input.resolved, {
      ...input.capability,
      accessVersion: input.revisions.accessVersion,
      applicationReleaseRevision: input.revisions.applicationReleaseRevision,
    }),
    navigation: projectNavigation(input.navigation, input.navigationDecisions),
  });

export type PageContentDiscardOutcome =
  /** Nothing was accepted or the Access version advanced: the fresh projection replaces everything. */
  | Readonly<{ kind: "discarded"; applied: PageContentProjection }>
  /** The incoming revisions already matched: the accepted projection is retained unchanged. */
  | Readonly<{ kind: "current"; retained: PageContentProjection }>
  /** The incoming Access version is older: the payload is refused and the accepted state retained. */
  | Readonly<{ kind: "stale"; retained: PageContentProjection }>
  /**
   * Same Access version, different installed release: neither is provably current, so the accepted
   * state is discarded, the payload is refused and the caller fetches a fresh projection.
   */
  | Readonly<{ kind: "conflicting" }>;

/**
 * Compares an incoming payload's revisions against the accepted projection and reprojects only when
 * Access advanced. A newer Access version discards the old navigation, field, row and control state
 * before anything is replaced (the caller drops the accepted projection and renders `applied` from
 * scratch); an equal pair keeps the accepted projection; an older Access version is refused, so
 * history, a back/forward cache or a late response can never restore older permitted content; and a
 * different release at the same Access version discards both, since neither can be proved current.
 * A direct operation still makes its own fresh owning-service decision; this only governs browser
 * content.
 */
export const discardAndReprojectPageContent = (
  accepted: PageContentProjection | undefined,
  incoming: PageContentReprojection,
): PageContentDiscardOutcome => {
  if (accepted === undefined)
    return Object.freeze({ kind: "discarded" as const, applied: projectPageContent(incoming) });
  switch (pageContentRevisionRelation(accepted.revisions, incoming.revisions)) {
    case "advanced":
      return Object.freeze({ kind: "discarded" as const, applied: projectPageContent(incoming) });
    case "conflicting":
      return Object.freeze({ kind: "conflicting" as const });
    case "current":
      return Object.freeze({ kind: "current" as const, retained: accepted });
    case "stale":
      return Object.freeze({ kind: "stale" as const, retained: accepted });
  }
};
