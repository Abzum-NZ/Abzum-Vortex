"use client";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { useState } from "react";
import { Input } from "@vortex/ui/components/input";
import {
  currentIso4217Alpha3CodeSetV2026_01_01,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
} from "@vortex/platform/schema";
import {
  StudioDialog,
  StudioField,
  StudioAddButton,
  StudioRemoveButton,
  StudioInspectorGroup,
  studioPageValueTypes,
  type StudioPageValueCommand,
  type StudioPageValueResult,
  type StudioPageValueType,
  StudioOptionControl,
} from "@vortex/ui/studio";
import { StudioReferencesAlert, StudioUsedIn } from "./studio-used-in";

const currencies = [...currentIso4217Alpha3CodeSetV2026_01_01].sort();

/**
 * The values a page declares: their name, label, type (and currency for money). A value that a
 * flow, a display or a condition uses cannot be removed; the refusal names who uses it.
 */
export function StudioPageValuesPanel({
  source,
  pageAlias,
  disabled,
  onEdit,
}: Readonly<{
  source: ApplicationSourceDocument;
  pageAlias: string;
  disabled: boolean;
  onEdit: (command: StudioPageValueCommand) => StudioPageValueResult;
}>) {
  const page = source.body.pages.find((entry) => entry.id === pageAlias);
  const [problem, setProblem] = useState("");
  const [refusedUsers, setRefusedUsers] = useState<readonly ApplicationUsePlace[]>([]);
  const [refusedName, setRefusedName] = useState("");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<StudioPageValueType>("decimal_number");
  const [currency, setCurrency] = useState("");
  const [adding, setAdding] = useState(false);
  if (page === undefined) return null;
  const values = Object.entries(page.values ?? {});
  const run = (command: StudioPageValueCommand, subject: string): boolean => {
    const result = onEdit(command);
    if (result.kind === "applied") {
      setProblem("");
      setRefusedUsers([]);
      return true;
    }
    setProblem(result.reason);
    setRefusedUsers(result.users ?? []);
    setRefusedName(subject);
    return false;
  };
  const add = () => {
    if (
      run(
        {
          kind: "add",
          pageAlias,
          name,
          label,
          type,
          ...(type === "money" && currency !== "" ? { currency } : {}),
        },
        label,
      )
    ) {
      setName("");
      setLabel("");
      setAdding(false);
    }
  };
  const refusal =
    problem === "" ? null : refusedUsers.length > 0 ? (
      <StudioReferencesAlert
        name={refusedName}
        issue={problem}
        references={refusedUsers}
        title={`${refusedName} cannot be changed`}
        onBeforeOpen={() => setAdding(false)}
      />
    ) : (
      <Alert variant="destructive">
        <AlertDescription>{problem}</AlertDescription>
      </Alert>
    );
  return (
    <StudioInspectorGroup
      title="Page values"
      defaultOpen={false}
      hint="Values this page keeps while it is open. Flows set them; displays, messages and conditions read them."
      summary={values.length === 1 ? "1 value" : `${values.length} values`}
      action={
        <StudioAddButton
          label="Add value"
          disabled={disabled}
          onClick={() => {
            setProblem("");
            setRefusedUsers([]);
            setAdding(true);
          }}
        />
      }
    >
      {!adding && refusal}
      {values.length === 0 && (
        <p className="text-sm text-muted-foreground">This page declares no values yet.</p>
      )}
      {values.map(([key, declaration]) => (
        <div key={key} className="space-y-1 rounded-md border px-2 py-1.5 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0">
              <span className="block truncate font-medium">{declaration.label}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {key} ·{" "}
                {studioPageValueTypes.find((entry) => entry.type === declaration.type)?.label}
                {declaration.currency === undefined ? "" : ` ${declaration.currency}`}
              </span>
            </span>
            <StudioRemoveButton
              label="Remove value"
              disabled={disabled}
              onClick={() => run({ kind: "remove", pageAlias, name: key }, declaration.label)}
            />
          </div>
          <StudioUsedIn
            source={source}
            target={{ kind: "page_value", pageAlias, name: key }}
            name={declaration.label}
          />
        </div>
      ))}
      <StudioDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add page value"
        submitLabel="Add value"
        submitDisabled={disabled}
        onSubmit={add}
      >
        {adding && refusal}
        <StudioField label="Label">
          {(control) => (
            <Input
              {...control}
              required
              maxLength={60}
              disabled={disabled}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          )}
        </StudioField>
        <StudioField label="Name" hint="Lower case, no spaces">
          {(control) => (
            <Input
              {...control}
              required
              maxLength={60}
              disabled={disabled}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </StudioField>
        <StudioField label="Type">
          {(control) => (
            <StudioOptionControl
              {...control}
              value={type}
              disabled={disabled}
              options={studioPageValueTypes.map((entry) => ({
                value: entry.type,
                label: entry.label,
              }))}
              onChange={(value) => setType(value as StudioPageValueType)}
            />
          )}
        </StudioField>
        {type === "money" && (
          <StudioField label="Currency">
            {(control) => (
              <StudioOptionControl
                {...control}
                value={currency}
                disabled={disabled}
                unset="Choose a currency…"
                options={currencies.map((code) => ({ value: code, label: code }))}
                onChange={setCurrency}
              />
            )}
          </StudioField>
        )}
      </StudioDialog>
    </StudioInspectorGroup>
  );
}
