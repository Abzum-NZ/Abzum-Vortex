import type { ApplicationAudience } from "../../catalogue/application-link";
import type { ApplicationSourceDocument } from "../application-source-contracts";
import { sourceItemTree, type SourceItem } from "../application-composition/source-composition";
import { sourcePageDataAt } from "../application-page-slots";
import { applyDraftChange, logCompositionRefusal } from "./application-composition-commands";
import { studioPageDataRefusal } from "./application-composition-page-data";
import type {
  StudioCanvasOwner,
  StudioCompositionContext,
  StudioDraftChangeResult,
} from "./application-composition-model";
import { regions } from "./application-composition-regions";
import { sameCompositionValue } from "./composition-references";

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

/** Every page (or guided step) and layout of both sources whose blocks the edit replaced. */
const changedOwners = (
  current: ApplicationSourceDocument,
  edited: ApplicationSourceDocument,
): { owner: StudioCanvasOwner; data: Parameters<typeof studioPageDataRefusal>[2] }[] => {
  const owners: ReturnType<typeof changedOwners> = [];
  for (const page of edited.body.pages) {
    const was = current.body.pages.find((item) => item.id === page.id);
    if (was === undefined) continue;
    const composition = page.composition;
    const steps =
      "step_content" in composition ? Object.keys(composition.step_content) : [undefined];
    for (const step of steps) {
      const before = sourcePageDataAt(was, step);
      const data = sourcePageDataAt(page, step);
      if (before !== undefined && data !== undefined && !sameCompositionValue(before, data))
        owners.push({ owner: { kind: "page", pageAlias: page.id, step }, data });
    }
  }
  for (const shell of edited.body.shells) {
    const was = current.body.shells.find((item) => item.id === shell.id);
    if (was !== undefined && !sameCompositionValue(was.layout, shell.layout))
      owners.push({ owner: { kind: "layout", shellAlias: shell.id }, data: shell.layout });
  }
  return owners;
};

/**
 * A whole-source edit that replaces pages or layouts (the draft agent's page and flow tools) runs
 * the rules of the commands that make the same changes, so no route has fewer refusals: each
 * replaced page's data has the canvas's whole-page refusals (a published page, where a block may
 * leave, a form kept whole), and each block whose gate, use permission or audience changed is
 * changed by the `gate` command itself, on the edited source with the access as it was.
 */
export const applyStudioAuthoredSource = (
  context: StudioCompositionContext,
  edited: ApplicationSourceDocument,
): StudioDraftChangeResult => {
  const { source: current } = context;
  for (const { owner, data } of changedOwners(current, edited)) {
    const reason = studioPageDataRefusal(context, owner, data);
    if (reason !== undefined) {
      logCompositionRefusal("pageData", reason);
      return { kind: "refused", reason };
    }
  }
  const was = new Map(blocksOf(current).map((item) => [item.props.id, accessOf(item)]));
  if (!blocksOf(edited).some((item) => accessChange(item, was.get(item.props.id)) !== undefined))
    return { kind: "applied", source: edited };
  // The access goes back to what each block had; the command then makes each change, with its
  // own refusals.
  let source = structuredClone(edited);
  const changes: { alias: string; members: GateMembers }[] = [];
  for (const item of blocksOf(source)) {
    const members = accessChange(item, was.get(item.props.id));
    if (members === undefined) continue;
    changes.push({ alias: item.props.id, members });
    const before = was.get(item.props.id);
    const vortex = item.props.vortex;
    if (before?.gate === undefined) delete vortex.view_permission;
    else vortex.view_permission = before.gate;
    if (before?.use === undefined) delete vortex.use_permission;
    else vortex.use_permission = before.use;
    if (before?.audience === undefined) delete vortex.application_audience;
    else vortex.application_audience = before.audience;
  }
  for (const { alias, members } of changes) {
    const result = applyDraftChange(
      { ...context, source },
      { kind: "placement", placementAlias: alias },
      { kind: "gate", ...members },
    );
    if (result.kind === "refused") return result;
    if (result.kind !== "applied") {
      console.error("[studio] an edited block's access could not be checked", result.kind);
      return {
        kind: "refused",
        reason: "A block's access could not be checked, so nothing was changed.",
      };
    }
    source = result.source;
  }
  return { kind: "applied", source };
};
