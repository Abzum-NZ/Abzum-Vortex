"use client";

import { useId, type ReactElement } from "react";
import type { RecordsTableFieldFacts } from "@vortex/platform/schema";
import { Label } from "../../components/label";
import { Switch } from "../../components/switch";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../components/item";

/** One field selection control for row edits, cell edits and range totals, including removed choices. */
export function StudioGridFieldPicker({
  fields,
  chosen,
  disabled,
  reason,
  onChange,
}: Readonly<{
  fields: readonly RecordsTableFieldFacts[];
  chosen: readonly string[];
  disabled: boolean;
  reason: (field: RecordsTableFieldFacts) => string | undefined;
  onChange: (fields: readonly string[]) => void;
}>): ReactElement {
  const id = useId();
  const entries = [
    ...fields.map((field) => ({ key: field.field, label: field.label, reason: reason(field) })),
    ...chosen
      .filter((key) => !fields.some((field) => field.field === key))
      .map((key) => ({
        key,
        label: "A removed item",
        reason: "Choose another field or remove this entry.",
      })),
  ];
  return (
    <ItemGroup className="gap-1">
      {entries.map((field, index) => {
        const selected = chosen.includes(field.key);
        const switchId = `${id}-${index}`;
        return (
          <Item key={field.key} size="sm" className="px-0">
            <ItemContent>
              <ItemTitle>
                <Label htmlFor={switchId}>{field.label}</Label>
              </ItemTitle>
              {field.reason === undefined ? null : (
                <ItemDescription id={`${switchId}-reason`}>{field.reason}</ItemDescription>
              )}
            </ItemContent>
            <ItemActions>
              <Switch
                id={switchId}
                checked={selected}
                aria-describedby={field.reason === undefined ? undefined : `${switchId}-reason`}
                disabled={disabled || (!selected && field.reason !== undefined)}
                onCheckedChange={(on) =>
                  onChange(on ? [...chosen, field.key] : chosen.filter((key) => key !== field.key))
                }
              />
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
  );
}
