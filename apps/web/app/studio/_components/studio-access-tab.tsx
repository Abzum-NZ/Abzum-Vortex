"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@vortex/ui/components/item";
import type { StudioAccessCommand, StudioAccessPlace, StudioAccessResult } from "../_lib/application-access";
import { StudioAccessPageGates, StudioAccessPermissionList } from "./studio-access-gates";
import { StudioAccessRoleEditor } from "./studio-access-role";
import { StudioField } from "./studio-field";
import { StudioPanelShell } from "./studio-frame";

type View = Readonly<{ kind: "role"; roleKey: string } | { kind: "pages" } | { kind: "permissions" }>;
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
 * two application-wide views; the centre edits the one chosen. Every change is one Access command
 * on the draft, through the workspace's one edit path.
 */
export function useStudioAccessTab({ source, compiledRoles, hidden, disabled, onCommand, onPreview, goTo }: Readonly<{
  source: ApplicationSourceDocument;
  /** The permissions the compiled saved draft grants each role, by role key. */
  compiledRoles: Readonly<Record<string, readonly string[]>> | undefined;
  hidden: boolean;
  disabled: boolean;
  onCommand: (command: StudioAccessCommand) => StudioAccessResult;
  /** Shows the canvas and its menu as a role sees them. */
  onPreview: (roleKey: string) => void;
  /** Opens a place outside this tab that uses a role or permission. */
  goTo: (place: Exclude<StudioAccessPlace, { kind: "role" | "other" }>) => void;
}>): Readonly<{ panel: ReactNode; centre: ReactNode; title: string }> {
  const roles = source.body.roles;
  const [chosen, setChosen] = useState<View>({ kind: "role", roleKey: roles[0]?.key ?? "" });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [newRole, setNewRole] = useState("");
  // A role removed by an edit or an undo falls back to the first role.
  const view: View = chosen.kind === "role" && !roles.some((role) => role.key === chosen.roleKey)
    ? { kind: "role", roleKey: roles[0]?.key ?? "" } : chosen;
  const role = view.kind === "role" ? roles.find((entry) => entry.key === view.roleKey) : undefined;

  const show = (next: View) => { setChosen(next); setFeedback(null); };
  const run = (command: StudioAccessCommand): boolean => {
    const result = onCommand(command);
    setFeedback(result.kind === "applied" ? { kind: "applied", message: result.message }
      : { kind: "refused", message: result.message, where: result.where });
    if (result.kind === "applied" && result.roleKey !== undefined) setChosen({ kind: "role", roleKey: result.roleKey });
    return result.kind === "applied";
  };
  const go = (place: StudioAccessPlace) => {
    if (place.kind === "role") { setChosen({ kind: "role", roleKey: place.roleKey }); return; }
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
        {choice(view.kind === "role" && view.roleKey === entry.key, entry.name,
          entry.permissions.includes("*") ? "Holds every permission"
            : `${entry.permissions.length} ${entry.permissions.length === 1 ? "permission" : "permissions"}`,
          () => show({ kind: "role", roleKey: entry.key }))}
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
        <li>{choice(view.kind === "pages", "Pages and menu", "Which permission opens each page and shows each menu entry.", () => show({ kind: "pages" }))}</li>
        <li>{choice(view.kind === "permissions", "Permissions", "Every permission, who holds it, and adding or removing one.", () => show({ kind: "permissions" }))}</li>
      </ul>
    </section>
  </StudioPanelShell>;

  const centre = <div className="space-y-4">
    <AccessFeedback feedback={feedback} goTo={go} />
    {view.kind === "role" && role !== undefined &&
      <StudioAccessRoleEditor key={role.key} source={source} role={role} compiledGrants={compiledRoles?.[role.key]}
        disabled={disabled} run={run} onPreview={() => onPreview(role.key)} />}
    {view.kind === "pages" && <StudioAccessPageGates source={source} disabled={disabled} run={run} />}
    {view.kind === "permissions" && <StudioAccessPermissionList source={source} disabled={disabled} run={run} />}
  </div>;
  const title = view.kind === "pages" ? "Pages and menu" : view.kind === "permissions" ? "Permissions" : `Role: ${role?.name ?? ""}`;
  return { panel, centre, title };
}
