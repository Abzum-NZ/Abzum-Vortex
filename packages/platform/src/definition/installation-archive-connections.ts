import "server-only";

import type { RequestDatabaseTransaction } from "../db";
import type {
  ApplicationRootId,
  ConnectionInstanceId,
  OrganizationId,
  OrganizationLifecycleLimits,
} from "../schema";
import {
  listEligibleArchiveConnectionsForApplication,
  type EligibleArchiveConnectionOption,
  type EligibleArchiveConnectionOptionsResult,
} from "../connections/connection-instance-reader";

export class InstallationArchiveConnectionError extends Error {
  constructor(
    readonly reason: "conflict" | "refused" | "temporarily_unavailable",
    readonly detail: string,
  ) {
    super(detail);
    this.name = "InstallationArchiveConnectionError";
  }
}

const availablePage = (page: EligibleArchiveConnectionOptionsResult) => {
  if (page.outcome === "available") return page;
  const reason =
    page.reasonCode === "stale_page"
      ? "conflict"
      : page.reasonCode === "not_authorized" || page.reasonCode === "invalid_parameters"
        ? "refused"
        : "temporarily_unavailable";
  throw new InstallationArchiveConnectionError(reason, page.reasonCode);
};

export const readInstallationArchiveConnectionOptions = async (
  transaction: RequestDatabaseTransaction,
  organizationId: OrganizationId,
  applicationRootId: ApplicationRootId,
  allowedDestinations: OrganizationLifecycleLimits["allowedArchiveDestinations"],
  afterConnectionInstanceId?: ConnectionInstanceId,
) =>
  availablePage(
    await listEligibleArchiveConnectionsForApplication(
      transaction,
      organizationId,
      applicationRootId,
      allowedDestinations,
      {
        pageSize: 100,
        ...(afterConnectionInstanceId === undefined ? {} : { afterConnectionInstanceId }),
      },
    ),
  );

export const readSelectedInstallationArchiveConnection = async (
  transaction: RequestDatabaseTransaction,
  organizationId: OrganizationId,
  applicationRootId: ApplicationRootId,
  allowedDestinations: OrganizationLifecycleLimits["allowedArchiveDestinations"],
  selection: Readonly<{
    connectionInstanceId: ConnectionInstanceId;
    destinationKey: EligibleArchiveConnectionOption["destinationKey"];
    expectedRevision: number;
  }>,
): Promise<EligibleArchiveConnectionOption> => {
  let after: ConnectionInstanceId | undefined;
  const seen = new Set<string>();
  for (let scannedPageCount = 0; scannedPageCount < 100; scannedPageCount += 1) {
    const page = await readInstallationArchiveConnectionOptions(
      transaction,
      organizationId,
      applicationRootId,
      allowedDestinations,
      after,
    );
    const option = page.options.find(
      (entry) =>
        entry.connectionInstanceId.toLowerCase() === selection.connectionInstanceId.toLowerCase(),
    );
    if (option !== undefined) {
      if (
        option.expectedRevision !== selection.expectedRevision ||
        option.destinationKey !== selection.destinationKey
      )
        throw new InstallationArchiveConnectionError("conflict", "selected_connection_changed");
      return option;
    }
    if (page.nextAfterConnectionInstanceId === undefined)
      throw new InstallationArchiveConnectionError("refused", "selected_connection_ineligible");
    const next = page.nextAfterConnectionInstanceId;
    const nextKey = next.toLowerCase();
    if (seen.has(nextKey) || (after !== undefined && nextKey <= after.toLowerCase()))
      throw new InstallationArchiveConnectionError("conflict", "connection_page_cursor_changed");
    seen.add(nextKey);
    after = next;
  }
  throw new InstallationArchiveConnectionError(
    "temporarily_unavailable",
    "connection_page_limit_reached",
  );
};
