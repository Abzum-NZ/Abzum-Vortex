"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "@vortex/ui/studio";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@vortex/ui/components/item";
import type { StudioAccessCommand, StudioAccessPlace, StudioAccessResult } from "@vortex/ui/studio";
import { StudioAccessPageGates, StudioAccessPermissionList } from "./studio-access-gates";
import { StudioAccessRoleEditor } from "./studio-access-role";
import { StudioField } from "./studio-field";
import { StudioPanelShell } from "./studio-frame";

/** What the centre edits: the selected role, or one of the two application-wide views. */
type View = "role" | "pages" | "permissions";
type Feedback = Readonly<{ kind: "applied" | "refused"; message: string; where?: readonly StudioAccessPlace[] | undefined }>;

/** The outcome of the last edit and, for something still in use, the places that use it with a way to go there. */
function AccessFeedback({ feedback, goTo }: Readonly<{ feedback: Feedback | null; goTo: (place: StudioAccessPlace) => void }>) {
  if (feedback === null) return null;
  return <div className="space-y-2">
    <p role={feedback.kind === "refused" ? "alert" : "status"}
      className={feedback.kind === "refused" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{feedback.message}</p>
    {feedback.where !== undefined && feedback.where.length > 0 && <div className="space-y-1 rounded-md border border-border p-3">
      <p className="text-sm font-medium">Show me where</p>
      <ul className="space-y-1">{feedback.where.map((place, index) => <li key={index} className="flex items-center justify-between gap-2 text-sm">
        <span>{place.label}</span>
        {place.kind !== "other" && <Button type="button" size="sm" variant="outline" onClick={() => goTo(place)}>Show me</Button>}
      </li>)}</ul>
    </div>}
  </div>;
}

/**
 * The Access tab: the application's roles (access groups), what each holds, which fields it sees and
 * changes, and which permission opens each page and menu entry. The panel lists the roles and the
 * two application-wide views; the centre edits the one chosen. A role is chosen through the
 * workspace's one selection store. Every change is one Access command on the draft, through the
 * workspace's one edit path.
 */
export function useStudioAccessTab({ source, selected, select, compiledRoles, hidden, disabled, onCommand, onPreview, goTo }: Readonly<{
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
  /** Opens a place outside this tab that uses a role or permission. */
  goTo: (place: Exclude<StudioAccessPlace, { kind: "role" | "other" }>) => void;
}>): Readonly<{ panel: ReactNode; centre: ReactNode; title: string; showPages: () => void }> {
  const roles = source.body.roles;
  const [view, setView] = useState<View>("role");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [newRole, setNewRole] = useState("");
  // The selected role, or the first role while something else is selected.
  const roleKey = selected?.kind === "role" ? selected.roleKey : roles[0]?.key;
  const role = view === "role" ? roles.find((entry) => entry.key === roleKey) : undefined;

  const showRole = (key: string) => { setView("role"); setFeedback(null); select({ kind: "role", roleKey: key }); };
  const show = (next: Exclude<View, "role">) => { setView(next); setFeedback(null); };
  const run = (command: StudioAccessCommand, merge?: string): boolean => {
    const result = onCommand(command, merge);
    setFeedback(result.kind === "applied" ? { kind: "applied", message: result.message }
      : { kind: "refused", message: result.message, where: result.where });
    if (result.kind === "applied" && result.roleKey !== undefined) { setView("role"); select({ kind: "role", roleKey: result.roleKey }); }
    return result.kind === "applied";
  };
  const go = (place: StudioAccessPlace) => {
    if (place.kind === "role") { showRole(place.roleKey); return; }
    if (place.kind !== "other") goTo(place);
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
        {choice(view === "role" && roleKey === entry.key, entry.name,
          (entry.permissions.includes("*") ? "Holds every permission"
            : `${entry.permissions.length} ${entry.permissions.length === 1 ? "permission" : "permissions"}`) +
            (entry.default_member === true ? " · default member role" : ""),
          () => showRole(entry.key))}
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
    <AccessFeedback feedback={feedback} goTo={go} />
    {view === "role" && role !== undefined &&
      <StudioAccessRoleEditor key={role.key} source={source} role={role} compiledGrants={compiledRoles?.[role.key]}
        disabled={disabled} run={run} onPreview={() => onPreview(role.key)} />}
    {view === "pages" && <StudioAccessPageGates source={source} disabled={disabled} run={run} />}
    {view === "permissions" && <StudioAccessPermissionList source={source} disabled={disabled} run={run} />}
  </div>;
  const title = view === "pages" ? "Pages and menu" : view === "permissions" ? "Permissions" : `Role: ${role?.name ?? ""}`;
  return { panel, centre, title, showPages: () => show("pages") };
}
