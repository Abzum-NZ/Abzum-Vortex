import {
  organizationDelegationAuthorityChangeCommandSchema,
  organizationDelegationAuthorityChangeResultSchema,
  organizationDelegationScopeCandidateSchema,
} from "../src/organization-delegation-authority-changes";
import { describe, expect, it } from "vitest";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = (value: string): string => `sha256:${value.repeat(64)}`;
const instant = (minute: number): string =>
  `2026-09-06T01:${String(minute).padStart(2, "0")}:00.000Z`;

const permission = () => ({
  kind: "exact" as const,
  applicationRootId: "a1000000-0000-4000-8000-000000000001",
  ownerKind: "application" as const,
  ownerId: "a1000000-0000-4000-8000-000000000001",
  permissionId: "b1000000-0000-4000-8000-000000000001",
  acceptedRegistrationRevision: 3,
  catalogueFingerprint: fingerprint("a"),
  continuityRevision: 2,
  meaningFingerprint: fingerprint("b"),
});

const boundedScope = () => ({
  kind: "bounded" as const,
  permissions: [permission()],
  scopeFingerprint: fingerprint("c"),
});

const grant = () => ({
  operation: "grant_delegation" as const,
  organizationId: id(1),
  delegationAuthorityId: id(2),
  holder: { kind: "organization_account" as const, organizationAccountId: id(3) },
  scope: boundedScope(),
  startsAt: instant(1),
  expiresAt: instant(20),
  changedBy: id(4),
  correlationId: id(5),
});

const storedDelegation = () => ({
  delegationAuthorityId: id(2),
  organizationId: id(1),
  holder: { kind: "organization_account" as const, organizationAccountId: id(3) },
  scope: boundedScope(),
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

const result = () => ({
  outcome: "changed" as const,
  operation: "grant_delegation" as const,
  delegation: storedDelegation(),
  accessVersion: 9,
  correlationId: id(5),
});

describe("organization delegation-authority change contracts", () => {
  it("accepts the strict catalogue and bounded scope candidates", () => {
    expect(
      organizationDelegationScopeCandidateSchema.safeParse({
        kind: "organization_catalogue",
      }).success,
    ).toBe(true);
    expect(
      organizationDelegationScopeCandidateSchema.safeParse({
        kind: "bounded",
        permissions: [permission()],
      }).success,
    ).toBe(true);
    expect(
      organizationDelegationScopeCandidateSchema.safeParse({
        kind: "bounded",
        permissions: [],
      }).success,
    ).toBe(false);
    expect(
      organizationDelegationScopeCandidateSchema.safeParse({
        kind: "organization_catalogue",
        scopeFingerprint: fingerprint("c"),
      }).success,
    ).toBe(false);
  });

  it.each([
    ["direct bounded grant", grant()],
    [
      "Group catalogue grant",
      {
        ...grant(),
        holder: { kind: "group", groupId: id(6) },
        scope: { kind: "organization_catalogue" },
      },
    ],
    [
      "scope replacement",
      {
        operation: "replace_delegation_scope",
        organizationId: id(1),
        delegationAuthorityId: id(2),
        expectedDelegationRevision: 3,
        scope: boundedScope(),
        changedBy: id(4),
        correlationId: id(7),
      },
    ],
    [
      "terminal revocation",
      {
        operation: "revoke_delegation",
        organizationId: id(1),
        delegationAuthorityId: id(2),
        expectedDelegationRevision: 3,
        changedBy: id(4),
        correlationId: id(8),
      },
    ],
  ])("accepts an exact %s command", (_name, candidate) => {
    expect(organizationDelegationAuthorityChangeCommandSchema.safeParse(candidate).success).toBe(
      true,
    );
  });

  it("accepts scheduled, finite and permanent fixed grant windows", () => {
    expect(
      organizationDelegationAuthorityChangeCommandSchema.safeParse({
        ...grant(),
        startsAt: instant(30),
        expiresAt: instant(40),
      }).success,
    ).toBe(true);
    const permanent = grant();
    delete (permanent as Partial<typeof permanent>).expiresAt;
    expect(organizationDelegationAuthorityChangeCommandSchema.safeParse(permanent).success).toBe(
      true,
    );
  });

  it.each([
    ["reversed window", { ...grant(), startsAt: instant(20), expiresAt: instant(1) }],
    ["non-finite start", { ...grant(), startsAt: "+infinity" }],
    [
      "nil delegation",
      { ...grant(), delegationAuthorityId: "00000000-0000-0000-0000-000000000000" },
    ],
    [
      "mixed holder",
      { ...grant(), holder: { kind: "group", groupId: id(6), organizationAccountId: id(3) } },
    ],
    ["unprepared scope", { ...grant(), scope: { kind: "bounded", permissions: [permission()] } }],
    ["caller grant time", { ...grant(), grantedAt: instant(2) }],
    [
      "replace holder",
      {
        operation: "replace_delegation_scope",
        organizationId: id(1),
        delegationAuthorityId: id(2),
        expectedDelegationRevision: 3,
        scope: boundedScope(),
        holder: grant().holder,
        changedBy: id(4),
        correlationId: id(7),
      },
    ],
    [
      "revoke scope",
      {
        operation: "revoke_delegation",
        organizationId: id(1),
        delegationAuthorityId: id(2),
        expectedDelegationRevision: 3,
        scope: boundedScope(),
        changedBy: id(4),
        correlationId: id(8),
      },
    ],
    [
      "unsafe expected revision",
      {
        operation: "revoke_delegation",
        organizationId: id(1),
        delegationAuthorityId: id(2),
        expectedDelegationRevision: Number.MAX_SAFE_INTEGER + 1,
        changedBy: id(4),
        correlationId: id(8),
      },
    ],
  ])("refuses %s", (_name, candidate) => {
    expect(organizationDelegationAuthorityChangeCommandSchema.safeParse(candidate).success).toBe(
      false,
    );
  });

  it("requires a complete exact revision-one grant result", () => {
    expect(organizationDelegationAuthorityChangeResultSchema.safeParse(result()).success).toBe(
      true,
    );
    expect(
      organizationDelegationAuthorityChangeResultSchema.safeParse({
        ...result(),
        delegation: { ...storedDelegation(), grantedAt: "2026-09-06T13:02:00+12:00" },
      }).success,
    ).toBe(true);
    expect(
      organizationDelegationAuthorityChangeResultSchema.safeParse({
        ...result(),
        delegation: { ...storedDelegation(), revision: 2 },
      }).success,
    ).toBe(false);
    expect(
      organizationDelegationAuthorityChangeResultSchema.safeParse({
        ...result(),
        delegation: { ...storedDelegation(), grantedAt: instant(3) },
      }).success,
    ).toBe(false);
  });

  it("distinguishes a live scope replacement from terminal revocation", () => {
    const replacement = {
      ...result(),
      operation: "replace_delegation_scope",
      correlationId: id(7),
      delegation: {
        ...storedDelegation(),
        scope: { kind: "organization_catalogue" },
        revision: 2,
        changedByActorId: id(9),
        changedAt: instant(3),
        changeCorrelationId: id(7),
      },
    };
    expect(organizationDelegationAuthorityChangeResultSchema.safeParse(replacement).success).toBe(
      true,
    );
    expect(
      organizationDelegationAuthorityChangeResultSchema.safeParse({
        ...replacement,
        delegation: { ...replacement.delegation, state: "revoked" },
      }).success,
    ).toBe(false);

    const revoked = {
      ...replacement,
      operation: "revoke_delegation",
      correlationId: id(8),
      delegation: {
        ...replacement.delegation,
        revision: 3,
        state: "revoked",
        changedAt: instant(4),
        changeCorrelationId: id(8),
        revokedByActorId: id(9),
        revokedAt: instant(4),
        revocationCorrelationId: id(8),
      },
    };
    expect(organizationDelegationAuthorityChangeResultSchema.safeParse(revoked).success).toBe(true);
    expect(
      organizationDelegationAuthorityChangeResultSchema.safeParse({
        ...revoked,
        delegation: { ...revoked.delegation, revocationCorrelationId: undefined },
      }).success,
    ).toBe(false);
  });
});
