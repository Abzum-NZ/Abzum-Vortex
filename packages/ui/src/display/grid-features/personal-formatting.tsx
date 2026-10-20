"use client";

import { useId, useMemo, useState, type ReactElement } from "react";
import {
  conditionalFormatFactsOf,
  conditionalFormatRuleIssue,
  GRID_VIEW_MAXIMUM_FORMAT_RULES,
  type ConditionNode,
  type GridLayout,
  type GridViewCommand,
  type GridViewCommandResult,
  type GridViewFormatRule,
  type GridViewsState,
  type SelectedGridView,
} from "@vortex/platform/schema";
import { Button } from "../../components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/dialog";
import { Label } from "../../components/label";
import { Switch } from "../../components/switch";
import { Icon } from "../../icons/icon";
import { cn } from "../../lib/utils";
import { StudioConditionControls } from "../../studio/condition-controls";
import { createInitialStudioCondition, describeCondition } from "../../studio/condition-model";
import {
  ConditionalFormatStyleControls,
  ConditionalFormatStyleSwatch,
  conditionalFormatConditionContext,
  type ConditionalFormatRuleChange,
} from "../../studio/conditional-format-rule-controls";

/**
 * A person's formatting rules for the view they have open: the same rule parts, condition controls
 * and swatches as the Studio Formatting editor, over only the fields the person may read. Saving
 * stores the rules in the one view document; the server checks them against the person's current
 * access and evaluates them with the authored rules, so the grid draws only the styles.
 */
export function PersonalFormattingDialog({
  selected,
  fields,
  arrangement,
  request,
  onClose,
}: Readonly<{
  selected: SelectedGridView;
  fields: NonNullable<GridViewsState["formattingFields"]>;
  arrangement: GridLayout;
  request: (command: GridViewCommand) => Promise<GridViewCommandResult>;
  onClose: () => void;
}>): ReactElement {
  const ownId = useId();
  const [rules, setRules] = useState<readonly GridViewFormatRule[]>(
    selected.document.formatting ?? [],
  );
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const context = useMemo(() => conditionalFormatConditionContext(fields), [fields]);
  const facts = useMemo(() => conditionalFormatFactsOf(fields), [fields]);
  const labelOf = (fieldId: string): string =>
    fields.find((field) => String(field.fieldId).toLowerCase() === fieldId.toLowerCase())?.label ??
    fieldId;
  const issueOf = (rule: GridViewFormatRule): string | undefined =>
    conditionalFormatRuleIssue(rule, facts);
  const invalid = rules.some((rule) => issueOf(rule) !== undefined);
  const active = rules.find((rule) => rule.id === activeId);
  const change = (id: string, next: (rule: GridViewFormatRule) => GridViewFormatRule): void =>
    setRules(rules.map((rule) => (rule.id === id ? next(rule) : rule)));
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= rules.length) return;
    const next = [...rules];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) next.splice(to, 0, moved);
    setRules(next);
  };
  const initial = createInitialStudioCondition(context);
  const add = (): void => {
    if (initial === undefined) return;
    const rule: GridViewFormatRule = {
      id: crypto.randomUUID(),
      enabled: true,
      condition: initial,
      target: { kind: "row" },
      style: { token: "info", tint: true, text: false, bold: false, strike: false, icon: "info" },
      stopIfTrue: false,
    };
    setRules([...rules, rule]);
    setActiveId(rule.id);
  };
  const apply = (rule: GridViewFormatRule, changes: ConditionalFormatRuleChange): void =>
    change(rule.id, (held) => ({
      ...held,
      ...(changes.target === undefined ? {} : { target: changes.target }),
      ...(changes.style === undefined ? {} : { style: changes.style }),
      ...(changes.stopIfTrue === undefined ? {} : { stopIfTrue: changes.stopIfTrue }),
    }));
  const summary = (rule: GridViewFormatRule): string =>
    describeCondition(rule.condition, context);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Formatting for “{selected.name}”</DialogTitle>
          <DialogDescription>
            Highlight the rows or cells of this view that match a condition. For each row or cell
            the first matching rule wins, after the rules the table already has. People you share
            the view with see the rules on the fields their role can read.
          </DialogDescription>
        </DialogHeader>
        <section aria-labelledby={`${ownId}-rules`} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 id={`${ownId}-rules`} className="text-sm font-medium">
              Rules
            </h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || initial === undefined || rules.length >= GRID_VIEW_MAXIMUM_FORMAT_RULES}
              onClick={add}
            >
              <Icon name="plus" aria-hidden="true" />
              Add rule
            </Button>
          </div>
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rules yet.</p>
          ) : (
            <ol aria-label="Formatting rules" className="flex flex-col gap-1">
              {rules.map((rule, index) => {
                const issue = issueOf(rule);
                const switchId = `${ownId}-rule-${index}`;
                return (
                  <li
                    key={rule.id}
                    className={cn(
                      "flex items-start gap-2 rounded-md p-2",
                      activeId === rule.id && "bg-accent text-accent-foreground",
                      !rule.enabled && "opacity-60",
                    )}
                  >
                    <ConditionalFormatStyleSwatch style={rule.style} />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left text-sm"
                      aria-expanded={activeId === rule.id}
                      onClick={() => setActiveId(activeId === rule.id ? undefined : rule.id)}
                    >
                      <span className="block truncate">{summary(rule)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {rule.target.kind === "row"
                          ? "Whole row"
                          : rule.target.fields.map(labelOf).join(", ") || "No cells"}
                        {rule.stopIfTrue ? " · stops" : ""}
                      </span>
                      {issue === undefined ? null : (
                        <span role="alert" className="block text-xs text-destructive">
                          {issue}
                        </span>
                      )}
                    </button>
                    <Label htmlFor={switchId} className="sr-only">
                      Apply rule {index + 1}
                    </Label>
                    <Switch
                      id={switchId}
                      checked={rule.enabled}
                      disabled={busy}
                      onCheckedChange={(on: boolean) =>
                        change(rule.id, (held) => ({ ...held, enabled: on }))
                      }
                    />
                    <div className="flex shrink-0 items-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move rule ${index + 1} up`}
                        disabled={busy || index === 0}
                        onClick={() => move(index, index - 1)}
                      >
                        <Icon name="arrow-up" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move rule ${index + 1} down`}
                        disabled={busy || index === rules.length - 1}
                        onClick={() => move(index, index + 1)}
                      >
                        <Icon name="arrow-down" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete rule ${index + 1}`}
                        disabled={busy}
                        onClick={() => {
                          setRules(rules.filter((held) => held.id !== rule.id));
                          if (activeId === rule.id) setActiveId(undefined);
                        }}
                      >
                        <Icon name="close" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        {active === undefined ? null : (
          <section
            key={active.id}
            aria-label="Rule details"
            className="flex flex-col gap-3 border-t pt-3"
          >
            <fieldset disabled={busy} className="min-w-0">
              <StudioConditionControls
                label="Rule condition"
                context={context}
                value={active.condition}
                onChange={(next: ConditionNode | undefined, validation) => {
                  // An unfinished condition stays on screen in the controls; only a valid one is kept.
                  if (next === undefined || !validation.isValid) return;
                  change(active.id, (held) => ({ ...held, condition: next }));
                }}
              />
            </fieldset>
            <ConditionalFormatStyleControls
              idPrefix={`${ownId}-active`}
              target={active.target}
              style={active.style}
              stopIfTrue={active.stopIfTrue}
              cellOptions={fields.map((field) => ({
                value: String(field.fieldId).toLowerCase(),
                label: field.label,
              }))}
              disabled={busy}
              onChange={(changes) => apply(active, changes)}
            />
          </section>
        )}
        {refused === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {refused}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || invalid}
            onClick={() => {
              setBusy(true);
              setRefused(undefined);
              void request({
                kind: "save",
                viewId: selected.viewId,
                expectedRevision: selected.revision,
                layout: arrangement,
                formatting: rules,
              }).then((result) => {
                setBusy(false);
                if (result.outcome === "formatting_refused") setRefused(result.reason);
                else if (result.outcome !== "unavailable") onClose();
              });
            }}
          >
            Save formatting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
