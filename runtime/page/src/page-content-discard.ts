import "server-only";

import type { NavigationItem } from "@vortex/contracts";
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
 */
export type PageContentRevisions = Readonly<{
  accessVersion: number;
  applicationReleaseRevision: number;
}>;

export type PageContentRevisionRelation = "stale" | "current" | "advanced";

/**
 * Reads the revisions a projected page declares. Anything missing, malformed or non-numeric is
 * `undefined`, so a caller can refuse it as unusable instead of trusting a look-alike payload.
 */
export const readPageContentRevisions = (
  projection: ProjectedPageCapability,
): PageContentRevisions | undefined => {
  if (projection === undefined) return undefined;
  const accessVersion = projection.accessVersion;
  const applicationReleaseRevision = projection.applicationReleaseRevision;
  return typeof accessVersion === "number" && typeof applicationReleaseRevision === "number"
    ? { accessVersion, applicationReleaseRevision }
    : undefined;
};

/**
 * Relates an incoming revision pair to the one already accepted. Equal is `current`; a pair that is
 * newer in either dimension and older in neither is `advanced`; a pair older in either dimension is
 * `stale`, so a mixed or rewound pair fails closed and can never restore withdrawn content.
 */
export const pageContentRevisionRelation = (
  accepted: PageContentRevisions,
  incoming: PageContentRevisions,
): PageContentRevisionRelation => {
  if (
    incoming.accessVersion < accepted.accessVersion ||
    incoming.applicationReleaseRevision < accepted.applicationReleaseRevision
  )
    return "stale";
  return incoming.accessVersion === accepted.accessVersion &&
    incoming.applicationReleaseRevision === accepted.applicationReleaseRevision
    ? "current"
    : "advanced";
};

/** True only when an incoming payload is older in at least one revision than the accepted one. */
export const isStalePageContentRevision = (
  accepted: PageContentRevisions,
  incoming: PageContentRevisions,
): boolean => pageContentRevisionRelation(accepted, incoming) === "stale";

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
  /** The incoming revisions advanced: their fresh projections replace every accepted value. */
  | Readonly<{ kind: "discarded"; applied: PageContentProjection }>
  /** The incoming revisions already matched: the accepted projection is retained unchanged. */
  | Readonly<{ kind: "current"; retained: PageContentProjection }>
  /** The incoming revisions are older: the payload is refused and the accepted state retained. */
  | Readonly<{ kind: "stale"; retained: PageContentProjection }>;

/**
 * Compares an incoming payload's revisions against the accepted projection and reprojects only when
 * access or the installed release advanced. A newer pair discards the old navigation, field, row
 * and control state (the caller drops the retained projection and renders `applied` from scratch);
 * an equal pair keeps the accepted projection; an older pair is refused, so history, a
 * back/forward cache or a late response can never restore older permitted content. A direct
 * operation still makes its own fresh owning-service decision; this only governs browser content.
 */
export const discardAndReprojectPageContent = (
  accepted: PageContentProjection | undefined,
  incoming: PageContentReprojection,
): PageContentDiscardOutcome => {
  if (accepted === undefined)
    return Object.freeze({
      kind: "discarded" as const,
      applied: projectPageContent(incoming),
    });
  const relation = pageContentRevisionRelation(accepted.revisions, incoming.revisions);
  if (relation === "stale")
    return Object.freeze({ kind: "stale" as const, retained: accepted });
  if (relation === "current")
    return Object.freeze({ kind: "current" as const, retained: accepted });
  return Object.freeze({
    kind: "discarded" as const,
    applied: projectPageContent(incoming),
  });
};
