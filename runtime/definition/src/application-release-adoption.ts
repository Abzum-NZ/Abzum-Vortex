import "server-only";

import {
  applicationRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  type ApplicationRootId,
  type OrganizationId,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { z } from "zod";

/**
 * Reads the published-current release an organisation may deliberately adopt for an application it
 * has installed. The read runs under the human request's own application scope and is gated by the
 * protected database function on platform.organization.applications.manage, so a viewer without
 * that permission learns nothing about the definition. Publication advances the root pointer but
 * never changes the installation, so the value is an offer, not the active release.
 */

export const applicationReleaseAdoptionTargetErrorCodes = [
  "INVALID_APPLICATION_RELEASE_ADOPTION_COMMAND",
  "APPLICATION_RELEASE_ADOPTION_TARGET_UNAVAILABLE",
  "APPLICATION_RELEASE_ADOPTION_TARGET_FAILED",
] as const;

export type ApplicationReleaseAdoptionTargetErrorCode =
  (typeof applicationReleaseAdoptionTargetErrorCodes)[number];

export class ApplicationReleaseAdoptionTargetError extends Error {
  readonly code: ApplicationReleaseAdoptionTargetErrorCode;

  constructor(code: ApplicationReleaseAdoptionTargetErrorCode) {
    super(code);
    this.name = "ApplicationReleaseAdoptionTargetError";
    this.code = code;
  }
}

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

const storedTargetSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    currentReleaseRevision: javascriptSafeRevisionSchema.nullable(),
    currentReleaseVersion: stableDefinitionReleaseVersionSchema.nullable(),
  })
  .strict();

export const applicationReleaseAdoptionTargetCommandSchema = z
  .object({ applicationRootId: applicationRootIdSchema })
  .strict();

export type ApplicationReleaseAdoptionTargetCommand = z.infer<
  typeof applicationReleaseAdoptionTargetCommandSchema
>;

export type ApplicationReleaseAdoptionTarget = Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  currentReleaseRevision: number;
  currentReleaseVersion: string;
}>;

export interface ApplicationReleaseAdoptionTargetRepository {
  read(applicationRootId: ApplicationRootId): Promise<unknown | undefined>;
}

type AdoptionTargetRow = DatabaseRow & { readonly adoption_target: unknown };

export const createDatabaseApplicationReleaseAdoptionTargetRepository = (
  transaction: RequestDatabaseTransaction,
): ApplicationReleaseAdoptionTargetRepository => ({
  async read(applicationRootId) {
    const rows = await transaction.query<AdoptionTargetRow>`
      select vortex_definition.read_application_release_adoption_target(
        ${applicationRootId}::uuid
      ) as adoption_target
    `;
    if (rows.length !== 1)
      throw new ApplicationReleaseAdoptionTargetError(
        "APPLICATION_RELEASE_ADOPTION_TARGET_FAILED",
      );
    return rows[0]!.adoption_target === null ? undefined : rows[0]!.adoption_target;
  },
});

export const createApplicationReleaseAdoptionTargetService = (
  repository: ApplicationReleaseAdoptionTargetRepository,
) => ({
  /**
   * The published-current release of the addressed application, or undefined when one cannot be
   * proven. A root with no published release offers nothing to adopt.
   */
  async read(
    commandCandidate: unknown,
  ): Promise<ApplicationReleaseAdoptionTarget | undefined> {
    const command = applicationReleaseAdoptionTargetCommandSchema.safeParse(commandCandidate);
    if (!command.success)
      throw new ApplicationReleaseAdoptionTargetError(
        "INVALID_APPLICATION_RELEASE_ADOPTION_COMMAND",
      );

    let candidate: unknown | undefined;
    try {
      candidate = await repository.read(command.data.applicationRootId);
    } catch (error) {
      if (error instanceof ApplicationReleaseAdoptionTargetError) throw error;
      throw new ApplicationReleaseAdoptionTargetError(
        "APPLICATION_RELEASE_ADOPTION_TARGET_UNAVAILABLE",
      );
    }
    if (candidate === undefined)
      throw new ApplicationReleaseAdoptionTargetError(
        "APPLICATION_RELEASE_ADOPTION_TARGET_UNAVAILABLE",
      );

    const parsed = storedTargetSchema.safeParse(candidate);
    if (!parsed.success)
      throw new ApplicationReleaseAdoptionTargetError(
        "APPLICATION_RELEASE_ADOPTION_TARGET_FAILED",
      );
    const target = parsed.data;
    if (
      target.applicationRootId.toLowerCase() !== command.data.applicationRootId.toLowerCase()
    )
      throw new ApplicationReleaseAdoptionTargetError(
        "APPLICATION_RELEASE_ADOPTION_TARGET_FAILED",
      );
    // A published root always carries both the pointer and its version; a partial pair is refused
    // rather than offered as a half-known adoption target.
    if (target.currentReleaseRevision === null || target.currentReleaseVersion === null) {
      if (target.currentReleaseRevision === null && target.currentReleaseVersion === null)
        return undefined;
      throw new ApplicationReleaseAdoptionTargetError(
        "APPLICATION_RELEASE_ADOPTION_TARGET_FAILED",
      );
    }
    return Object.freeze({
      organizationId: target.organizationId,
      applicationRootId: target.applicationRootId,
      currentReleaseRevision: target.currentReleaseRevision,
      currentReleaseVersion: target.currentReleaseVersion,
    });
  },
});

export const createDatabaseApplicationReleaseAdoptionTargetService = (
  transaction: RequestDatabaseTransaction,
) =>
  createApplicationReleaseAdoptionTargetService(
    createDatabaseApplicationReleaseAdoptionTargetRepository(transaction),
  );

export type ApplicationReleaseAdoptionTargetService = ReturnType<
  typeof createApplicationReleaseAdoptionTargetService
>;
