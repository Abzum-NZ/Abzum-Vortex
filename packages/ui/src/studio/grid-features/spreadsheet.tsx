"use client";

import { useId, type ReactElement } from "react";
import type { SourceBlockPropertyValueContract } from "@vortex/platform/schema";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "../../components/item";
import { Label } from "../../components/label";
import { Switch } from "../../components/switch";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/** Compact controls share the authored feature group the runtime reads. */
export function StudioSpreadsheetEditor({
  value,
  disabled,
  onChange,
}: Readonly<{
  value: Group;
  disabled: boolean;
  onChange: (next: Group) => void;
}>): ReactElement {
  const id = useId();
  return (
    <ItemGroup className="gap-1 pb-2">
      {(
        [
          ["range_select", "Range selection"],
          ["find", "Find on page"],
        ] as const
      ).map(([key, label]) => {
        const setting = value.properties[key];
        if (setting?.kind !== "boolean")
          throw new Error(`Spreadsheet setting ${key} is incomplete`);
        return (
          <Item key={key} size="sm" className="px-0">
            <ItemContent>
              <ItemTitle>
                <Label htmlFor={`${id}-${key}`}>{label}</Label>
              </ItemTitle>
            </ItemContent>
            <ItemActions>
              <Switch
                id={`${id}-${key}`}
                checked={setting.value}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange({
                    kind: "group",
                    properties: { ...value.properties, [key]: { kind: "boolean", value: checked } },
                  })
                }
              />
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
  );
}
