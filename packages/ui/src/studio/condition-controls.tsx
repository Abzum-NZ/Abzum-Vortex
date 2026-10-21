"use client";
import { StudioReferencePicker } from "./studio-reference-picker";
import { StudioField } from "./studio-field";
import { Button } from "@vortex/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vortex/ui/components/dropdown-menu";
import { Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { StudioOptionControl } from "./studio-setting-controls";
import { StudioOptionsControl } from "./studio-options-control";
import { StudioEntryList, StudioIconButton, useStudioEntryKeys } from "./studio-entry-list";
import { StudioInspectorActions } from "./studio-inspector-actions";
import {
  conditionMaximumNestingDepth,
  conditionMaximumOperandCount,
  type ConditionNode,
  type JsonValue,
} from "@vortex/platform/schema";
import {
  type ConditionOperand,
  type ConditionOperator,
  type ConditionPath,
  type StudioConditionControlsContext,
  type StudioConditionValidation,
  type StudioConditionValidationIssue,
  choiceOptionsFor,
  conditionDepth,
  conditionLevelForPath,
  conditionOperandCount,
  contextOperandToken,
  createInitialStudioCondition,
  defaultLiteralForType,
  defaultRightForOperator,
  describeCondition,
  displayRole,
  errorForPath,
  hasLiteralAtPath,
  infoForExpectedLiteral,
  infoForOperand,
  isCollectionElementType,
  isComparisonCondition,
  literalOperand,
  makeIssue,
  maximumGroupChildren,
  operandToken,
  operatorAcceptsOperands,
  operatorOptions,
  pathEquals,
  pathStartsWith,
  pointerForPath,
  studioConditionOperatorsFor,
  unaryOperators,
  usesChoiceOptionControl,
  validateStudioCondition,
  withDraftIssues,
} from "./condition-model";
import { LiteralEditor } from "./condition-literal-editor";

type ChildListChange = Readonly<{ path: ConditionPath; from: number; to: number | null }>;

type TreeEditorProps = Readonly<{
  condition: ConditionNode;
  context: StudioConditionControlsContext;
  validation: StudioConditionValidation;
  path: ConditionPath;
  remainingOperandCount: number;
  onReplace: (
    condition: ConditionNode,
    resolvedPath?: ConditionPath,
    childListChange?: ChildListChange,
  ) => void;
  onInvalid: (issue: StudioConditionValidationIssue) => void;
}>;

function TreeEditor({
  condition,
  context,
  validation,
  path,
  remainingOperandCount,
  onReplace,
  onInvalid,
}: TreeEditorProps) {
  const { keys, newKey } = useStudioEntryKeys(
    condition.kind === "all" || condition.kind === "any" ? condition.conditions.length : 0,
  );
  if (condition.kind === "all" || condition.kind === "any") {
    const level = conditionLevelForPath(path);
    const canAddComparison = level + 1 <= conditionMaximumNestingDepth && remainingOperandCount > 0;
    const canAddGroup = level + 2 <= conditionMaximumNestingDepth && remainingOperandCount > 0;
    const addChild = (kind: "comparison" | "all" | "any" | "not") => {
      const leaf = createInitialStudioCondition(context);
      const addedDepth = kind === "comparison" ? 1 : 2;
      if (
        !leaf ||
        condition.conditions.length >= maximumGroupChildren ||
        remainingOperandCount <= 0 ||
        level + addedDepth > conditionMaximumNestingDepth
      )
        return;
      const child: ConditionNode =
        kind === "comparison"
          ? leaf
          : kind === "not"
            ? { kind: "not", condition: leaf }
            : { kind, conditions: [leaf] };
      keys.current.push(newKey());
      onReplace({ ...condition, conditions: [...condition.conditions, child] });
    };
    const addDisabled =
      condition.conditions.length >= maximumGroupChildren ||
      createInitialStudioCondition(context) === undefined;
    return (
      <div className="min-w-0 space-y-3 text-sm">
        <label className="flex flex-col gap-2 text-sm">
          Match when
          <StudioOptionControl
            aria-label="Match when"
            value={condition.kind}
            disabled={false}
            options={[
              { value: "all", label: "Every condition matches" },
              { value: "any", label: "At least one condition matches" },
            ]}
            onChange={(next) =>
              onReplace({ kind: next === "any" ? "any" : "all", conditions: condition.conditions })
            }
          />
        </label>
        <StudioEntryList
          label={condition.kind === "all" ? "All of these conditions" : "Any of these conditions"}
          itemName="condition"
          items={condition.conditions.map((child, index) => {
            const childPath = [...path, "conditions", index];
            return {
              key: keys.current[index]!,
              title: describeCondition(child, context),
              invalid: validation.issues.some((issue) => pathStartsWith(issue.path, childPath)),
              content: (
                <TreeEditor
                  condition={child}
                  context={context}
                  validation={validation}
                  path={childPath}
                  remainingOperandCount={remainingOperandCount}
                  onReplace={(next, resolvedPath, childListChange) => {
                    const conditions = [...condition.conditions];
                    conditions[index] = next;
                    onReplace({ ...condition, conditions }, resolvedPath, childListChange);
                  }}
                  onInvalid={onInvalid}
                />
              ),
            };
          })}
          onMove={(from, to) => {
            const conditions = [...condition.conditions];
            const [moved] = conditions.splice(from, 1);
            if (moved === undefined) return;
            conditions.splice(to, 0, moved);
            const [movedKey] = keys.current.splice(from, 1);
            keys.current.splice(to, 0, movedKey!);
            onReplace({ ...condition, conditions }, undefined, { path, from, to });
          }}
          onRemove={
            condition.conditions.length <= 1
              ? undefined
              : (index) => {
                  keys.current.splice(index, 1);
                  onReplace(
                    {
                      ...condition,
                      conditions: condition.conditions.filter(
                        (_, childIndex) => childIndex !== index,
                      ),
                    },
                    undefined,
                    { path, from: index, to: null },
                  );
                }
          }
        >
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canAddComparison || addDisabled}
              onClick={() => addChild("comparison")}
            >
              <Plus />
              Add condition
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!canAddGroup || addDisabled}
                  />
                }
              >
                <Plus />
                Add group
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-48">
                <DropdownMenuItem onClick={() => addChild("all")}>All must match</DropdownMenuItem>
                <DropdownMenuItem onClick={() => addChild("any")}>Any may match</DropdownMenuItem>
                <DropdownMenuItem onClick={() => addChild("not")}>
                  Exclude matching records
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </StudioEntryList>
      </div>
    );
  }

  if (condition.kind === "not")
    return (
      <div className="min-w-0 space-y-3 text-sm">
        <p className="font-medium">Exclude records that match</p>
        <TreeEditor
          condition={condition.condition}
          context={context}
          validation={validation}
          path={[...path, "condition"]}
          remainingOperandCount={remainingOperandCount}
          onReplace={(next, resolvedPath, childListChange) =>
            onReplace({ kind: "not", condition: next }, resolvedPath, childListChange)
          }
          onInvalid={onInvalid}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onReplace(condition.condition, path)}
        >
          Stop excluding matches
        </Button>
      </div>
    );

  if (!isComparisonCondition(condition)) return null;

  const leftInfo = infoForOperand(condition.left, context);
  const availableOperators = studioConditionOperatorsFor(
    condition.left,
    condition.right,
    context,
  ).filter(
    (option) =>
      option.arity === "unary" || condition.right !== undefined || remainingOperandCount > 0,
  );
  const currentOperatorAvailable =
    leftInfo !== undefined &&
    (unaryOperators.has(condition.operator) ||
      (condition.right !== undefined &&
        operatorAcceptsOperands(
          condition.operator,
          leftInfo,
          infoForOperand(condition.right, context),
        )));
  const operatorIssue = errorForPath(validation, [...path, "operator"]);
  const compatibleOperand = (side: "left" | "right", candidate: ConditionOperand): boolean => {
    if (unaryOperators.has(condition.operator)) return side === "left";
    const other = side === "left" ? condition.right : condition.left;
    if (!other) return false;
    const left = infoForOperand(side === "left" ? candidate : other, context);
    const right = infoForOperand(side === "right" ? candidate : other, context);
    return (
      left !== undefined &&
      right !== undefined &&
      operatorAcceptsOperands(condition.operator, left, right)
    );
  };
  const literalChoice = (side: "left" | "right"): ConditionOperand | undefined => {
    if (!context.allowLiteralValues) return undefined;
    const other = side === "left" ? condition.right : condition.left;
    const type = other ? infoForOperand(other, context)?.semanticType : undefined;
    const candidates: ConditionOperand[] = [
      literalOperand(type),
      { source: "value", value: null },
      { source: "value", value: [] },
      literalOperand("text"),
    ];
    return candidates.find((candidate) => compatibleOperand(side, candidate));
  };
  const changeOperand = (side: "left" | "right", token: string) => {
    const selected =
      token === "value"
        ? literalChoice(side)
        : context.allowedOperands.find(
            (entry) =>
              contextOperandToken(entry) === token && compatibleOperand(side, entry.operand),
          )?.operand;
    if (!selected) return;
    if (side === "left") onReplace({ ...condition, left: selected }, [...path, side]);
    else onReplace({ ...condition, right: selected }, [...path, side]);
  };

  const literalEditor = (
    operand: ConditionOperand | undefined,
    other: ConditionOperand | undefined,
    side: "left" | "right",
  ) => {
    if (!context.allowLiteralValues || !operand || operand.source !== "value") return null;
    const type = infoForExpectedLiteral(operand, other, context, condition.operator, side);
    const otherInfo = other ? infoForOperand(other, context) : undefined;
    const collectionType =
      (condition.operator === "in" || condition.operator === "not_in") &&
      side === "right" &&
      otherInfo
        ? isCollectionElementType(otherInfo.semanticType)
          ? otherInfo.semanticType
          : undefined
        : undefined;
    const pathToOperand = [...path, side];
    const commitLiteral = (value: JsonValue) => {
      const replacement: ConditionOperand = { source: "value", value };
      if (side === "left") onReplace({ ...condition, left: replacement }, pathToOperand);
      else onReplace({ ...condition, right: replacement }, pathToOperand);
    };
    if (usesChoiceOptionControl(condition.operator, other, context)) {
      const choiceOptions = choiceOptionsFor(other, context)!;
      const optionError = errorForPath(validation, pathToOperand);
      if (condition.operator === "in" || condition.operator === "not_in")
        return (
          <StudioField label="Options" error={optionError}>
            {(control) => (
              <StudioOptionsControl
                {...control}
                aria-label="Options"
                value={Array.isArray(operand.value) ? operand.value : []}
                options={choiceOptions}
                onChange={commitLiteral}
              />
            )}
          </StudioField>
        );
      return (
        <label className="flex flex-col gap-2 text-sm">
          Option
          <StudioOptionControl
            aria-label="Option"
            value={typeof operand.value === "string" ? operand.value : ""}
            aria-invalid={optionError !== undefined}
            disabled={false}
            unset="Choose an option…"
            options={choiceOptions.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(next) => {
              if (next !== "") commitLiteral(next);
            }}
          />
          {optionError && <span role="alert">{optionError}</span>}
        </label>
      );
    }
    if (operand.value === null) {
      const initial = defaultLiteralForType(type);
      const editableValue: JsonValue =
        initial === null
          ? type === "money"
            ? { amount: "", currency: "" }
            : type === "record_reference" || type === "opaque_json"
              ? {}
              : ""
          : (initial ?? "");
      return (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => commitLiteral(editableValue)}
        >
          Enter a value (currently empty)
        </Button>
      );
    }
    return (
      <>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => commitLiteral(null)}
        >
          Use an empty value
        </Button>
        <LiteralEditor
          operand={operand}
          semanticType={type}
          {...(collectionType === undefined ? {} : { collectionElementType: collectionType })}
          path={pathToOperand}
          validation={validation}
          onCommit={commitLiteral}
          onInvalid={(message) => {
            const issue = makeIssue("invalid_literal", pathToOperand, message);
            onInvalid(issue);
          }}
        />
      </>
    );
  };

  const operandSelector = (side: "left" | "right") => {
    const operand = side === "left" ? condition.left : condition.right;
    const other = side === "left" ? condition.right : condition.left;
    if (!operand) return null;
    const pathToOperand = [...path, side];
    const literalOwnsError =
      operand.source === "value" &&
      context.allowLiteralValues &&
      (operand.value !== null || usesChoiceOptionControl(condition.operator, other, context));
    const operandError = literalOwnsError ? undefined : errorForPath(validation, pathToOperand);
    const referenceOptions = context.allowedOperands.filter((option) =>
      compatibleOperand(side, option.operand),
    );
    const selectableLiteral = literalChoice(side);
    const currentSelectable =
      operand.source === "value"
        ? selectableLiteral !== undefined
        : referenceOptions.some((option) => contextOperandToken(option) === operandToken(operand));
    return (
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <StudioField
          label={side === "left" ? "Field or value" : "Compare with"}
          error={operandError}
        >
          {(control) => (
            <StudioReferencePicker
              {...control}
              value={operandToken(operand)}
              options={[
                ...(!currentSelectable
                  ? [
                      {
                        value: operandToken(operand),
                        label: "Current selection (not available)",
                        disabled: true,
                      },
                    ]
                  : []),
                ...referenceOptions.map((option) => ({
                  value: contextOperandToken(option),
                  label: option.label,
                  group: displayRole(option.role),
                })),
                ...(selectableLiteral ? [{ value: "value", label: "Fixed value" }] : []),
              ]}
              onChange={(next) => changeOperand(side, next)}
            />
          )}
        </StudioField>
        {literalEditor(operand, other, side)}
      </div>
    );
  };

  const rightOptions = availableOperators;
  const rightForOperator = (operator: ConditionOperator): ConditionOperand | undefined => {
    if (
      context.allowLiteralValues &&
      condition.right?.source === "value" &&
      usesChoiceOptionControl(operator, condition.left, context)
    )
      return { source: "value", value: operator === "in" || operator === "not_in" ? [] : null };
    return defaultRightForOperator(operator, condition.left, context);
  };

  const currentOperatorLabel =
    operatorOptions.find((option) => option.operator === condition.operator)?.label ??
    condition.operator;
  const changeOperator = (operator: ConditionOperator) => {
    if (unaryOperators.has(operator)) {
      onReplace({ kind: "comparison", operator, left: condition.left });
      return;
    }
    const existingRight = condition.right;
    const candidate =
      existingRight &&
      operatorAcceptsOperands(
        operator,
        leftInfo ?? { source: "value", semanticType: undefined, literal: null },
        infoForOperand(existingRight, context),
      )
        ? existingRight
        : rightForOperator(operator);
    if (!candidate) return;
    onReplace({ kind: "comparison", operator, left: condition.left, right: candidate });
  };

  return (
    <div className="min-w-0 space-y-4 text-sm">
      {operandSelector("left")}
      <label className="flex flex-col gap-2 text-sm">
        Comparison
        <StudioOptionControl
          aria-label="Comparison"
          aria-invalid={operatorIssue !== undefined || !currentOperatorAvailable}
          value={condition.operator}
          disabled={false}
          options={[
            ...(currentOperatorAvailable
              ? []
              : [
                  {
                    value: condition.operator,
                    label: `${currentOperatorLabel} (not valid for these values)`,
                    disabled: true,
                  },
                ]),
            ...rightOptions.map((option) => ({ value: option.operator, label: option.label })),
          ]}
          onChange={(next) => changeOperator(next as ConditionOperator)}
        />
        {operatorIssue && <span role="alert">{operatorIssue}</span>}
      </label>
      {!unaryOperators.has(condition.operator) && <>{operandSelector("right")}</>}
      <StudioIconButton
        label="Reset condition"
        disabled={createInitialStudioCondition(context) === undefined}
        onClick={() => {
          const replacement = createInitialStudioCondition(context);
          if (replacement) onReplace(replacement, path);
        }}
      >
        <RotateCcw />
      </StudioIconButton>
    </div>
  );
}

/** Where an issue sits, in the words the controls use. */
const issuePlace = (path: ConditionPath): string => {
  const words: string[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index];
    const next = path[index + 1];
    if (part === "conditions" && typeof next === "number") {
      words.push(`condition ${next + 1}`);
      index += 1;
    } else if (part === "condition") words.push("excluded condition");
    else if (part === "left") words.push("field or value");
    else if (part === "right") words.push("compare with");
    else if (part === "operator") words.push("comparison");
  }
  const place = words.join(", ") || "condition";
  return place.charAt(0).toUpperCase() + place.slice(1);
};

export type StudioConditionControlsProps = Readonly<{
  value?: ConditionNode;
  context: StudioConditionControlsContext;
  label?: string;
  /** Receives only the current shared condition tree; located issues remain separate. */
  onChange: (condition: ConditionNode | undefined, validation: StudioConditionValidation) => void;
}>;

/** Accessible, reusable authoring controls for the current shared Rule condition tree. */
export function StudioConditionControls({
  value,
  context,
  label = "Condition controls",
  onChange,
}: StudioConditionControlsProps) {
  const [draftIssues, setDraftIssues] = useState<readonly StudioConditionValidationIssue[]>([]);
  const baseValidation = validateStudioCondition(value, context);
  const activeDraftIssues = draftIssues.filter((issue) =>
    hasLiteralAtPath(baseValidation.condition, issue.path),
  );
  const validation = withDraftIssues(baseValidation, activeDraftIssues);
  const emit = (
    next: ConditionNode | undefined,
    resolvedPath?: ConditionPath,
    childListChange?: ChildListChange,
  ) => {
    const nextValidation = validateStudioCondition(next, context);
    // Held literal input stays mounted when its row moves; its located refusal must follow it.
    const relocatedIssues = activeDraftIssues.flatMap((issue) => {
      if (childListChange === undefined) return [issue];
      const { path, from, to } = childListChange;
      const prefix = [...path, "conditions"];
      const index = issue.path[prefix.length];
      if (!pathStartsWith(issue.path, prefix) || typeof index !== "number") return [issue];
      if (index === from && to === null) return [];
      const nextIndex =
        index === from
          ? to!
          : to === null
            ? index > from
              ? index - 1
              : index
            : from < to && index > from && index <= to
              ? index - 1
              : from > to && index >= to && index < from
                ? index + 1
                : index;
      const nextPath = [...prefix, nextIndex, ...issue.path.slice(prefix.length + 1)];
      return [{ ...issue, path: nextPath, pointer: pointerForPath(nextPath) }];
    });
    const remainingIssues = relocatedIssues.filter(
      (issue) =>
        (resolvedPath === undefined || !pathStartsWith(issue.path, resolvedPath)) &&
        hasLiteralAtPath(nextValidation.condition, issue.path),
    );
    setDraftIssues(remainingIssues);
    onChange(nextValidation.condition, withDraftIssues(nextValidation, remainingIssues));
  };
  const current = validation.condition;
  const initial = createInitialStudioCondition(context);
  const contextIsInvalid = validation.issues.some((issue) => issue.code === "invalid_context");
  const validationSummary = validation.issues.length > 0 && (
    <ul aria-live="polite" role="status">
      {validation.issues.map((issue, index) => (
        <li key={`${issue.pointer}:${issue.code}:${index}`}>
          <strong>{issuePlace(issue.path)}:</strong> {issue.message}
        </li>
      ))}
    </ul>
  );

  return (
    <section aria-label={label} className="space-y-4 text-sm">
      {validationSummary}
      {contextIsInvalid ? (
        <p role="alert">These conditions cannot be edited with the available fields and inputs.</p>
      ) : !current ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">No condition has been configured.</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!initial}
            onClick={() => emit(initial)}
          >
            <Plus />
            Start with a condition
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <p aria-live="polite" className="text-muted-foreground">
              {describeCondition(current, context)}
            </p>
            <StudioInspectorActions
              actions={[
                {
                  label: "Group: all must match",
                  disabled: conditionDepth(current) >= conditionMaximumNestingDepth,
                  onSelect: () => emit({ kind: "all", conditions: [current] }),
                },
                {
                  label: "Group: any may match",
                  disabled: conditionDepth(current) >= conditionMaximumNestingDepth,
                  onSelect: () => emit({ kind: "any", conditions: [current] }),
                },
                current.kind === "not"
                  ? { label: "Stop excluding matches", onSelect: () => emit(current.condition) }
                  : {
                      label: "Exclude matching records",
                      disabled: conditionDepth(current) >= conditionMaximumNestingDepth,
                      onSelect: () => emit({ kind: "not", condition: current }),
                    },
                ...((current.kind === "all" || current.kind === "any") &&
                current.conditions.length === 1
                  ? [
                      {
                        label: "Remove group",
                        onSelect: () => {
                          const onlyChild = current.conditions[0];
                          if (onlyChild) emit(onlyChild);
                        },
                      },
                    ]
                  : []),
                { label: "Clear condition", destructive: true, onSelect: () => emit(undefined) },
              ]}
            />
          </div>
          <TreeEditor
            condition={current}
            context={context}
            validation={validation}
            path={[]}
            remainingOperandCount={conditionMaximumOperandCount - conditionOperandCount(current)}
            onReplace={emit}
            onInvalid={(issue) => {
              const nextValidation = validateStudioCondition(current, context);
              const issues = [
                ...activeDraftIssues.filter((entry) => !pathEquals(entry.path, issue.path)),
                issue,
              ];
              setDraftIssues(issues);
              onChange(nextValidation.condition, withDraftIssues(nextValidation, issues));
            }}
          />
        </>
      )}
      {validation.condition && !validation.isValid && (
        <p role="alert">Finish the conditions marked above before saving.</p>
      )}
    </section>
  );
}
