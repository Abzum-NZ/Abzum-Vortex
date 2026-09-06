import type {
  OrganizationDelegationAuthorityChangeCommand,
  OrganizationDelegationAuthorityChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import * as shippingAccess from "../src/index";
import { prepareOrganizationDelegationScope } from "../src/organization-delegation-scope-evidence";
import { describe, expect, it } from "vitest";
import {
  OrganizationDelegationAuthorityChangeHandoffError,
  createOrganizationDelegationAuthorityChangeOwnerHandoff,
} from "./helpers/organization-delegation-authority-change-owner-handoff";

const id = (suffix: number): string =>
  `d3000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T03:${String(minute).padStart(2, "0")}:00.000Z`;
const fingerprint = (value: string): `sha256:${string}` => `sha256:${value.repeat(64)}`;

const scope = () =>
  prepareOrganizationDelegationScope({
    kind: "bounded",
    permissions: [
      {
        kind: "exact",
        applicationRootId: id(20),
        ownerKind: "application",
        ownerId: id(20),
        permissionId: id(21),
        acceptedRegistrationRevision: 3,
        catalogueFingerprint: fingerprint("a"),
        continuityRevision: 2,
        meaningFingerprint: fingerprint("b"),
      },
    ],
  });

const grantCommand = (): OrganizationDelegationAuthorityChangeCommand => ({
  operation: "grant_delegation",
  organizationId: id(1),
  delegationAuthorityId: id(2),
  holder: { kind: "organization_account", organizationAccountId: id(3) },
  scope: scope(),
  startsAt: instant(1),
  expiresAt: instant(20),
  changedBy: id(4),
  correlationId: id(5),
});

const delegation = () => ({
  delegationAuthorityId: id(2),
  organizationId: id(1),
  holder: { kind: "organization_account" as const, organizationAccountId: id(3) },
  scope: scope(),
  revision: 1,
  startsAt: instant(1),
  expiresAt: instant(20),
  state: "live" as const,
  grantedByActorId: id(4),
  grantedAt: instant(2),
  grantCorrelationId: id(5),
  changedByActorId: id(4),
  changedAt: instant(2),
  changeCorrelationId: id(5),
});

const grantRow = (): DatabaseRow => ({
  outcome: "changed",
  operation: "grant_delegation",
  delegation: delegation(),
  access_version: 2n,
  correlation_id: id(5),
});

type QueryCall = Readonly<{ text: string; values: readonly DatabaseValue[] }>;
const transactionFor = (
  responder: (call: QueryCall) => readonly DatabaseRow[],
  calls: QueryCall[] = [],
): RequestDatabaseTransaction => ({
  query: async <Row extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => {
    const call = { text: strings.join("$value"), values };
    calls.push(call);
    return responder(call) as readonly Row[];
  },
});

describe("owner-only organization delegation-authority handoff contract proof", () => {
  it("keeps the owner handoff out of the shipping Access surface", () => {
    const exports = Object.keys(shippingAccess);
    expect(exports).not.toContain("createOrganizationDelegationAuthorityChangeOwnerHandoff");
    expect(exports).not.toContain("OrganizationDelegationAuthorityChangeHandoffError");
    expect(exports).not.toContain("organizationDelegationAuthorityChangeHandoffErrorCodes");
  });

  it("uses one coordinated grant call and binds exact holder, scope and window", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationDelegationAuthorityChangeOwnerHandoff(
      transactionFor(() => [grantRow()], calls),
    );
    await expect(handoff.change(grantCommand())).resolves.toEqual({
      outcome: "changed",
      operation: "grant_delegation",
      delegation: delegation(),
      accessVersion: 2,
      correlationId: id(5),
    } satisfies OrganizationDelegationAuthorityChangeResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(
      "vortex_access.coordinate_organization_delegation_authority_change",
    );
    const bounded = scope();
    if (bounded.kind !== "bounded") throw new Error("expected bounded scope");
    expect(calls[0]?.values).toEqual([
      "grant_delegation",
      id(1),
      id(2),
      null,
      "organization_account",
      id(3),
      null,
      "bounded",
      JSON.stringify(bounded.permissions),
      bounded.scopeFingerprint,
      instant(1),
      instant(20),
      id(4),
      id(5),
    ]);
  });

  it("binds a Group-held organization-catalogue grant", async () => {
    const command = {
      ...grantCommand(),
      holder: { kind: "group" as const, groupId: id(6) },
      scope: { kind: "organization_catalogue" as const },
      expiresAt: undefined,
    };
    const stored = {
      ...delegation(),
      holder: command.holder,
      scope: command.scope,
      expiresAt: undefined,
    };
    const calls: QueryCall[] = [];
    const handoff = createOrganizationDelegationAuthorityChangeOwnerHandoff(
      transactionFor(() => [{ ...grantRow(), delegation: stored }], calls),
    );
    await expect(handoff.change(command)).resolves.toMatchObject({ delegation: stored });
    expect(calls[0]?.values).toEqual([
      "grant_delegation",
      id(1),
      id(2),
      null,
      "group",
      null,
      id(6),
      "organization_catalogue",
      null,
      null,
      instant(1),
      null,
      id(4),
      id(5),
    ]);
  });

  it("binds exact scope replacement while leaving permanent evidence to SQL", async () => {
    const command = {
      operation: "replace_delegation_scope" as const,
      organizationId: id(1),
      delegationAuthorityId: id(2),
      expectedDelegationRevision: 1,
      scope: { kind: "organization_catalogue" as const },
      changedBy: id(7),
      correlationId: id(8),
    };
    const replaced = {
      ...delegation(),
      scope: command.scope,
      revision: 2,
      changedByActorId: id(7),
      changedAt: instant(3),
      changeCorrelationId: id(8),
    };
    const calls: QueryCall[] = [];
    const handoff = createOrganizationDelegationAuthorityChangeOwnerHandoff(
      transactionFor(
        () => [
          {
            outcome: "changed",
            operation: command.operation,
            delegation: replaced,
            access_version: "3",
            correlation_id: id(8),
          },
        ],
        calls,
      ),
    );
    await expect(handoff.change(command)).resolves.toMatchObject({ delegation: replaced });
    expect(calls[0]?.values).toEqual([
      "replace_delegation_scope",
      id(1),
      id(2),
      1,
      null,
      null,
      null,
      "organization_catalogue",
      null,
      null,
      null,
      null,
      id(7),
      id(8),
    ]);
  });

  it("binds terminal revocation and sends no editable scope", async () => {
    const command = {
      operation: "revoke_delegation" as const,
      organizationId: id(1),
      delegationAuthorityId: id(2),
      expectedDelegationRevision: 1,
      changedBy: id(7),
      correlationId: id(9),
    };
    const revoked = {
      ...delegation(),
      revision: 2,
      state: "revoked" as const,
      changedByActorId: id(7),
      changedAt: instant(3),
      changeCorrelationId: id(9),
      revokedByActorId: id(7),
      revokedAt: instant(3),
      revocationCorrelationId: id(9),
    };
    const calls: QueryCall[] = [];
    const handoff = createOrganizationDelegationAuthorityChangeOwnerHandoff(
      transactionFor(
        () => [
          {
            outcome: "changed",
            operation: command.operation,
            delegation: revoked,
            access_version: 3,
            correlation_id: id(9),
          },
        ],
        calls,
      ),
    );
    await expect(handoff.change(command)).resolves.toMatchObject({ delegation: revoked });
    expect(calls[0]?.values).toEqual([
      "revoke_delegation",
      id(1),
      id(2),
      1,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      id(7),
      id(9),
    ]);
  });

  it("accepts semantic UUID and timestamp equivalence", async () => {
    const command = {
      ...grantCommand(),
      organizationId: id(1).toUpperCase(),
      delegationAuthorityId: id(2).toUpperCase(),
      holder: { kind: "organization_account" as const, organizationAccountId: id(3).toUpperCase() },
      changedBy: id(4).toUpperCase(),
      correlationId: id(5).toUpperCase(),
      startsAt: "2026-09-06T15:01:00+12:00",
      expiresAt: "2026-09-06T15:20:00+12:00",
    };
    const handoff = createOrganizationDelegationAuthorityChangeOwnerHandoff(
      transactionFor(() => [grantRow()]),
    );
    await expect(handoff.change(command)).resolves.toMatchObject({ outcome: "changed" });
  });

  it.each([
    ["operation", { operation: "replace_delegation_scope" }],
    ["organization", { delegation: { ...delegation(), organizationId: id(99) } }],
    ["delegation identity", { delegation: { ...delegation(), delegationAuthorityId: id(99) } }],
    ["holder", { delegation: { ...delegation(), holder: { kind: "group", groupId: id(99) } } }],
    ["scope", { delegation: { ...delegation(), scope: { kind: "organization_catalogue" } } }],
    ["window", { delegation: { ...delegation(), startsAt: instant(2) } }],
    ["actor", { delegation: { ...delegation(), changedByActorId: id(99) } }],
    ["correlation", { correlation_id: id(99) }],
  ])("refuses a grant result with substituted %s", async (_name, override) => {
    const handoff = createOrganizationDelegationAuthorityChangeOwnerHandoff(
      transactionFor(() => [{ ...grantRow(), ...override }]),
    );
    await expect(handoff.change(grantCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STORAGE_RESULT",
    });
  });

  it("refuses malformed or tampered prepared scope before querying", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationDelegationAuthorityChangeOwnerHandoff(
      transactionFor(() => [grantRow()], calls),
    );
    const prepared = scope();
    if (prepared.kind !== "bounded") throw new Error("expected bounded scope");
    await expect(
      handoff.change({
        ...grantCommand(),
        scope: { ...prepared, scopeFingerprint: fingerprint("0") },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_COMMAND",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses invalid result cardinality", async () => {
    const none = createOrganizationDelegationAuthorityChangeOwnerHandoff(transactionFor(() => []));
    await expect(none.change(grantCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STORAGE_RESULT",
    });
    const multiple = createOrganizationDelegationAuthorityChangeOwnerHandoff(
      transactionFor(() => [grantRow(), grantRow()]),
    );
    await expect(multiple.change(grantCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["22023", "INVALID_ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_COMMAND"],
    ["42501", "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_SCOPE_UNAVAILABLE"],
    ["22003", "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_VERSION_EXHAUSTED"],
    ["23503", "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23505", "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23514", "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STALE_OR_UNAVAILABLE"],
    ["40001", "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STALE_OR_UNAVAILABLE"],
    ["55000", "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_STALE_OR_UNAVAILABLE"],
    ["XX000", "ORGANIZATION_DELEGATION_AUTHORITY_CHANGE_FAILED"],
  ])("maps SQLSTATE %s without exposing storage detail", async (databaseCode, expectedCode) => {
    const handoff = createOrganizationDelegationAuthorityChangeOwnerHandoff({
      query: async () => {
        throw { code: databaseCode, message: "sensitive database detail" };
      },
    });
    await expect(handoff.change(grantCommand())).rejects.toEqual(
      new OrganizationDelegationAuthorityChangeHandoffError(
        expectedCode as ConstructorParameters<
          typeof OrganizationDelegationAuthorityChangeHandoffError
        >[0],
      ),
    );
  });
});
