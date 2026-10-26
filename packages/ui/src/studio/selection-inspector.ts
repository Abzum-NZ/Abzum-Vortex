import {
  applicationRootIdSchema,
  applicationSourceDocumentSchema,
  sourceItemChildSlots,
  sourcePageZones,
  type ApplicationRootId,
  type ApplicationSourceDocument,
  type SourceItem,
  type SourcePageData,
  isRecord,
} from "@vortex/platform/schema";
import { studioFlowLabel, studioFlowTaskEntries, type StudioSemanticSelection } from "./semantic-selection";

/** The current Application draft, whether supplied by history or a direct source load. */
export type StudioSelectionInspectorDraft = Readonly<{
  rootId: ApplicationRootId;
  source: unknown;
}>;

export type StudioSelectionInspectorDescriptor = Readonly<{
  applicationRootId: ApplicationRootId;
  alias: string;
  kind: StudioSemanticSelection["kind"];
  label: string;
  /** RFC 6901 JSON pointer into this draft; the alias is the identity across edits. */
  sourcePath: string;
}>;

export type StudioSelectionInspectorResolution =
  | Readonly<{ status: "resolved"; descriptor: StudioSelectionInspectorDescriptor }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "refused";
      reason: "invalid_context" | "invalid_selection" | "cross_root" | "ambiguous_selection";
    }>;

type SourcePath = readonly (string | number)[];

type InspectorCandidate = Readonly<{
  alias: string;
  label: string;
  sourcePath: SourcePath;
}>;

type ParsedSelection =
  | Readonly<{ kind: "application"; applicationRootId: string }>
  | Readonly<{ kind: "page"; alias: string }>
  | Readonly<{ kind: "shell"; alias: string }>
  | Readonly<{ kind: "navigation"; alias: string }>
  | Readonly<{ kind: "flow"; alias: string; moduleKey: string | null }>
  | Readonly<{ kind: "flow_step"; alias: string; moduleKey: string | null; taskId: string }>
  | Readonly<{ kind: "placement"; alias: string }>
  | Readonly<{ kind: "role"; alias: string }>;

const result = <Resolution extends StudioSelectionInspectorResolution>(
  resolution: Resolution,
): Resolution => Object.freeze(resolution);

const refused = (
  reason: Extract<StudioSelectionInspectorResolution, { status: "refused" }>["reason"],
): StudioSelectionInspectorResolution => result({ status: "refused", reason });


const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => typeof key === "string" && expected.includes(key))
  );
};

const parseSelection = (
  selection: unknown,
): ParsedSelection | null | undefined => {
  if (selection === null) return null;
  if (!isRecord(selection)) return undefined;

  switch (selection.kind) {
    case "application": {
      if (!hasExactKeys(selection, ["kind", "applicationRootId"])) return undefined;
      const parsedRoot = applicationRootIdSchema.safeParse(selection.applicationRootId);
      return parsedRoot.success
        ? Object.freeze({ kind: "application", applicationRootId: parsedRoot.data })
        : undefined;
    }
    case "flow": {
      if (!hasExactKeys(selection, ["kind", "flowAlias", "moduleKey"])) return undefined;
      const { flowAlias, moduleKey } = selection;
      if (typeof flowAlias !== "string" || flowAlias.length === 0 ||
        (moduleKey !== null && typeof moduleKey !== "string")) return undefined;
      return Object.freeze({ kind: "flow", alias: flowAlias, moduleKey });
    }
    case "flow_step": {
      if (!hasExactKeys(selection, ["kind", "flowAlias", "moduleKey", "taskId"])) return undefined;
      const { flowAlias, moduleKey, taskId } = selection;
      if (typeof flowAlias !== "string" || flowAlias.length === 0 || typeof taskId !== "string" || taskId.length === 0 ||
        (moduleKey !== null && typeof moduleKey !== "string")) return undefined;
      return Object.freeze({ kind: "flow_step", alias: flowAlias, moduleKey, taskId });
    }
    case "page":
    case "shell":
    case "navigation":
    case "placement":
    case "role": {
      const aliasField =
        selection.kind === "navigation"
          ? "navigationItemAlias"
          : selection.kind === "placement"
              ? "placementAlias"
              : selection.kind === "shell"
                ? "shellAlias"
                : selection.kind === "role" ? "roleKey" : "pageAlias";
      if (!hasExactKeys(selection, ["kind", aliasField])) return undefined;
      const alias =
        selection[aliasField];
      if (typeof alias !== "string" || alias.length === 0) return undefined;
      return Object.freeze({ kind: selection.kind, alias }) as ParsedSelection;
    }
    default:
      return undefined;
  }
};

const jsonPointer = (path: SourcePath): string =>
  path.length === 0
    ? ""
    : `/${path
        .map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1"))
        .join("/")}`;

const readableKey = (value: string, fallback: string): string => {
  const key = value.trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (!key) return fallback;
  return key[0]!.toUpperCase() + key.slice(1);
};

const resolved = (
  applicationRootId: ApplicationRootId,
  kind: StudioSemanticSelection["kind"],
  candidate: InspectorCandidate,
): StudioSelectionInspectorResolution =>
  result({
    status: "resolved",
    descriptor: Object.freeze({
      applicationRootId,
      alias: candidate.alias,
      kind,
      label: candidate.label,
      sourcePath: jsonPointer(candidate.sourcePath),
    }),
  });

const onlyMatch = (
  candidates: readonly InspectorCandidate[],
): InspectorCandidate | null | undefined => {
  if (candidates.length === 0) return null;
  return candidates.length === 1 ? candidates[0] : undefined;
};

const placementCandidates = (
  source: ApplicationSourceDocument,
  alias: string,
): InspectorCandidate[] => {
  const matches: InspectorCandidate[] = [];
  const visitItems = (items: readonly SourceItem[], path: SourcePath): void => {
    items.forEach((item, index) => {
      const itemPath = [...path, index] as const;
      if (item.props.id === alias)
        matches.push({
          alias: item.props.id,
          label: `Item ${readableKey(item.props.id, "item")}`,
          sourcePath: itemPath,
        });
      for (const [slotKey, children] of sourceItemChildSlots(item))
        visitItems(children, [...itemPath, "props", slotKey]);
    });
  };
  const visitData = (data: SourcePageData, path: SourcePath): void => {
    for (const [zone, items] of sourcePageZones(data))
      visitItems(items, zone === "content" ? [...path, "content"] : [...path, "root", "props", zone]);
  };

  source.body.shells.forEach((shell, index) =>
    visitItems(shell.layout.content, ["body", "shells", index, "layout", "content"]),
  );

  source.body.pages.forEach((page, index) => {
    const compositionPath = ["body", "pages", index, "composition"] as const;
    if (page.type === "guided_form") {
      for (const [stepAlias, data] of Object.entries(page.composition.step_content))
        visitData(data, [...compositionPath, "step_content", stepAlias]);
    } else visitData(page.composition, compositionPath);
  });

  return matches;
};

/**
 * Resolves one shared semantic selection against the supplied Application draft.
 * The returned descriptor contains only frozen identity and display metadata; it never
 * retains the authored source object or carries permission state.
 */
export const resolveStudioSelectionInspectorContext = (
  draft: StudioSelectionInspectorDraft,
  selection: StudioSemanticSelection | null,
): StudioSelectionInspectorResolution => {
  try {
    if (!isRecord(draft)) return refused("invalid_context");
    const parsedRoot = applicationRootIdSchema.safeParse(draft.rootId);
    if (!parsedRoot.success) return refused("invalid_context");

    const parsedSource = applicationSourceDocumentSchema.safeParse(draft.source);
    if (!parsedSource.success) return refused("invalid_context");
    const source = parsedSource.data;
    const parsedSelection = parseSelection(selection);
    if (parsedSelection === undefined) return refused("invalid_selection");
    if (parsedSelection === null) return result({ status: "empty" });

    if (parsedSelection.kind === "application") {
      if (parsedSelection.applicationRootId !== parsedRoot.data) return refused("cross_root");
      return resolved(parsedRoot.data, "application", {
        alias: source.root_alias,
        label: source.body.name,
        sourcePath: [],
      });
    }

    let candidates: InspectorCandidate[];
    switch (parsedSelection.kind) {
      case "page":
        candidates = source.body.pages.flatMap((page, index) =>
          page.id === parsedSelection.alias
            ? [{
                alias: page.id,
                label: page.name,
                sourcePath: ["body", "pages", index],
              }]
            : [],
        );
        break;
      case "shell":
        candidates = source.body.shells.flatMap((shell, index) =>
          shell.id === parsedSelection.alias
            ? [{
                alias: shell.id,
                label: shell.name,
                sourcePath: ["body", "shells", index],
              }]
            : [],
        );
        break;
      case "navigation": {
        candidates = [];
        const visitNavigation = (
          items: ApplicationSourceDocument["body"]["navigation"],
          path: SourcePath,
        ): void => {
          items.forEach((item, index) => {
            const itemPath = [...path, index] as const;
            if (item.id === parsedSelection.alias)
              candidates.push({ alias: item.id, label: item.label, sourcePath: itemPath });
            if (item.type === "heading")
              visitNavigation(item.children, [...itemPath, "children"]);
          });
        };
        visitNavigation(source.body.navigation, ["body", "navigation"]);
        break;
      }
      case "flow":
      case "flow_step": {
        const moduleIndex = parsedSelection.moduleKey === null ? -1
          : source.body.modules.findIndex((module) => module.key === parsedSelection.moduleKey);
        const owner = parsedSelection.moduleKey === null ? source.body.flows : source.body.modules[moduleIndex]?.flows ?? [];
        const ownerPath: SourcePath = parsedSelection.moduleKey === null ? ["body", "flows"]
          : ["body", "modules", moduleIndex, "flows"];
        candidates = owner.flatMap((flow, index): InspectorCandidate[] => {
          if (flow.id !== parsedSelection.alias) return [];
          if (parsedSelection.kind === "flow")
            return [{ alias: flow.id, label: studioFlowLabel(flow), sourcePath: [...ownerPath, index] }];
          return studioFlowTaskEntries(flow).filter(({ task }) => task.id === parsedSelection.taskId)
            .map(({ task, path }) => ({ alias: task.id, label: `${studioFlowLabel(flow)}: ${readableKey(task.type, "Step")}`,
              sourcePath: [...ownerPath, index, ...path] }));
        });
        break;
      }
      case "placement":
        candidates = placementCandidates(source, parsedSelection.alias);
        break;
      case "role":
        candidates = source.body.roles.flatMap((role, index) => role.key === parsedSelection.alias
          ? [{ alias: role.key, label: role.name, sourcePath: ["body", "roles", index] }] : []);
        break;
    }

    const candidate = onlyMatch(candidates);
    if (candidate === null) return result({ status: "missing" });
    if (candidate === undefined) return refused("ambiguous_selection");
    return resolved(parsedRoot.data, parsedSelection.kind, candidate);
  } catch {
    return refused("invalid_context");
  }
};
