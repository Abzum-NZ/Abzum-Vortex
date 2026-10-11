"use client";

import { useParams } from "next/navigation";
import { moduleRootIdSchema, organizationIdSchema } from "@vortex/contracts";

/** A separate-tab entry into the authored Module query filter editor. */
export function ModuleQueryNavigation() {
  const params = useParams<{ organizationId?: string; moduleRootId?: string }>();
  const organization = organizationIdSchema.safeParse(params.organizationId);
  const root = moduleRootIdSchema.safeParse(params.moduleRootId);
  if (!organization.success || !root.success) return null;
  const href = `/studio/modules/${encodeURIComponent(organization.data)}/${encodeURIComponent(root.data)}/queries`;
  return (
    <nav aria-label="Module tools" className="border-t border-border px-6 py-3">
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
        Edit Module query filters
      </a>
    </nav>
  );
}
