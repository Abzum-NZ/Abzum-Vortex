import type { ApplicationAudience } from "../../catalogue/application-link";
import type { ApplicationSourceDocument } from "../application-source-contracts";
import {
  sourceItemTree,
  sourcePageItems,
  sourcePageZones,
  type SourceItem,
  type SourceZonedData,
} from "../application-composition/source-composition";
import { sourcePageDataAt } from "../application-page-slots";
import { applyDraftChange, logCompositionRefusal } from "./application-composition-commands";
import { studioWorkflowRemovalRefusal } from "./application-composition-gate";
import {
  studioNewPageDataRefusal,
  studioPageDataRefusal,
} from "./application-composition-page-data";
import type {
  StudioCanvasOwner,
  StudioCompositionContext,
  StudioDraftChangeResult,
} from "./application-composition-model";
import { regions } from "./application-composition-regions";
import { sameCompositionValue } from "./composition-references";
import { studioRemovalRefusal } from "./studio-canvas-permissions";

type Access = Readonly<{
  gate: string | undefined;
  use: string | undefined;
  audience: ApplicationAudience | undefined;
}>;
type GateMembers = {
  gate?: string | null;
  use?: string | null;
  audience?: ApplicationAudience | null;
};
type OwnedData = Readonly<{ owner: StudioCanvasOwner; data: SourceZonedData }>;

const blocksOf = (source: ApplicationSourceDocument): SourceItem[] =>
  regions(source).flatMap((region) => sourceItemTree(region.zone.items));

const accessOf = (item: SourceItem): Access => {
  const vortex = item.props.vortex;
  return {
    gate: vortex.view_permission,
    use: vortex.use_permission,
    audience: vortex.application_audience,
  };
};

/** The members of the block's access that differ from the access it had, as a `gate` command. */
const accessChange = (item: SourceItem, was: Access | undefined): GateMembers | undefined => {
  const now = accessOf(item);
  const change: GateMembers = {};
  if (now.gate !== was?.gate) change.gate = now.gate ?? null;
  if (now.use !== was?.use) change.use = now.use ?? null;
  if (now.audience !== was?.audience) change.audience = now.audience ?? null;
  return Object.keys(change).length === 0 ? undefined : change;
};

/** The data of each step of a page (its one data when it has no steps). */
const pageData = (page: ApplicationSourceDocument["body"]["pages"][number]): OwnedData[] => {
  const composition = page.composition;
  const steps = "step_content" in composition ? Object.keys(composition.step_content) : [undefined];
  return steps.flatMap((step) => {
    const data = sourcePageDataAt(page, step);
    return data === undefined ? [] : [{ owner: { kind: "page", pageAlias: page.id, step }, data }];
  });
};

/** Every page, guided step and layout of a draft, with its data. */
const ownedData = (source: ApplicationSourceDocument): OwnedData[] => [
  ...source.body.pages.flatMap(pageData),
  ...source.body.shells.map((shell): OwnedData => ({
    owner: { kind: "layout", shellAlias: shell.id },
    data: shell.layout,
  })),
];

const ownerKey = (owner: StudioCanvasOwner): string =>
  owner.kind === "layout"
    ? `layout:${owner.shellAlias}`
    : `page:${owner.pageAlias}:${owner.step ?? ""}`;

/**
 * Why the edited pages, steps and layouts may not replace the current ones, or undefined: a
 * changed one has the canvas's whole-page refusals, a new one those of blocks added, and the
 * blocks of a step the edit drops leave only where every removal route lets them. A page or layout
 * deleted whole is judged by the platform review (what still names it is refused there).
 */
const pageDataRefusal = (
  context: StudioCompositionContext,
  edited: ApplicationSourceDocument,
): string | undefined => {
  const { catalogue, source: current } = context;
  const was = new Map(ownedData(current).map(({ owner, data }) => [ownerKey(owner), data]));
  const kept = new Set<string>();
  for (const { owner, data } of ownedData(edited)) {
    const key = ownerKey(owner);
    kept.add(key);
    const before = was.get(key);
    const reason =
      before === undefined
        ? studioNewPageDataRefusal(context, edited, owner, data)
        : sameCompositionValue(before, data)
          ? undefined
          : studioPageDataRefusal(context, owner, data);
    if (reason !== undefined) return reason;
  }
  for (const page of current.body.pages) {
    const now = edited.body.pages.find((item) => item.id === page.id);
    const dropped = pageData(page).filter(({ owner }) => !kept.has(ownerKey(owner)));
    if (now === undefined || dropped.length === 0) continue;
    const stays = new Set(sourcePageItems(now.composition).map((item) => item.props.id));
    const leaving = new Set(
      dropped.flatMap(({ data }) =>
        sourcePageZones(data)
          .flatMap(([, items]) => sourceItemTree(items))
          .map((item) => item.props.id)
          .filter((alias) => !stays.has(alias)),
      ),
    );
    const gone = leaving.size === 0 ? undefined : studioRemovalRefusal(catalogue, current, leaving);
    if (gone !== undefined) return gone;
  }
  return undefined;
};

/**
 * A whole-source edit that replaces pages or layouts (the draft agent's page and flow tools) runs
 * the rules of the commands that make the same changes, so no route has fewer refusals: the
 * whole-page refusals above, no block losing its last workflow while it keeps a use permission,
 * and each block whose gate, use permission or audience changed is changed by the `gate` command
 * itself, on a copy of the edited source with the access as it was. Nothing is applied unless
 * every check passes.
 */
export const applyStudioAuthoredSource = (
  context: StudioCompositionContext,
  edited: ApplicationSourceDocument,
): StudioDraftChangeResult => {
  const reason =
    pageDataRefusal(context, edited) ?? studioWorkflowRemovalRefusal(context.source, edited);
  if (reason !== undefined) {
    logCompositionRefusal("pages", reason);
    return { kind: "refused", reason };
  }
  const was = new Map(blocksOf(context.source).map((item) => [item.props.id, accessOf(item)]));
  const changes = new Map<string, GateMembers>();
  for (const item of blocksOf(edited)) {
    const members = accessChange(item, was.get(item.props.id));
    if (members !== undefined) changes.set(item.props.id, members);
  }
  if (changes.size === 0) return { kind: "applied", source: edited };
  // The access goes back to what each block had; the command then makes each change, with its
  // own refusals.
  let source = structuredClone(edited);
  for (const item of blocksOf(source)) {
    if (!changes.has(item.props.id)) continue;
    const before = was.get(item.props.id);
    const vortex = item.props.vortex;
    if (before?.gate === undefined) delete vortex.view_permission;
    else vortex.view_permission = before.gate;
    if (before?.use === undefined) delete vortex.use_permission;
    else vortex.use_permission = before.use;
    if (before?.audience === undefined) delete vortex.application_audience;
    else vortex.application_audience = before.audience;
  }
  for (const [alias, members] of changes) {
    const result = applyDraftChange(
      { ...context, source },
      { kind: "placement", placementAlias: alias },
      { kind: "gate", ...members },
    );
    // A refusal is logged by the command; anything else is a fault it logged.
    if (result.kind !== "applied") return result;
    source = result.source;
  }
  return { kind: "applied", source };
};
