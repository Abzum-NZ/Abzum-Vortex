"use client";
import { useState, type FormEvent } from "react";
import { deriveQueryKey } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { Icon } from "@vortex/ui";
import { useStudioDraftText } from "./use-studio-draft-text";

export type QueryInputChoice = Readonly<{ value: string; label: string }>;

/** The label of one choice, applied as it is typed. Its value stays: bindings refer to it. */
function ChoiceLabel({
  label,
  name,
  disabled,
  commit,
}: Readonly<{
  label: string;
  name: string;
  disabled: boolean;
  commit: (next: string) => string | true;
}>) {
  const text = useStudioDraftText(label, commit);
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <Input
        aria-label={name}
        value={text.text}
        maxLength={60}
        disabled={disabled}
        aria-invalid={text.problem === "" ? undefined : true}
        onChange={(event) => text.change(event.target.value)}
      />
      {text.problem === "" ? null : (
        <p role="alert" className="text-sm text-destructive">
          {text.problem}
        </p>
      )}
    </div>
  );
}

/**
 * Limits a Text input to a list of choices: a label for each, with a value derived from the label
 * once. The list is the input's validation; the server refuses any other value.
 */
export function StudioQueryInputChoices({
  id,
  inputLabel,
  choices,
  disabled,
  onChange,
  onEdit,
}: Readonly<{
  id: string;
  inputLabel: string;
  choices: readonly QueryInputChoice[] | undefined;
  disabled: boolean;
  /** Replaces the list; undefined removes the limit. Returns why the draft refused it. */
  onChange: (next: readonly QueryInputChoice[] | undefined, merge?: string) => string | undefined;
  /** Reports a refusal the control cannot show itself. */
  onEdit: (problem: string | undefined) => void;
}>) {
  const [limited, setLimited] = useState(choices !== undefined);
  const [added, setAdded] = useState("");
  const list = choices ?? [];
  const apply = (next: readonly QueryInputChoice[] | undefined, merge?: string) =>
    onEdit(onChange(next, merge));
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = added.trim();
    const value = deriveQueryKey(label, new Set(list.map((choice) => choice.value)));
    if (value === undefined) {
      onEdit("Choices: enter a name that starts with a letter, for example Open.");
      return;
    }
    apply([...list, { value, label: label.slice(0, 60) }]);
    setAdded("");
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...list];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    apply(next);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-limited`}
          checked={limited}
          disabled={disabled}
          onCheckedChange={(checked) => {
            setLimited(checked === true);
            if (checked !== true && choices !== undefined) apply(undefined);
          }}
        />
        <Label htmlFor={`${id}-limited`} className="font-normal">
          Limit to a list of choices
        </Label>
      </div>
      {limited && (
        <>
          <ul className="list-none space-y-1" aria-label={`Choices of ${inputLabel}`}>
            {list.map((choice, index) => (
              <li key={choice.value} className="flex items-start gap-1">
                <ChoiceLabel
                  label={choice.label}
                  name={`Name of choice ${choice.label}`}
                  disabled={disabled}
                  commit={(next) =>
                    next.trim() === ""
                      ? "Enter the choice's name, for example Open."
                      : (onChange(
                          list.map((item, at) =>
                            at === index ? { ...item, label: next.trim().slice(0, 60) } : item,
                          ),
                          `query-input-choice:${id}:${choice.value}`,
                        ) ?? true)
                  }
                />
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Move choice ${choice.label} up`}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <Icon name="arrow-up" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Move choice ${choice.label} down`}
                  disabled={disabled || index === list.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <Icon name="arrow-down" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove choice ${choice.label}`}
                  disabled={disabled || list.length === 1}
                  onClick={() => apply(list.filter((_, at) => at !== index))}
                >
                  <Icon name="close" />
                </Button>
              </li>
            ))}
          </ul>
          <form className="flex items-end gap-2" onSubmit={add} aria-label="New choice">
            <Input
              aria-label={`Name of a new choice for ${inputLabel}`}
              placeholder="New choice, for example Open"
              value={added}
              maxLength={60}
              disabled={disabled}
              className="min-w-0 flex-1"
              onChange={(event) => setAdded(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={disabled || added.trim() === ""}
            >
              Add choice
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
