"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import {
  currentIso4217Alpha3CodeSetV2026_01_01,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
} from "@vortex/platform/schema";
import {
  StudioInspectorGroup,
  studioPageValueTypes,
  type StudioPageValueCommand,
  type StudioPageValueResult,
  type StudioPageValueType,
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
  organisationCurrency,
  onEdit,
}: Readonly<{
  source: ApplicationSourceDocument;
  pageAlias: string;
  disabled: boolean;
  /** The organisation's currency, offered first for a money value. */
  organisationCurrency: string | undefined;
  onEdit: (command: StudioPageValueCommand) => StudioPageValueResult;
}>) {
  const page = source.body.pages.find((entry) => entry.id === pageAlias);
  const [problem, setProblem] = useState("");
  const [refusedUsers, setRefusedUsers] = useState<readonly ApplicationUsePlace[]>([]);
  const [refusedName, setRefusedName] = useState("");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<StudioPageValueType>("decimal_number");
  const [currency, setCurrency] = useState(organisationCurrency ?? "");
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
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
    }
  };
  return (
    <StudioInspectorGroup title="Page values">
      <p className="text-sm text-muted-foreground">
        Values this page keeps while it is open. Flows set them; displays, messages and conditions
        read them.
      </p>
      {values.length === 0 && <p className="text-sm">This page declares no values yet.</p>}
      {values.map(([key, declaration]) => (
        <div key={key} className="space-y-1.5 rounded-md border p-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0">
              <span className="block truncate font-medium">{declaration.label}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {key} ·{" "}
                {studioPageValueTypes.find((entry) => entry.type === declaration.type)?.label}
                {declaration.currency === undefined ? "" : ` ${declaration.currency}`}
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => run({ kind: "remove", pageAlias, name: key }, declaration.label)}
            >
              Remove
            </Button>
          </div>
          <StudioUsedIn
            source={source}
            target={{ kind: "page_value", pageAlias, name: key }}
            name={declaration.label}
            collapsed
          />
        </div>
      ))}
      {problem !== "" && refusedUsers.length > 0 && (
        <StudioReferencesAlert
          name={refusedName}
          issue={problem}
          references={refusedUsers}
          title={`${refusedName} cannot be changed`}
        />
      )}
      {problem !== "" && refusedUsers.length === 0 && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <form onSubmit={add} className="space-y-2">
        <Label className="text-xs">
          Label
          <Input
            required
            maxLength={60}
            disabled={disabled}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Label>
        <Label className="text-xs">
          Name (lower case, no spaces)
          <Input
            required
            maxLength={60}
            disabled={disabled}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Label>
        <Label className="text-xs">
          Type
          <NativeSelect
            value={type}
            disabled={disabled}
            onChange={(event) => setType(event.target.value as StudioPageValueType)}
          >
            {studioPageValueTypes.map((entry) => (
              <NativeSelectOption key={entry.type} value={entry.type}>
                {entry.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
        {type === "money" && (
          <Label className="text-xs">
            Currency
            <NativeSelect
              value={currency}
              disabled={disabled}
              onChange={(event) => setCurrency(event.target.value)}
            >
              <NativeSelectOption value="">Choose a currency…</NativeSelectOption>
              {currencies.map((code) => (
                <NativeSelectOption key={code} value={code}>
                  {code}
                  {code === organisationCurrency ? " (organisation currency)" : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
        )}
        <Button type="submit" size="sm" variant="outline" disabled={disabled}>
          Add value
        </Button>
      </form>
    </StudioInspectorGroup>
  );
}
