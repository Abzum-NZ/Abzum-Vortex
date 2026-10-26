import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import type { AssignOrganizationAdministrationRoleAssignmentCommand } from "../access/organization-access-administration";
import type { createOrganizationAccessAdministrationService } from "../access/organization-access-administration-access";
import { flowRefusalFeedbackSchema } from "../workflows/flow-refusal-feedback";

type Services = Pick<
  ReturnType<typeof createOrganizationAccessAdministrationService>,
  "readRole" | "readGroup" | "readOrganizationAccount" | "assignRoleAssignment"
>;
type Caller = Readonly<{
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
}>;

const assignmentNames = (
  role: Readonly<{ label: string }>,
  assignee:
    | Readonly<{ kind: "organization_account"; displayName?: string | undefined }>
    | Readonly<{ kind: "group"; label: string }>,
) => ({
  role_name: role.label,
  assignee_name:
    assignee.kind === "organization_account"
      ? (assignee.displayName ?? "This person")
      : assignee.label,
});

/** Reads the same protected names the assignment result returns, without changing authority. */
export const prepareRoleAssignment = async (
  services: Services,
  caller: Caller,
  command: AssignOrganizationAdministrationRoleAssignmentCommand,
) => {
  const role = await services.readRole(caller.session, caller.selection, {
    roleId: command.roleId,
  });
  if (role.kind !== "available") return role;
  if (
    role.value.outcome !== "available" ||
    role.value.role.liveRevision !== command.expectedRoleRevision
  )
    return { kind: "unavailable" } as const;
  if (command.assigneeKind === "organization_account") {
    const person = await services.readOrganizationAccount(caller.session, caller.selection, {
      organizationAccountId: command.organizationAccountId!,
    });
    if (person.kind !== "available") return person;
    if (person.value.outcome !== "available") return { kind: "unavailable" } as const;
    return {
      kind: "available",
      value: assignmentNames(role.value.role, {
        kind: "organization_account",
        displayName: person.value.account.displayName,
      }),
    } as const;
  }
  const group = await services.readGroup(caller.session, caller.selection, {
    groupId: command.groupId!,
  });
  if (group.kind !== "available") return group;
  if (group.value.outcome !== "available") return { kind: "unavailable" } as const;
  return {
    kind: "available",
    value: assignmentNames(role.value.role, { kind: "group", label: group.value.group.label }),
  } as const;
};

export const assignRoleAssignment = async (
  services: Services,
  caller: Caller,
  command: AssignOrganizationAdministrationRoleAssignmentCommand,
) => {
  const result = await services.assignRoleAssignment(caller.session, caller.selection, command);
  if (result.kind === "available" && "outcome" in result.value)
    return {
      kind: "confirmed_failure",
      outcome: "refused",
      diagnostic: flowRefusalFeedbackSchema.parse({ code: result.value.code }),
    } as const;
  if (result.kind !== "available") return result;
  const value = result.value;
  if (!("assignment" in value)) throw new Error("INVALID_ROLE_ASSIGNMENT_RESULT");
  return {
    kind: "available",
    value: {
      role_assignment_id: value.assignment.roleAssignmentId,
      ...assignmentNames(value.assignment.role, value.assignment.assignee),
      revision: value.assignment.revision,
      access_version: value.accessVersion,
    },
  } as const;
};
