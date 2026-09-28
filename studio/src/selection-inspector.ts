import {
  applicationRootIdSchema,
  applicationSourceDocumentV2Schema,
  type ApplicationRootId,
  type ApplicationSourceDocumentV2,
} from "@vortex/contracts";
import type { StudioApplicationDraftHistoryState } from "./application-draft-history";
import type { StudioSemanticSelection } from "./semantic-selection";

export type StudioSelectionInspectorDescriptor = Readonly<{
  applicationRootId: ApplicationRootId;
  alias: string;
  kind: StudioSemanticSelection["kind"];
  label: string;
  /** RFC 6901 JSON pointer into the authored Application source document. */
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
  | Readonly<{ kind: "flow"; alias: string }>
  | Readonly<{ kind: "placement"; alias: string }>;

const result = <Resolution extends StudioSelectionInspectorResolution>(
  resolution: Resolution,
): Resolution => Object.freeze(resolution);

const refused = (
  reason: Extract<StudioSelectionInspectorResolution, { status: "refused" }>["reason"],
): StudioSelectionInspectorResolution => result({ status: "refused", reason });

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
  if (!isObjectRecord(selection)) return undefined;

  switch (selection.kind) {
    case "application": {
      if (!hasExactKeys(selection, ["kind", "applicationRootId"])) return undefined;
      const parsedRoot = applicationRootIdSchema.safeParse(selection.applicationRootId);
      return parsedRoot.success
        ? Object.freeze({ kind: "application", applicationRootId: parsedRoot.data })
        : undefined;
    }
    case "page":
    case "shell":
    case "navigation":
    case "flow":
    case "placement": {
      const aliasField =
        selection.kind === "navigation"
          ? "navigationItemAlias"
          : selection.kind === "flow"
            ? "flowAlias"
            : selection.kind === "placement"
              ? "placementAlias"
              : selection.kind === "shell"
                ? "shellAlias"
                : "pageAlias";
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

const readableKey = (key: string): string =>
  key.replace(/[._:/-]+/g, " ").replace(/\s+/g, " ").trim() || key;

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
  source: ApplicationSourceDocumentV2,
  alias: string,
): InspectorCandidate[] => {
  const matches: InspectorCandidate[] = [];
  const visitSlot = (
    slot: ApplicationSourceDocumentV2["body"]["shells"][number]["layout"],
    path: SourcePath,
  ): void => {
    for (const [placementAlias, placement] of Object.entries(slot.placements)) {
      const placementPath = [...path, "placements", placementAlias] as const;
      if (placementAlias === alias)
        matches.push({
          alias: placementAlias,
          label: readableKey(placement.block.block_id),
          sourcePath: placementPath,
        });
      for (const [slotKey, childSlot] of Object.entries(placement.slots))
        visitSlot(childSlot, [...placementPath, "slots", slotKey]);
    }
  };

  source.body.shells.forEach((shell, index) =>
    visitSlot(shell.layout, ["body", "shells", index, "layout"]),
  );

  source.body.pages.forEach((page, index) => {
    const pagePath = ["body", "pages", index] as const;
    const composition = page.composition;
    if ("step_content" in composition) {
      for (const [stepAlias, content] of Object.entries(composition.step_content)) {
        if (composition.shell_kind === "default") {
          visitSlot(content, [...pagePath, "composition", "step_content", stepAlias]);
        } else {
          for (const [slotAlias, slot] of Object.entries(content))
            visitSlot(slot, [
              ...pagePath,
              "composition",
              "step_content",
              stepAlias,
              slotAlias,
            ]);
        }
      }
    } else if (composition.shell_kind === "default") {
      visitSlot(composition.main, [...pagePath, "composition", "main"]);
    } else {
      for (const [slotAlias, slot] of Object.entries(composition.content))
        visitSlot(slot, [...pagePath, "composition", "content", slotAlias]);
    }
  });

  return matches;
};

/**
 * Resolves one shared semantic selection against the supplied Application draft.
 * The returned descriptor contains only frozen identity and display metadata; it never
 * retains the authored source object or carries permission state.
 */
export const resolveStudioSelectionInspectorContext = (
  draft: Pick<StudioApplicationDraftHistoryState, "rootId" | "source">,
  selection: StudioSemanticSelection | null,
): StudioSelectionInspectorResolution => {
  try {
    if (!isObjectRecord(draft)) return refused("invalid_context");
    const parsedRoot = applicationRootIdSchema.safeParse(draft.rootId);
    if (!parsedRoot.success) return refused("invalid_context");

    const parsedSource = applicationSourceDocumentV2Schema.safeParse(draft.source);
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
          items: ApplicationSourceDocumentV2["body"]["navigation"],
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
        candidates = source.body.flows.flatMap((flow, index) =>
          flow.id === parsedSelection.alias
            ? [{
                alias: flow.id,
                label: flow.description?.trim() || readableKey(flow.key),
                sourcePath: ["body", "flows", index],
              }]
            : [],
        );
        break;
      case "placement":
        candidates = placementCandidates(source, parsedSelection.alias);
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
