"use client";
import { Button } from "@vortex/ui/components/button";
import { NativeSelect } from "@vortex/ui/components/native-select";
import { useState } from "react";
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
  validateStudioCondition,
  withDraftIssues,
} from "./condition-model";
import { LiteralEditor } from "./condition-literal-editor";

type TreeEditorProps = Readonly<{
  condition: ConditionNode;
  context: StudioConditionControlsContext;
  validation: StudioConditionValidation;
  path: ConditionPath;
  remainingOperandCount: number;
  onReplace: (condition: ConditionNode, resolvedPath?: ConditionPath) => void;
  onRemove?: () => void;
  onInvalid: (issue: StudioConditionValidationIssue) => void;
}>;

function TreeEditor({
  condition,
  context,
  validation,
  path,
  remainingOperandCount,
  onReplace,
  onRemove,
  onInvalid,
}: TreeEditorProps) {
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
      onReplace({ ...condition, conditions: [...condition.conditions, child] });
    };
    return (
      <fieldset>
        <legend>{condition.kind === "all" ? "All of these conditions" : "Any of these conditions"}</legend>
        <label>
          Group logic
          <NativeSelect
            value={condition.kind}
            onChange={(event) => {
              const kind = event.currentTarget.value === "any" ? "any" : "all";
              onReplace({ kind, conditions: condition.conditions });
            }}
          >
            <option value="all">All must match</option>
            <option value="any">Any may match</option>
          </NativeSelect>
        </label>
        {condition.conditions.map((child, index) => {
          const childPath = [...path, "conditions", index];
          return (
            <TreeEditor
              key={pointerForPath(childPath)}
              condition={child}
              context={context}
              validation={validation}
              path={childPath}
              remainingOperandCount={remainingOperandCount}
              onReplace={(next, resolvedPath) => {
                const conditions = [...condition.conditions];
                conditions[index] = next;
                onReplace({ ...condition, conditions }, resolvedPath);
              }}
              onRemove={() => {
                if (condition.conditions.length <= 1) return;
                onReplace({
                  ...condition,
                  conditions: condition.conditions.filter((_, childIndex) => childIndex !== index),
                }, path);
              }}
              onInvalid={onInvalid}
            />
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!canAddComparison || condition.conditions.length >= maximumGroupChildren || createInitialStudioCondition(context) === undefined} onClick={() => addChild("comparison")}>
            Add condition
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!canAddGroup || condition.conditions.length >= maximumGroupChildren || createInitialStudioCondition(context) === undefined} onClick={() => addChild("all")}>
            Add group: all must match
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!canAddGroup || condition.conditions.length >= maximumGroupChildren || createInitialStudioCondition(context) === undefined} onClick={() => addChild("any")}>
            Add group: any may match
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!canAddGroup || condition.conditions.length >= maximumGroupChildren || createInitialStudioCondition(context) === undefined} onClick={() => addChild("not")}>
            Add a group to exclude
          </Button>
          {onRemove && (
            <Button type="button" variant="outline" size="sm" onClick={onRemove}>
              Remove group
            </Button>
          )}
        </div>
      </fieldset>
    );
  }

  if (condition.kind === "not")
    return (
      <fieldset>
        <legend>Exclude matching records</legend>
        <TreeEditor
          condition={condition.condition}
          context={context}
          validation={validation}
          path={[...path, "condition"]}
          remainingOperandCount={remainingOperandCount}
          onReplace={(next, resolvedPath) => onReplace({ kind: "not", condition: next }, resolvedPath)}
          onInvalid={onInvalid}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => onReplace(condition.condition, path)}>
          Stop excluding matches
        </Button>
        {onRemove && (
          <Button type="button" variant="outline" size="sm" onClick={onRemove}>
            Remove group
          </Button>
        )}
      </fieldset>
    );

  if (!isComparisonCondition(condition)) return null;

  const usesChoiceOptions = condition.operator !== "contains" && condition.operator !== "not_contains";
  const leftInfo = infoForOperand(condition.left, context);
  const availableOperators = studioConditionOperatorsFor(condition.left, condition.right, context).filter(
    (option) =>
      option.arity === "unary" ||
      condition.right !== undefined ||
      remainingOperandCount > 0,
  );
  const currentOperatorAvailable = leftInfo !== undefined && (
    unaryOperators.has(condition.operator) ||
    (condition.right !== undefined && operatorAcceptsOperands(
      condition.operator,
      leftInfo,
      infoForOperand(condition.right, context),
    ))
  );
  const operatorIssue = errorForPath(validation, [...path, "operator"]);
  const compatibleOperand = (side: "left" | "right", candidate: ConditionOperand): boolean => {
    if (unaryOperators.has(condition.operator)) return side === "left";
    const other = side === "left" ? condition.right : condition.left;
    if (!other) return false;
    const left = infoForOperand(side === "left" ? candidate : other, context);
    const right = infoForOperand(side === "right" ? candidate : other, context);
    return left !== undefined && right !== undefined &&
      operatorAcceptsOperands(condition.operator, left, right);
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
    const selected = token === "value"
      ? literalChoice(side)
      : context.allowedOperands.find(
          (entry) => contextOperandToken(entry) === token && compatibleOperand(side, entry.operand),
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
      (condition.operator === "in" || condition.operator === "not_in") && side === "right" && otherInfo
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
    // Substring comparisons edit text; other choice comparisons use their options.
    const choiceOptions = usesChoiceOptions ? choiceOptionsFor(other, context) : undefined;
    if (choiceOptions !== undefined && choiceOptions.length > 0 && (operand.value === null || typeof operand.value === "string")) {
      const optionError = errorForPath(validation, pathToOperand);
      return (
        <label>
          Option
          <NativeSelect value={typeof operand.value === "string" ? operand.value : ""} aria-invalid={optionError !== undefined}
            onChange={(event) => commitLiteral(event.currentTarget.value)}>
            <option value="" disabled>Choose an option…</option>
            {choiceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            {typeof operand.value === "string" && operand.value !== "" && !choiceOptions.some((option) => option.value === operand.value) &&
              <option value={operand.value} disabled>{operand.value} (not an option)</option>}
          </NativeSelect>
          {optionError && <span role="alert">{optionError}</span>}
        </label>
      );
    }
    if (operand.value === null) {
      const initial = defaultLiteralForType(type);
      const editableValue: JsonValue = initial === null
        ? type === "money"
          ? { amount: "", currency: "" }
          : type === "record_reference" || type === "opaque_json"
            ? {}
            : ""
        : initial ?? "";
      return (
        <Button type="button" variant="outline" size="sm" onClick={() => commitLiteral(editableValue)}>
          Enter a value (currently empty)
        </Button>
      );
    }
    return (
      <>
        <Button type="button" variant="outline" size="sm" onClick={() => commitLiteral(null)}>Use an empty value</Button>
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
    const literalOwnsError = operand.source === "value" && context.allowLiteralValues &&
      (operand.value !== null || (usesChoiceOptions && (choiceOptionsFor(other, context)?.length ?? 0) > 0));
    const operandError = literalOwnsError ? undefined : errorForPath(validation, pathToOperand);
    const referenceOptions = context.allowedOperands.filter((option) =>
      compatibleOperand(side, option.operand),
    );
    const selectableLiteral = literalChoice(side);
    const currentSelectable = operand.source === "value"
      ? selectableLiteral !== undefined
      : referenceOptions.some((option) => contextOperandToken(option) === operandToken(operand));
    return (
      <fieldset>
        <legend>{side === "left" ? "Field or value" : "Compare with"}</legend>
        <label>
          Choose a field, input or fixed value
        <NativeSelect
          aria-invalid={operandError !== undefined}
          value={operandToken(operand)}
          onChange={(event) => changeOperand(side, event.currentTarget.value)}
        >
          {!currentSelectable && (
            <option value={operandToken(operand)} disabled>
              Current selection (not available)
            </option>
          )}
          {referenceOptions.map((option, index) => (
            <option key={`${contextOperandToken(option)}:${index}`} value={contextOperandToken(option)}>
              {option.label}{option.role === "current_field" || option.role === "record_field" ? "" : ` (${displayRole(option.role)})`}
            </option>
          ))}
          {selectableLiteral && <option value="value">Fixed value</option>}
        </NativeSelect>
        </label>
        {operandError && <span role="alert">{operandError}</span>}
        {literalEditor(operand, other, side)}
      </fieldset>
    );
  };

  const rightOptions = availableOperators;
  const rightForOperator = (operator: ConditionOperator): ConditionOperand | undefined =>
    defaultRightForOperator(operator, condition.left, context);

  return (
    <fieldset>
      <legend>Condition</legend>
      {operandSelector("left")}
      <label>
        Comparison
        <NativeSelect
          aria-invalid={operatorIssue !== undefined || !currentOperatorAvailable}
          value={condition.operator}
          onChange={(event) => {
            const operator = event.currentTarget.value as ConditionOperator;
            if (unaryOperators.has(operator)) {
              onReplace({ kind: "comparison", operator, left: condition.left });
              return;
            }
            const existingRight = condition.right;
            const candidate = existingRight && operatorAcceptsOperands(
              operator,
              leftInfo ?? { source: "value", semanticType: undefined, literal: null },
              infoForOperand(existingRight, context),
            ) ? existingRight : rightForOperator(operator);
            if (!candidate) return;
            onReplace({ kind: "comparison", operator, left: condition.left, right: candidate });
          }}
        >
          {!currentOperatorAvailable && (
            <option value={condition.operator} disabled>
              {operatorOptions.find((option) => option.operator === condition.operator)?.label ?? condition.operator} (not valid for these values)
            </option>
          )}
          {rightOptions.map((option) => (
            <option key={option.operator} value={option.operator}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
        {operatorIssue && <span role="alert">{operatorIssue}</span>}
      </label>
      {!unaryOperators.has(condition.operator) && (
        <>
          {operandSelector("right")}
        </>
      )}
      {onRemove && (
        <Button type="button" variant="outline" size="sm" onClick={onRemove}>
          Remove condition
        </Button>
      )}
      <Button
        type="button" variant="outline" size="sm"
        disabled={createInitialStudioCondition(context) === undefined}
        onClick={() => {
          const replacement = createInitialStudioCondition(context);
          if (replacement) onReplace(replacement, path);
        }}
      >
        Reset condition
      </Button>
    </fieldset>
  );
}

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
  const activeDraftIssues = draftIssues.filter((issue) => hasLiteralAtPath(baseValidation.condition, issue.path));
  const validation = withDraftIssues(baseValidation, activeDraftIssues);
  const emit = (next: ConditionNode | undefined, resolvedPath?: ConditionPath) => {
    const nextValidation = validateStudioCondition(next, context);
    const remainingIssues = activeDraftIssues.filter((issue) =>
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
          <strong>{issue.pointer || "Condition"}:</strong> {issue.message}
        </li>
      ))}
    </ul>
  );

  return (
    <section aria-label={label}>
      {validationSummary}
      {contextIsInvalid ? (
        <p role="alert">These conditions cannot be edited with the available fields and inputs.</p>
      ) : !current ? (
        <div>
          <p>No condition has been configured.</p>
          <Button type="button" variant="outline" size="sm" disabled={!initial} onClick={() => emit(initial)}>
            Start with a condition
          </Button>
        </div>
      ) : (
        <>
          <p aria-live="polite">
            <strong>Preview:</strong> {describeCondition(current, context)}
          </p>
          <TreeEditor
            condition={current}
            context={context}
            validation={validation}
            path={[]}
            remainingOperandCount={
              conditionMaximumOperandCount - conditionOperandCount(current)
            }
            onReplace={emit}
            onInvalid={(issue) => {
              const nextValidation = validateStudioCondition(current, context);
              const issues = [...activeDraftIssues.filter((entry) => !pathEquals(entry.path, issue.path)), issue];
              setDraftIssues(issues);
              onChange(nextValidation.condition, withDraftIssues(nextValidation, issues));
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button" variant="outline" size="sm"
              disabled={conditionDepth(current) >= conditionMaximumNestingDepth}
              onClick={() => emit({ kind: "all", conditions: [current] })}
            >
              Group: all must match
            </Button>
            <Button
              type="button" variant="outline" size="sm"
              disabled={conditionDepth(current) >= conditionMaximumNestingDepth}
              onClick={() => emit({ kind: "any", conditions: [current] })}
            >
              Group: any may match
            </Button>
            {current.kind !== "not" && (
              <Button
                type="button" variant="outline" size="sm"
                disabled={conditionDepth(current) >= conditionMaximumNestingDepth}
                onClick={() => emit({ kind: "not", condition: current })}
              >
                Exclude matching records
              </Button>
            )}
            {current.kind === "not" && (
              <Button type="button" variant="outline" size="sm" onClick={() => emit(current.condition)}>
                Stop excluding matches
              </Button>
            )}
            {(current.kind === "all" || current.kind === "any") && current.conditions.length === 1 && (
              <Button
                type="button" variant="outline" size="sm"
                onClick={() => {
                  const onlyChild = current.conditions[0];
                  if (onlyChild) emit(onlyChild);
                }}
              >
                Remove group
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => emit(undefined)}>
              Clear condition
            </Button>
          </div>
        </>
      )}
      {validation.condition && !validation.isValid && (
        <p role="alert">Finish the conditions marked above before saving.</p>
      )}
    </section>
  );
}
