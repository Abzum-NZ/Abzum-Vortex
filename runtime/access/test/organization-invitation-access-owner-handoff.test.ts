import type {
  AcceptOrganizationInvitationAccessCommand,
  CreateOrganizationInvitationWithAccessIntentCommand,
  OrganizationInvitationAccessIntent,
  VerifiedIdentity,
} from "@vortex/contracts";
import {
  correlationIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  verifiedIdentitySchema,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import * as shippingAccess from "../src/index";
import { describe, expect, it, vi } from "vitest";
import {
  OrganizationInvitationAccessHandoffError,
  createOrganizationInvitationAccessOwnerHandoff,
  type OrganizationInvitationAccessCreateContext,
} from "./helpers/organization-invitation-access-owner-handoff";

const id = (prefix: string, suffix: number): string =>
  `${prefix}6000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T06:${String(minute).padStart(2, "0")}:00.000Z`;
const secret = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

const context = (): OrganizationInvitationAccessCreateContext => ({
  organizationId: organizationIdSchema.parse(id("a", 1)),
  organizationAccountId: organizationAccountIdSchema.parse(id("b", 2)),
  correlationId: correlationIdSchema.parse(id("c", 3)),
});
const candidateIntent = () => ({
  membershipIntents: [{ membershipId: id("d", 4), groupId: id("e", 5), startsAt: instant(2) }],
  roleAssignmentIntents: [
    {
      roleAssignmentId: id("f", 6),
      roleId: id("a", 7),
      expectedRoleRevision: 2,
      assignmentKind: "eligible" as const,
      startsAt: instant(2),
      expiresAt: instant(20),
    },
  ],
});
const createCommand = (): CreateOrganizationInvitationWithAccessIntentCommand => ({
  operation: "create_organization_invitation_with_access_intent",
  invitedEmail: "Person@Example.Test",
  expiresAt: instant(30),
  accessIntent: candidateIntent(),
});
const invitation = () => ({
  invitationId: id("b", 8),
  organizationId: id("a", 1),
  invitedEmail: "person@example.test",
  invitedBy: id("b", 2),
  createdAt: instant(1),
  invitedAt: instant(1),
  expiresAt: instant(30),
  changedAt: instant(1),
  revision: 1,
});
const storedIntent = (): OrganizationInvitationAccessIntent => ({
  organizationId: organizationIdSchema.parse(id("a", 1)),
  invitationId: invitation().invitationId,
  ...candidateIntent(),
  intendedByOrganizationAccountId: organizationAccountIdSchema.parse(id("b", 2)),
  intendedAt: instant(1),
  intentCorrelationId: correlationIdSchema.parse(id("c", 3)),
});
const identity = (): VerifiedIdentity =>
  verifiedIdentitySchema.parse({
    identityId: id("c", 9),
    verifiedPrimaryEmail: "Person@Example.Test",
    issuer: "https://identity.example.test/auth/v1",
    audience: "authenticated",
    sessionId: id("d", 10),
    issuedAt: instant(1),
    expiresAt: instant(59),
    authenticationStrength: "single_factor",
    keyId: "test-key",
  });
const acceptCommand = (): AcceptOrganizationInvitationAccessCommand => ({
  invitationSecret: secret,
  displayName: "Person",
  correlationId: id("e", 11),
});
const account = (originatingInvitation: string | undefined = id("f", 90)) => ({
  organizationAccountId: id("f", 12),
  organizationId: id("a", 1),
  identityId: id("c", 9),
  displayName: "Person",
  state: "active",
  ...(originatingInvitation === undefined ? {} : { invitationId: originatingInvitation }),
  activatedAt: instant(3),
  changedAt: instant(3),
  stateChangedAt: instant(3),
  stateChangedBy: id("c", 9),
  stateChangeCorrelationId: id("e", 11),
  revision: 1,
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

describe("owner-only organization invitation-access handoff contract proof", () => {
  it("keeps the test-only handoff out of the shipping Access surface", () => {
    const exports = Object.keys(shippingAccess);
    expect(exports).not.toContain("createOrganizationInvitationAccessOwnerHandoff");
    expect(exports).not.toContain("OrganizationInvitationAccessHandoffError");
    expect(exports).not.toContain("organizationInvitationAccessHandoffErrorCodes");
  });

  it("returns one exact in-transaction create intermediate for delivery only after commit", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationInvitationAccessOwnerHandoff(
      transactionFor(() => [{ invitation: invitation(), access_intent: storedIntent() }], calls),
      () => secret,
    );
    await expect(handoff.create(context(), createCommand())).resolves.toEqual({
      invitation: invitation(),
      accessIntent: storedIntent(),
      invitationSecret: secret,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(
      "vortex_access.coordinate_organization_invitation_with_access_intent",
    );
    expect(calls[0]?.values[0]).toBe("person@example.test");
    expect(calls[0]?.values[1]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(calls[0]?.values).not.toContain(secret);
    expect(calls[0]?.values.slice(2)).toEqual([instant(30), candidateIntent()]);
  });

  it.each([
    ["organization", { access_intent: { ...storedIntent(), organizationId: id("f", 20) } }],
    [
      "inviter",
      { access_intent: { ...storedIntent(), intendedByOrganizationAccountId: id("f", 21) } },
    ],
    [
      "context correlation",
      { access_intent: { ...storedIntent(), intentCorrelationId: id("f", 22) } },
    ],
    ["intended memberships", { access_intent: { ...storedIntent(), membershipIntents: [] } }],
  ])("refuses create storage with substituted %s", async (_name, override) => {
    const handoff = createOrganizationInvitationAccessOwnerHandoff(
      transactionFor(() => [
        { invitation: invitation(), access_intent: storedIntent(), ...override },
      ]),
      () => secret,
    );
    await expect(handoff.create(context(), createCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_INVITATION_ACCESS_STORAGE_RESULT",
    });
  });

  it.each(["accepted", "already_accepted"] as const)(
    "accepts %s linkage for a derived already-existing account without rewriting its origin",
    async (outcome) => {
      const calls: QueryCall[] = [];
      const handoff = createOrganizationInvitationAccessOwnerHandoff(
        transactionFor(
          () => [
            {
              outcome,
              organization_account: account(outcome === "accepted" ? undefined : id("f", 90)),
              invitation_id: id("b", 8),
              membership_ids: [id("d", 4)],
              role_assignment_ids: [id("f", 6)],
              access_version: "4",
              correlation_id: id("e", 11),
            },
          ],
          calls,
        ),
      );
      await expect(handoff.accept(identity(), acceptCommand())).resolves.toMatchObject({
        outcome,
        invitationId: id("b", 8),
        accessVersion: 4,
      });
      expect(calls[0]?.text).toContain(
        "vortex_access.coordinate_organization_invitation_access_acceptance",
      );
      expect(calls[0]?.values[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(calls[0]?.values.slice(1)).toEqual([
        id("c", 9),
        "person@example.test",
        "Person",
        id("e", 11),
      ]);
    },
  );

  it.each(["unavailable", "identity_inactive"] as const)(
    "preserves the closed %s refusal without intent disclosure",
    async (outcome) => {
      const handoff = createOrganizationInvitationAccessOwnerHandoff(
        transactionFor(() => [{ outcome }]),
      );
      await expect(handoff.accept(identity(), acceptCommand())).resolves.toEqual({ outcome });
    },
  );

  it("refuses storage that attaches intent linkage to a closed refusal", async () => {
    const handoff = createOrganizationInvitationAccessOwnerHandoff(
      transactionFor(() => [{ outcome: "unavailable", invitation_id: id("b", 8) }]),
    );
    await expect(handoff.accept(identity(), acceptCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_INVITATION_ACCESS_STORAGE_RESULT",
    });
  });

  it("refuses substituted identity, correlation and malformed acceptance linkage", async () => {
    const base = {
      outcome: "accepted",
      organization_account: account(undefined),
      invitation_id: id("b", 8),
      membership_ids: [id("d", 4)],
      role_assignment_ids: [id("f", 6)],
      access_version: 4,
      correlation_id: id("e", 11),
    };
    for (const row of [
      { ...base, organization_account: { ...account(), identityId: id("f", 30) } },
      { ...base, correlation_id: id("f", 31) },
      { ...base, membership_ids: [], role_assignment_ids: [] },
      { ...base, membership_ids: [id("d", 4), id("d", 4).toUpperCase()] },
    ]) {
      const handoff = createOrganizationInvitationAccessOwnerHandoff(transactionFor(() => [row]));
      await expect(handoff.accept(identity(), acceptCommand())).rejects.toMatchObject({
        code: "INVALID_ORGANIZATION_INVITATION_ACCESS_STORAGE_RESULT",
      });
    }
  });

  it("refuses malformed input and weak secret generation before querying", async () => {
    const query = vi.fn();
    const handoff = createOrganizationInvitationAccessOwnerHandoff({ query }, () => "short");
    await expect(handoff.create(context(), createCommand())).rejects.toMatchObject({
      code: "ORGANIZATION_INVITATION_ACCESS_FAILED",
    });
    await expect(
      handoff.accept(identity(), { ...acceptCommand(), invitationSecret: "short" }),
    ).rejects.toMatchObject({ code: "INVALID_ORGANIZATION_INVITATION_ACCESS_COMMAND" });
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses invalid cardinality and maps SQLSTATE without exposing database detail", async () => {
    const none = createOrganizationInvitationAccessOwnerHandoff(
      transactionFor(() => []),
      () => secret,
    );
    await expect(none.create(context(), createCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_INVITATION_ACCESS_STORAGE_RESULT",
    });
    const failed = createOrganizationInvitationAccessOwnerHandoff({
      query: async () => {
        throw { code: "40001", message: "sensitive database detail" };
      },
    });
    await expect(failed.accept(identity(), acceptCommand())).rejects.toEqual(
      new OrganizationInvitationAccessHandoffError(
        "ORGANIZATION_INVITATION_ACCESS_STALE_OR_UNAVAILABLE",
      ),
    );
  });
});
