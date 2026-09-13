import { randomUUID } from "node:crypto";
import type { DatabaseRow, DatabaseValue } from "../../db/src/index";
import { createResolvedRequestTransactionRunner } from "../../db/src/request-transaction";
import postgres, { type Row } from "postgres";
import { describe, expect, it } from "vitest";
import { createOrganizationAccessAdministrationService } from "../../runtime/access/src/index";

const databaseUrl = process.env.VORTEX_TEST_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("committed Access refusal", () => {
  it("commits one refusal before the public adapter returns unavailable", async () => {
    const admin = postgres(databaseUrl!, { max: 1, prepare: false });
    const tenantId = randomUUID();
    const organizationId = randomUUID();
    const identityId = randomUUID();
    const organizationAccountId = randomUUID();
    const actorId = randomUUID();
    const identityAuthorityId = randomUUID();
    const sessionId = randomUUID();
    const correlationId = randomUUID();
    const activityId = randomUUID();
    const groupId = randomUUID();
    const fixtureCorrelationId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.valueOf() + 60 * 60 * 1000);

    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = "vortex_runtime";
    runtimeUrl.password = "vortex-runtime-local-only";
    const runtime = postgres(runtimeUrl.toString(), { max: 1, prepare: false });
    const resolvedRequestTransaction = createResolvedRequestTransactionRunner({
      transaction: async <Result>(
        operation: (transaction: {
          query<ResultRow extends DatabaseRow = DatabaseRow>(
            strings: TemplateStringsArray,
            ...values: readonly DatabaseValue[]
          ): Promise<readonly ResultRow[]>;
        }) => Promise<Result>,
      ) =>
        runtime.begin(async (transaction) =>
          operation({
            query: async <ResultRow extends DatabaseRow = DatabaseRow>(
              strings: TemplateStringsArray,
              ...values: readonly DatabaseValue[]
            ) =>
              (await transaction<ResultRow[] & Row[]>(strings, ...values)) as readonly ResultRow[],
          }),
        ) as Promise<Result>,
    });

    try {
      await admin.begin(async (transaction) => {
        await transaction`insert into vortex_identity.tenants (
          tenant_id, short_name, display_name, state, created_at, created_by,
          state_changed_at, revision
        ) values (
          ${tenantId}::uuid, ${`refusal_${tenantId.slice(0, 8)}`}::text,
          'Refusal proof', 'active', pg_catalog.clock_timestamp(), ${actorId}::uuid,
          pg_catalog.clock_timestamp(), 1
        )`;
        await transaction`insert into vortex_identity.organizations (
          organization_id, tenant_id, short_name, display_name, state,
          created_at, created_by, state_changed_at, revision
        ) values (
          ${organizationId}::uuid, ${tenantId}::uuid,
          ${`refusal_${organizationId.slice(0, 8)}`}::text, 'Refusal proof', 'active',
          pg_catalog.clock_timestamp(), ${actorId}::uuid, pg_catalog.clock_timestamp(), 1
        )`;
        await transaction`insert into vortex_identity.identity_projections (
          identity_id, state, created_at, state_changed_at, state_changed_by,
          state_change_correlation_id, revision
        ) values (
          ${identityId}::uuid, 'active', pg_catalog.clock_timestamp(),
          pg_catalog.clock_timestamp(), ${actorId}::uuid, ${fixtureCorrelationId}::uuid, 1
        )`;
        await transaction`insert into vortex_identity.organization_accounts (
          organization_account_id, organization_id, identity_id, display_name,
          state, activated_at, changed_at, state_changed_at, state_changed_by,
          state_change_correlation_id, revision
        ) values (
          ${organizationAccountId}::uuid, ${organizationId}::uuid, ${identityId}::uuid,
          'Refusal proof account', 'active', pg_catalog.clock_timestamp(),
          pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), ${actorId}::uuid,
          ${fixtureCorrelationId}::uuid, 1
        )`;
        await transaction`select * from vortex_access.initialize_organization_access_version(
          ${organizationId}::uuid, ${actorId}::uuid, ${fixtureCorrelationId}::uuid
        )`;
        await transaction`select * from vortex_access.initialize_platform_permission_catalogue(
          ${organizationId}::uuid, ${actorId}::uuid, ${fixtureCorrelationId}::uuid
        )`;
        await transaction`insert into vortex_access.permission_continuities (
          organization_id, application_root_id, owner_kind, owner_id,
          permission_id, registration_kind, registration_owner_id, state,
          continuity_revision, meaning_fingerprint,
          last_processed_registration_revision, changed_at
        )
        select entry.organization_id, null, entry.owner_kind, entry.owner_id,
          entry.permission_id, 'platform', entry.registration_owner_id,
          'available', 1, entry.meaning_fingerprint, entry.registration_revision,
          pg_catalog.clock_timestamp()
        from vortex_access.permission_catalogue_entries as entry
        where entry.organization_id = ${organizationId}::uuid
          and entry.registration_kind = 'platform'`;
      });

      const service = createOrganizationAccessAdministrationService({
        identityAuthorityId,
        resolvedRequestTransaction,
        clock: () => now,
        correlationId: () => correlationId,
        groupId: () => groupId,
        activityId: () => activityId,
      });
      const result = await service.createGroup(
        {
          identityId,
          sessionId,
          authenticationStrength: "multi_factor",
          accessTokenIssuedAt: new Date(now.valueOf() - 60_000).toISOString(),
          accessTokenExpiresAt: expiresAt.toISOString(),
        },
        { organizationId },
        { key: "refusal_proof", label: "Refusal proof" },
      );

      expect(result).toEqual({ kind: "unavailable" });
      const [evidence] = await admin<
        {
          action: string;
          actor_id: string;
          subject_ids: string[];
          changed_field_ids: string[];
          source: string;
          correlation_id: string;
          outcome: string;
          activity_count: string;
          group_count: string;
          access_version: string;
        }[]
      >`select activity.action, activity.actor_id, activity.subject_ids,
          activity.changed_field_ids, activity.source, activity.correlation_id,
          activity.outcome,
          (select pg_catalog.count(*)::text
           from vortex_activity.organization_activity_entries as counted
           where counted.organization_id = ${organizationId}::uuid
             and counted.activity_id = ${activityId}::uuid) as activity_count,
          (select pg_catalog.count(*)::text
           from vortex_access.organization_groups as organization_group
           where organization_group.organization_id = ${organizationId}::uuid) as group_count,
          version.current_version::text as access_version
        from vortex_activity.organization_activity_entries as activity
        join vortex_access.organization_access_versions as version
          on version.organization_id = activity.organization_id
        where activity.organization_id = ${organizationId}::uuid
          and activity.activity_id = ${activityId}::uuid`;

      expect(evidence).toMatchObject({
        action: "create_group",
        actor_id: organizationAccountId,
        subject_ids: [organizationId],
        changed_field_ids: [],
        source: "web",
        correlation_id: correlationId,
        outcome: "refused",
        activity_count: "1",
        group_count: "0",
        access_version: "2",
      });
    } finally {
      await runtime.end();
      await admin.end();
    }
  });
});
