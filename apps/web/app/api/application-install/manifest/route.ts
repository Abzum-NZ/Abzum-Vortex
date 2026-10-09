import { applicationInstallAddressSchema } from "@vortex/app";
import { fingerprintSchema, revisionSchema } from "@vortex/contracts";
import { loadApplicationInstallMetadata } from "../../../_lib/application-install-metadata";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const privateHeaders = {
  "Cache-Control": "private, no-store, must-revalidate",
  "Vary": "Cookie",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const unavailable = (temporary = false) => new Response("Install metadata is unavailable.", {
  status: temporary ? 503 : 404, headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" },
});

export async function GET(request: Request): Promise<Response> {
  if (request.url.length > 2_048) return unavailable();
  const query = new URL(request.url).searchParams;
  const fields = ["tenantShortName", "organizationShortName", "applicationKey",
    "applicationReleaseRevision", "snapshot"];
  if ([...query.keys()].length !== fields.length ||
      fields.some((key) => query.getAll(key).length !== 1) ||
      [...query.keys()].some((key) => !fields.includes(key))) return unavailable();
  const address = applicationInstallAddressSchema.safeParse({ tenantShortName: query.get("tenantShortName"),
    organizationShortName: query.get("organizationShortName"), applicationKey: query.get("applicationKey") });
  const revisionText = query.get("applicationReleaseRevision") ?? "";
  const revision = revisionSchema.safeParse(Number(revisionText));
  const snapshot = fingerprintSchema.safeParse(query.get("snapshot"));
  if (!address.success || !/^[1-9][0-9]*$/.test(revisionText) || !revision.success || !snapshot.success)
    return unavailable();
  const result = await loadApplicationInstallMetadata(address.data,
    { applicationReleaseRevision: revision.data, snapshot: snapshot.data }, request.signal);
  if (result.kind !== "available") return unavailable(result.kind === "temporarily_unavailable");
  if (request.signal.aborted || Date.now() >= Date.parse(result.validUntil)) return unavailable();
  return new Response(JSON.stringify(result.manifest), { headers: {
    ...privateHeaders, "Content-Type": "application/manifest+json; charset=utf-8",
    "X-Vortex-Install-Valid-Until": result.validUntil,
    "X-Vortex-Install-Snapshot": result.snapshot,
  } });
}
