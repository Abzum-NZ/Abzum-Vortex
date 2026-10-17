"use client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { ApplicationSourceDocument, ApplicationUsePlace } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@vortex/ui/components/item";
import type { StudioAccessCommand, StudioAccessResult } from "../_lib/application-access";
import { StudioAccessPageGates, StudioAccessPermissionList } from "./studio-access-gates";
import { StudioAccessRoleEditor } from "./studio-access-role";
import { StudioField } from "./studio-field";
import { StudioPanelShell } from "./studio-frame";
import { StudioReferencesAlert } from "./studio-used-in";

type Section = "role" | "pages" | "permissions";
type Feedback = Readonly<{ kind: "applied" | "refused"; message: string; where?: readonly ApplicationUsePlace[] | undefined }>;

/** The outcome of the last edit and, for something still in use, the places that use it with a way to go there. */
function AccessFeedback({ feedback }: Readonly<{ feedback: Feedback | null }>) {
  if (feedback === null) return null;
  if (feedback.kind === "refused" && feedback.where !== undefined && feedback.where.length > 0)
    return <StudioReferencesAlert name="it" title="Nothing was changed" issue={feedback.message} references={feedback.where} />;
  return <p role={feedback.kind === "refused" ? "alert" : "status"}
    className={feedback.kind === "refused" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{feedback.message}</p>;
}

/**
 * The Access tab: the application's roles (access groups), what each holds, which fields it sees and
 * changes, and which permission opens each page and menu entry. The panel lists the roles and the
 * two application-wide views; the centre edits the one chosen. The role shown is the workspace's one
 * selection (a role), so "Used in" and "Show me where" open a role here. Every change is one Access
 * command on the draft, through the workspace's one edit path.
 */
export function useStudioAccessTab({ source, compiledRoles, hidden, disabled, onCommand, onPreview, selectedRole, chooseRole }: Readonly<{
  source: ApplicationSourceDocument;
  /** The permissions the compiled saved draft grants each role, by role key. */
  compiledRoles: Readonly<Record<string, readonly string[]>> | undefined;
  hidden: boolean;
  disabled: boolean;
  onCommand: (command: StudioAccessCommand) => StudioAccessResult;
  /** Shows the canvas and its menu as a role sees them. */
  onPreview: (roleKey: string) => void;
  /** The role the workspace's selection holds, if it is a role. */
  selectedRole: string | null;
  /** Selects a role in the workspace's one selection store. */
  chooseRole: (roleKey: string) => void;
}>): Readonly<{ panel: ReactNode; centre: ReactNode; title: string; showPages: () => void; showRole: () => void }> {
  const roles = source.body.roles;
  const [section, setSection] = useState<Section>("role");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [newRole, setNewRole] = useState("");
  // A role selected anywhere (a "Used in" entry, a refusal's place) is shown at once.
  useEffect(() => { if (selectedRole !== null) setSection("role"); }, [selectedRole]);
  // Without a selected role, or after it was removed by an edit or an undo, the first role is shown.
  const role = roles.find((entry) => entry.key === selectedRole) ?? roles[0];
  const view = section;

  const show = (next: Section, roleKey?: string) => {
    setSection(next); setFeedback(null);
    if (roleKey !== undefined) chooseRole(roleKey);
  };
  const run = (command: StudioAccessCommand): boolean => {
    const result = onCommand(command);
    setFeedback(result.kind === "applied" ? { kind: "applied", message: result.message }
      : { kind: "refused", message: result.message, where: result.where });
    if (result.kind === "applied" && result.roleKey !== undefined) { setSection("role"); chooseRole(result.roleKey); }
    return result.kind === "applied";
  };
  const addRole = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (run({ kind: "add_role", name: newRole })) setNewRole("");
  };

  const choice = (selected: boolean, title: string, description: string, onClick: () => void) =>
    <Item size="sm" variant={selected ? "muted" : "default"}
      render={<button type="button" aria-pressed={selected} onClick={onClick} />}>
      <ItemContent><ItemTitle>{title}</ItemTitle><ItemDescription>{description}</ItemDescription></ItemContent>
    </Item>;
  const panel = <StudioPanelShell title="Access" hidden={hidden}
    description="Roles, what each can do, and who sees each page and menu entry.">
    <section aria-label="Roles" className="space-y-1">
      <h3 className="text-sm font-medium">Roles</h3>
      <ul className="list-none space-y-1">{roles.map((entry) => <li key={entry.key}>
        {choice(view === "role" && role?.key === entry.key, entry.name,
          (entry.permissions.includes("*") ? "Holds every permission"
            : `${entry.permissions.length} ${entry.permissions.length === 1 ? "permission" : "permissions"}`) +
            (entry.default_member === true ? " · default member role" : ""),
          () => show("role", entry.key))}
      </li>)}</ul>
    </section>
    <form className="flex items-end gap-2" onSubmit={addRole}>
      <StudioField label="New role">
        {(control) => <Input {...control} value={newRole} maxLength={60} placeholder="For example: Viewer" disabled={disabled}
          onChange={(event) => setNewRole(event.target.value)} />}
      </StudioField>
      <Button type="submit" size="sm" disabled={disabled || newRole.trim().length === 0}>Add role</Button>
    </form>
    <section aria-label="Across the application" className="space-y-1">
      <h3 className="text-sm font-medium">Across the application</h3>
      <ul className="list-none space-y-1">
        <li>{choice(view === "pages", "Pages and menu", "Which permission opens each page and shows each menu entry.", () => show("pages"))}</li>
        <li>{choice(view === "permissions", "Permissions", "Every permission, who holds it, and adding or removing one.", () => show("permissions"))}</li>
      </ul>
    </section>
  </StudioPanelShell>;

  const centre = <div className="space-y-4">
    <AccessFeedback feedback={feedback} />
    {view === "role" && role !== undefined &&
      <StudioAccessRoleEditor key={role.key} source={source} role={role} compiledGrants={compiledRoles?.[role.key]}
        disabled={disabled} run={run} onPreview={() => onPreview(role.key)} />}
    {view === "pages" && <StudioAccessPageGates source={source} disabled={disabled} run={run} />}
    {view === "permissions" && <StudioAccessPermissionList source={source} disabled={disabled} run={run} />}
  </div>;
  const title = view === "pages" ? "Pages and menu" : view === "permissions" ? "Permissions" : `Role: ${role?.name ?? ""}`;
  return { panel, centre, title, showPages: () => show("pages"), showRole: () => show("role") };
}
