import {
  organizationRoleActivationChangeCommandSchema,
  organizationRoleActivationChangeResultSchema,
} from "../src/organization-role-activation-changes";
import { describe, expect, it } from "vitest";

const id = (suffix: number): string =>
  `ae000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T04:${String(minute).padStart(2, "0")}:00.000Z`;

const directCommand = () => ({
  operation: "activate_role" as const,
  organizationId: id(1),
  roleActivationId: id(2),
  organizationAccountId: id(3),
  roleId: id(4),
  expectedRoleRevision: 5,
  requestedDurationSeconds: 900,
  eligibilitySource: {
    kind: "direct" as const,
    eligibilityAssignment: { roleAssignmentId: id(5), revision: 2 },
  },
  changedBy: id(6),
  correlationId: id(7),
});

const liveActivation = () => ({
  roleActivationId: id(2),
  organizationId: id(1),
  organizationAccountId: id(3),
  roleId: id(4),
  revision: 1,
  historicalRoleRevision: 5,
  authorityContinuityRevision: 2,
  policyContinuityRevision: 3,
  activationPolicy: {
    activationPolicyId: id(8),
    revision: 4,
    fingerprint: `sha256:${"a".repeat(64)}`,
  },
  eligibilitySource: {
    kind: "direct" as const,
    eligibilityAssignment: { roleAssignmentId: id(5), revision: 2 },
  },
  state: "live" as const,
  activatedByActorId: id(6),
  activatedAt: instant(1),
  expiresAt: instant(16),
  activationCorrelationId: id(7),
  changedByActorId: id(6),
  changedAt: instant(1),
  changeCorrelationId: id(7),
});

describe("organization role-activation change contracts", () => {
  it("accepts exact direct, Group-derived and revocation commands", () => {
    expect(organizationRoleActivationChangeCommandSchema.safeParse(directCommand()).success).toBe(
      true,
    );
    expect(
      organizationRoleActivationChangeCommandSchema.safeParse({
        ...directCommand(),
        eligibilitySource: {
          kind: "group",
          eligibilityAssignment: { roleAssignmentId: id(9), revision: 3 },
          originatingMembership: { membershipId: id(10), revision: 4 },
        },
      }).success,
    ).toBe(true);
    expect(
      organizationRoleActivationChangeCommandSchema.safeParse({
        operation: "revoke_role_activation",
        organizationId: id(1),
        roleActivationId: id(2),
        expectedActivationRevision: 1,
        changedBy: id(11),
        correlationId: id(12),
      }).success,
    ).toBe(true);
  });

  it.each([
    ["unknown operation", { ...directCommand(), operation: "request_activation" }],
    ["zero duration", { ...directCommand(), requestedDurationSeconds: 0 }],
    ["fractional duration", { ...directCommand(), requestedDurationSeconds: 1.5 }],
    ["unsafe duration", { ...directCommand(), requestedDurationSeconds: 9_007_199_254_740_992 }],
    ["unsafe role revision", { ...directCommand(), expectedRoleRevision: 9_007_199_254_740_992 }],
    [
      "nil activation",
      { ...directCommand(), roleActivationId: "00000000-0000-0000-0000-000000000000" },
    ],
    ["caller timestamp", { ...directCommand(), activatedAt: instant(1) }],
    ["caller policy", { ...directCommand(), activationPolicy: { activationPolicyId: id(8) } }],
    [
      "membership on direct source",
      {
        ...directCommand(),
        eligibilitySource: {
          ...directCommand().eligibilitySource,
          originatingMembership: { membershipId: id(10), revision: 1 },
        },
      },
    ],
    [
      "missing Group membership",
      {
        ...directCommand(),
        eligibilitySource: {
          kind: "group",
          eligibilityAssignment: { roleAssignmentId: id(9), revision: 3 },
        },
      },
    ],
    [
      "activation-only field on revoke",
      {
        operation: "revoke_role_activation",
        organizationId: id(1),
        roleActivationId: id(2),
        expectedActivationRevision: 1,
        requestedDurationSeconds: 30,
        changedBy: id(11),
        correlationId: id(12),
      },
    ],
  ])("refuses %s", (_name, candidate) => {
    expect(organizationRoleActivationChangeCommandSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts exact activation and revocation results", () => {
    expect(
      organizationRoleActivationChangeResultSchema.safeParse({
        outcome: "changed",
        operation: "activate_role",
        activation: liveActivation(),
        accessVersion: 2,
        correlationId: id(7),
      }).success,
    ).toBe(true);

    const revokedAt = instant(20);
    expect(
      organizationRoleActivationChangeResultSchema.safeParse({
        outcome: "changed",
        operation: "revoke_role_activation",
        activation: {
          ...liveActivation(),
          revision: 2,
          state: "revoked",
          changedByActorId: id(11),
          changedAt: revokedAt,
          changeCorrelationId: id(12),
          revokedByActorId: id(11),
          revokedAt,
          revocationCorrelationId: id(12),
        },
        accessVersion: 3,
        correlationId: id(12),
      }).success,
    ).toBe(true);
  });

  it.each([
    ["operation", { operation: "revoke_role_activation" }],
    ["result correlation", { correlationId: id(99) }],
    ["activation revision", { activation: { ...liveActivation(), revision: 2 } }],
    ["activation state", { activation: { ...liveActivation(), state: "revoked" } }],
    ["activation actor", { activation: { ...liveActivation(), activatedByActorId: id(99) } }],
    ["activation time", { activation: { ...liveActivation(), changedAt: instant(2) } }],
  ])("refuses activation result with substituted %s", (_name, override) => {
    expect(
      organizationRoleActivationChangeResultSchema.safeParse({
        outcome: "changed",
        operation: "activate_role",
        activation: liveActivation(),
        accessVersion: 2,
        correlationId: id(7),
        ...override,
      }).success,
    ).toBe(false);
  });
});
