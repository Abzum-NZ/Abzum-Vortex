import "server-only";

import { loadStudioApplicationDraft } from "./studio-application-draft";
import { loadStudioOrganizationHome } from "./studio-organization-home";

export type StudioModuleOwnerResult =
  | Readonly<{ kind: "owned"; organizationId: string; applicationRootId: string }>
  | Readonly<{ kind: "unowned"; organizationId: string }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * The application whose draft uses a module: a module's editors live in that application's Studio
 * Data tab. Reads the organisation's roots and the application drafts with the builder's own access;
 * when several applications use the module, the first by name owns the link.
 */
export const loadStudioModuleOwner = async (
  organizationId: string,
  moduleRootId: string,
): Promise<StudioModuleOwnerResult> => {
  const home = await loadStudioOrganizationHome(organizationId);
  if (home.kind !== "available") return home;
  const module = home.roots.find((root) => root.kind === "module" && root.rootId === moduleRootId);
  if (module === undefined) return { kind: "unowned", organizationId: home.organizationId };
  const applications = home.roots
    .filter((root) => root.kind === "application" && root.draftRevision !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const application of applications) {
    const loaded = await loadStudioApplicationDraft(home.organizationId, application.rootId, { compile: false });
    if (loaded.kind !== "available") {
      console.error(`[studio] module owner lookup skipped application ${application.rootId}: ${loaded.kind}`);
      continue;
    }
    if (loaded.draft.source.body.module_bindings.some((binding) => binding.module === module.key))
      return { kind: "owned", organizationId: home.organizationId, applicationRootId: application.rootId };
  }
  return { kind: "unowned", organizationId: home.organizationId };
};
