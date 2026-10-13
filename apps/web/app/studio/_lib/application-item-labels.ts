import { applicationSourceDocumentSchema, type ApplicationSourceDocument } from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "@vortex/ui/studio";

export type StudioItemLabelResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "invalid"; issues: readonly Readonly<{ path: string; message: string }>[] }>;

/** The one label edit: the inspector's Apply labels control and the agent rename tool both call it. */
export const applyStudioItemLabels = (
  source: ApplicationSourceDocument, selection: StudioSemanticSelection | null, label: string, description: string,
): StudioItemLabelResult => {
  const candidate = applicationSourceDocumentSchema.parse(structuredClone(source));
  if (selection?.kind === "application") {
    candidate.body.name = label.trim();
    candidate.body.description = description.trim();
  } else if (selection?.kind === "page") {
    const page = candidate.body.pages.find((item) => item.id === selection.pageAlias);
    if (page === undefined) return { kind: "not_found" };
    page.name = label.trim();
  } else return { kind: "not_found" };
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  return parsed.success ? { kind: "applied", source: parsed.data }
    : { kind: "invalid", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
};
