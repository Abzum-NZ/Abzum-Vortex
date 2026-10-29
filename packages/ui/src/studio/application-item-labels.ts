import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "./semantic-selection";

export type StudioItemLabelResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "invalid"; issues: readonly Readonly<{ path: string; message: string }>[] }>;

type Navigation = ApplicationSourceDocument["body"]["navigation"];

/** Menu entries that follow a page's name (their label is the page's old name) take its new name. */
const renameMenuEntries = (
  items: Navigation,
  pageKey: string,
  previous: string,
  next: string,
): void => {
  for (const item of items) {
    if (item.type === "page" && item.page === pageKey && item.label === previous) item.label = next;
    if (item.type === "heading") renameMenuEntries(item.children, pageKey, previous, next);
  }
};

/**
 * The one label edit: the inspector's Apply labels control, the Structure tab's rename and the agent
 * rename tool all call it. A page's menu entries that still carry its name follow the new name.
 */
export const applyStudioItemLabels = (
  source: ApplicationSourceDocument,
  selection: StudioSemanticSelection | null,
  label: string,
  description: string,
): StudioItemLabelResult => {
  const candidate = applicationSourceDocumentSchema.parse(structuredClone(source));
  if (selection?.kind === "application") {
    candidate.body.name = label.trim();
    candidate.body.description = description.trim();
  } else if (selection?.kind === "page") {
    const page = candidate.body.pages.find((item) => item.id === selection.pageAlias);
    if (page === undefined) return { kind: "not_found" };
    renameMenuEntries(candidate.body.navigation, page.key, page.name, label.trim());
    page.name = label.trim();
  } else if (selection?.kind === "shell") {
    const shell = candidate.body.shells.find((item) => item.id === selection.shellAlias);
    if (shell === undefined) return { kind: "not_found" };
    shell.name = label.trim();
  } else return { kind: "not_found" };
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  return parsed.success
    ? { kind: "applied", source: parsed.data }
    : {
        kind: "invalid",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      };
};
