import type {
  ApplicationPlaceOpen,
  ApplicationRootId,
  ApplicationUseTarget,
} from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "@vortex/ui/studio";
import type { StudioRailKey } from "../_components/studio-rail-tabs";

/**
 * How Studio goes to a place of the draft's reference index: the selection that shows it, and the
 * rail tab that edits that selection. Every "Used in" entry and every "Show me where" link opens its
 * place through these, into the workspace's one selection store.
 */

/** The selection that shows a place, or null when Studio cannot open it. */
export const studioPlaceSelection = (
  open: ApplicationPlaceOpen,
  rootId: ApplicationRootId,
): StudioSemanticSelection | null =>
  open.kind === "none"
    ? null
    : open.kind === "application"
      ? { kind: "application", applicationRootId: rootId }
      : open;

/** The rail tab that edits a selection. */
export const studioTabOfSelection = (selection: StudioSemanticSelection): StudioRailKey => {
  switch (selection.kind) {
    case "navigation":
      return "menu";
    case "flow":
    case "flow_step":
      return "flows";
    case "module":
    case "record_type":
    case "field":
    case "query":
      return "data";
    case "role":
      return "access";
    case "application":
    case "page":
    case "shell":
    case "placement":
      return "structure";
  }
};

/** What a selection's "Used in" section lists the uses of, when other parts of the draft can use it. */
export const studioUseTargetOf = (
  selection: StudioSemanticSelection | null,
): ApplicationUseTarget | null => {
  switch (selection?.kind) {
    case "page":
      return { kind: "page", pageAlias: selection.pageAlias };
    case "navigation":
      return { kind: "navigation", navigationItemAlias: selection.navigationItemAlias };
    case "flow":
    case "flow_step":
      return { kind: "flow", flowAlias: selection.flowAlias, moduleKey: selection.moduleKey };
    case "record_type":
      return {
        kind: "record_type",
        moduleKey: selection.moduleKey,
        recordKey: selection.recordKey,
      };
    case "field":
      return {
        kind: "field",
        moduleKey: selection.moduleKey,
        recordKey: selection.recordKey,
        fieldKey: selection.fieldKey,
      };
    case "query":
      return { kind: "query", moduleKey: selection.moduleKey, queryKey: selection.queryKey };
    default:
      return null;
  }
};
