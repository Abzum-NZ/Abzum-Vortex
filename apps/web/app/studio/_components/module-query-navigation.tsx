"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { moduleRootIdSchema, organizationIdSchema } from "@vortex/platform/schema";

/** An entry into the module's saved view filter editor. */
export function ModuleQueryNavigation() {
  const params = useParams<{ organizationId?: string; moduleRootId?: string }>();
  const organization = organizationIdSchema.safeParse(params.organizationId);
  const root = moduleRootIdSchema.safeParse(params.moduleRootId);
  if (!organization.success || !root.success) return null;
  const href = `/studio/modules/${encodeURIComponent(organization.data)}/${encodeURIComponent(root.data)}/queries`;
  return (
    <nav aria-label="Module tools" className="border-t border-border px-6 py-3">
      <Link href={href} className="underline">
        Edit saved view filters
      </Link>
    </nav>
  );
}
