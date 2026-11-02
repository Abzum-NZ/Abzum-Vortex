import "server-only";

import {
  applicationRootIdSchema,
  organizationIdSchema,
  organizationSelectionCandidateSchema,
} from "@vortex/platform/schema";
import { readCurrentOrganizationAppStoreAddressAfterAuthorization } from "@vortex/platform/server";
import type { PlacementFlowBinding } from "@vortex/ui";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { resolveApplicationAddress } from "./application-address";
import { appStoreApplicationPageKey } from "./application-release-adoption";
import { loadApplicationPage } from "./application-page";
import { pageSubjectParameter } from "./application-page/placement-helpers";
import { loadOrganizationLauncher } from "./organization-context";
import { humanOrganizationRequests } from "./server-composition";
import { studioActionTokens, type StudioActionToken } from "./studio-action-tokens";

/**
 * What the editor needs to start one of the App Store's action flows in place: the page and record
 * the flows are addressed through, and the bindings that page projects for this person.
 */
export type StudioActionFlows = Readonly<{
  address: Readonly<{
    tenantShortName: string;
    organizationShortName: string;
    applicationKey: string;
    pageKey: string;
    pageRecordId: string;
  }>;
  /** The address parameters the page is opened with: the record it is about. */
  pageParameters: Readonly<Record<string, string>>;
  subject: Readonly<{ recordId: string; revision: number }>;
  flowTimeZone: string | undefined;
  /** Every placement's bindings, authored and derived (a message's action), by placement. */
  bindings: Readonly<Record<string, readonly PlacementFlowBinding[]>>;
  /** The binding each action is started through, by action. */
  startable: Readonly<
    Partial<Record<StudioActionToken, Readonly<{ placementId: string; bindingId: string }>>>
  >;
  /** The organisation's pages of the App Store, for a flow step that opens one. */
  pages: readonly Readonly<{ pageId: string; key: string }>[];
}>;

export type StudioActionFlowsResult =
  | Readonly<{ kind: "available"; flows: StudioActionFlows }>
  | Readonly<{ kind: "refused" | "unavailable" | "temporarily_unavailable" }>;

/**
 * Reads the App Store's page for one application, as the signed-in person sees it, and answers
 * which of its action bindings the editor may start. Nothing is started here: the flows run
 * through the same invoke endpoint as a press on that page, which decides everything again.
 */
export const readStudioActionFlows = async (
  candidateOrganizationId: string,
  candidateRootId: string,
): Promise<StudioActionFlowsResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = applicationRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success) return { kind: "refused" };
  const resolved = await resolveIdentitySession();
  if (resolved.kind !== "active")
    return { kind: resolved.kind === "temporarily_unavailable" ? resolved.kind : "refused" };
  const { session } = resolved;
  const launcher = await loadOrganizationLauncher(session);
  const entry =
    launcher.kind === "available"
      ? launcher.entries.find(
          (candidate) => candidate.organizationId.toLowerCase() === organization.data.toLowerCase(),
        )
      : undefined;
  if (entry === undefined) return { kind: "refused" };
  const appStore = await humanOrganizationRequests().run(
    session,
    organizationSelectionCandidateSchema.parse({ organizationId: organization.data }),
    (transaction) => readCurrentOrganizationAppStoreAddressAfterAuthorization(transaction),
  );
  if (appStore.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  if (appStore.kind !== "available" || appStore.value === null || appStore.value === "invalid") {
    console.error(
      `[studio] action flows: App Store address ${appStore.kind === "available" ? (appStore.value ?? "not set") : appStore.kind}`,
    );
    return { kind: "unavailable" };
  }
  const addressed = await resolveApplicationAddress(
    session,
    entry.tenantShortName,
    entry.organizationShortName,
    appStore.value,
    appStoreApplicationPageKey,
  );
  if (addressed.kind === "temporarily_unavailable") return addressed;
  if (addressed.kind !== "application_page") return { kind: "unavailable" };
  // The page is projected as the person would open it: its bindings are those of the controls it shows them.
  const page = await loadApplicationPage(
    session,
    {
      tenantShortName: entry.tenantShortName,
      organizationShortName: entry.organizationShortName,
      read: addressed.read,
      application: addressed.application,
      pageKey: addressed.pageKey,
      ...(addressed.installedContext === undefined
        ? {}
        : { installedContext: addressed.installedContext }),
      ...(addressed.navigation === undefined ? {} : { navigation: addressed.navigation }),
    },
    { [pageSubjectParameter]: root.data },
    { includeNavigation: false },
  );
  if (page.kind === "temporarily_unavailable") return page;
  const subject = page.kind === "available" ? page.model.subject : undefined;
  if (page.kind !== "available" || subject === undefined) {
    console.error(`[studio] action flows: the App Store page answered ${page.kind}`);
    return { kind: "unavailable" };
  }
  const { model } = page;
  const startable: Partial<Record<StudioActionToken, { placementId: string; bindingId: string }>> =
    {};
  for (const [placementId, bindings] of Object.entries(model.bindings))
    for (const binding of bindings) {
      const token = binding.settings.startableAs?.token;
      if (
        binding.event !== "action" ||
        binding.messageAction !== undefined ||
        token === undefined ||
        !(studioActionTokens as readonly string[]).includes(token)
      )
        continue;
      startable[token as StudioActionToken] = { placementId, bindingId: binding.bindingId };
    }
  return {
    kind: "available",
    flows: {
      address: {
        tenantShortName: entry.tenantShortName,
        organizationShortName: entry.organizationShortName,
        applicationKey: addressed.application.key,
        pageKey: addressed.pageKey,
        pageRecordId: root.data,
      },
      pageParameters: { [pageSubjectParameter]: root.data },
      subject,
      flowTimeZone: model.invocation.flowTimeZone,
      bindings: model.bindings,
      startable,
      pages: model.pages,
    },
  };
};
