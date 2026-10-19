"use client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { ApplicationSourceDocument, ApplicationUsePlace } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Icon } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverTitle,
} from "@vortex/ui/components/popover";
import { StudioNavItem } from "./studio-nav-tree";
import { toast } from "@vortex/ui/components/sonner";
import type {
  StudioAccessCommand,
  StudioAccessResult,
  StudioSemanticSelection,
} from "@vortex/ui/studio";
import { StudioAccessPageGates, StudioAccessPermissionList } from "./studio-access-gates";
import { StudioAccessRoleEditor } from "./studio-access-role";
import { StudioField } from "./studio-field";
import { StudioPanelShell, StudioSection } from "./studio-frame";
import { StudioReferencesAlert } from "./studio-used-in";

/** What the centre edits: the selected role, or one of the two application-wide views. */
type View = "role" | "pages" | "permissions";
type Feedback = Readonly<{
  kind: "applied" | "refused";
  message: string;
  where?: readonly ApplicationUsePlace[] | undefined;
}>;

/** The outcome of the last edit and, for something still in use, the places that use it with a way to go there. */
function AccessFeedback({ feedback }: Readonly<{ feedback: Feedback | null }>) {
  if (feedback === null) return null;
  if (feedback.kind === "refused" && feedback.where !== undefined && feedback.where.length > 0)
    return (
      <StudioReferencesAlert
        name="it"
        title="Nothing was changed"
        issue={feedback.message}
        references={feedback.where}
      />
    );
  return (
    <p
      role={feedback.kind === "refused" ? "alert" : "status"}
      className={
        feedback.kind === "refused" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
      }
    >
      {feedback.message}
    </p>
  );
}

/**
 * The Access tab: the application's roles (access groups), what each holds, which fields it sees and
 * changes, and which permission opens each page and menu entry. The panel lists the roles and the
 * two application-wide views; the centre edits the one chosen. The role shown is the workspace's one
 * selection (a role), so "Used in" and "Show me where" open a role here. Every change is one Access
 * command on the draft, through the workspace's one edit path.
 */
export function useStudioAccessTab({
  source,
  selected,
  select,
  compiledRoles,
  hidden,
  disabled,
  onCommand,
  onPreview,
}: Readonly<{
  source: ApplicationSourceDocument;
  /** The workspace's one selection; a role selection opens that role. */
  selected: StudioSemanticSelection | null;
  select: (selection: StudioSemanticSelection) => boolean;
  /** The permissions the compiled saved draft grants each role, by role key. */
  compiledRoles: Readonly<Record<string, readonly string[]>> | undefined;
  hidden: boolean;
  disabled: boolean;
  onCommand: (command: StudioAccessCommand, merge?: string) => StudioAccessResult;
  /** Shows the canvas and its menu as a role sees them. */
  onPreview: (roleKey: string) => void;
}>): Readonly<{
  panel: ReactNode;
  centre: ReactNode;
  title: string;
  showPages: () => void;
  showRole: () => void;
}> {
  const roles = source.body.roles;
  const [view, setView] = useState<View>("role");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [newRole, setNewRole] = useState("");
  const [addingRole, setAddingRole] = useState(false);
  // A role selected anywhere (a "Used in" entry, a refusal's place) is shown at once.
  const selectedRoleKey = selected?.kind === "role" ? selected.roleKey : null;
  useEffect(() => {
    if (selectedRoleKey !== null) setView("role");
  }, [selectedRoleKey]);
  // Without a selected role, or after it was removed by an edit or an undo, the first role is shown.
  const role =
    view === "role"
      ? (roles.find((entry) => entry.key === selectedRoleKey) ?? roles[0])
      : undefined;

  const showRole = (key: string) => {
    setView("role");
    setFeedback(null);
    select({ kind: "role", roleKey: key });
  };
  const show = (next: Exclude<View, "role">) => {
    setView(next);
    setFeedback(null);
  };
  const run = (command: StudioAccessCommand, merge?: string): boolean => {
    const result = onCommand(command, merge);
    if (result.kind === "applied") {
      setFeedback(null);
      if (command.kind !== "rename_role") toast.success(result.message);
    } else setFeedback({ kind: "refused", message: result.message, where: result.where });
    if (result.kind === "applied" && result.roleKey !== undefined) {
      setView("role");
      select({ kind: "role", roleKey: result.roleKey });
    }
    return result.kind === "applied";
  };
  const addRole = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (run({ kind: "add_role", name: newRole })) {
      setNewRole("");
      setAddingRole(false);
    }
  };

  const panel = (
    <StudioPanelShell
      title="Access"
      hidden={hidden}
      action={
        <Popover open={addingRole} onOpenChange={setAddingRole}>
          <PopoverTrigger
            render={<Button type="button" size="sm" variant="secondary" disabled={disabled} />}
          >
            <Icon name="plus" />
            Role
          </PopoverTrigger>
          <PopoverContent align="end">
            <PopoverTitle>Add role</PopoverTitle>
            <form className="space-y-4" onSubmit={addRole}>
              <StudioField label="Role name">
                {(control) => (
                  <Input
                    {...control}
                    value={newRole}
                    maxLength={60}
                    autoFocus
                    disabled={disabled}
                    onChange={(event) => setNewRole(event.target.value)}
                  />
                )}
              </StudioField>
              {feedback?.kind === "refused" && <AccessFeedback feedback={feedback} />}
              <Button type="submit" disabled={disabled || newRole.trim().length === 0}>
                Add role
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      }
    >
      <StudioSection title="Roles" count={roles.length}>
        <ul className="m-0 list-none space-y-1 p-0">
          {roles.map((entry) => (
            <li key={entry.key}>
              <StudioNavItem
                label={entry.name}
                icon="shield"
                selected={view === "role" && role?.key === entry.key}
                description={
                  entry.permissions.includes("*")
                    ? "Every permission"
                    : `${entry.permissions.length} permissions`
                }
                meta={entry.default_member ? <Badge variant="outline">Default</Badge> : undefined}
                onClick={() => showRole(entry.key)}
              />
            </li>
          ))}
        </ul>
      </StudioSection>
      <StudioSection title="Across the application">
        <StudioNavItem
          label="Pages and menu"
          icon="grid"
          selected={view === "pages"}
          onClick={() => show("pages")}
        />
        <StudioNavItem
          label="Permissions"
          icon="shield"
          selected={view === "permissions"}
          onClick={() => show("permissions")}
        />
      </StudioSection>
    </StudioPanelShell>
  );

  const centre = (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-8 py-6">
      <AccessFeedback feedback={feedback} />
      {view === "role" && role !== undefined && (
        <StudioAccessRoleEditor
          key={role.key}
          source={source}
          role={role}
          compiledGrants={compiledRoles?.[role.key]}
          disabled={disabled}
          run={run}
          onPreview={() => onPreview(role.key)}
        />
      )}
      {view === "pages" && <StudioAccessPageGates source={source} disabled={disabled} run={run} />}
      {view === "permissions" && (
        <StudioAccessPermissionList source={source} disabled={disabled} run={run} />
      )}
    </div>
  );
  const title =
    view === "pages"
      ? "Pages and menu"
      : view === "permissions"
        ? "Permissions"
        : `Role: ${role?.name ?? ""}`;
  return {
    panel,
    centre,
    title,
    showPages: () => show("pages"),
    showRole: () => {
      setView("role");
      setFeedback(null);
    },
  };
}
