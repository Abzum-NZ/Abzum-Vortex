"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import {
  conditionValueType,
  evaluateResolvedTypedCondition,
  pageFlowFormValue,
  type ConditionNode,
  type JsonValue,
} from "@vortex/platform/schema";
import type { FlowRuntimeState } from "./flow-runtime";

export type PlacementReactions = Readonly<{
  visible?: boolean | undefined;
  required?: boolean | undefined;
  readOnly?: boolean | undefined;
  enabled?: boolean | undefined;
  /** Why a value cannot be written now (this placement or one around it), checked at the write. */
  refusal?: (() => "hidden" | "read_only" | "disabled" | undefined) | undefined;
}>;

export const PlacementReactionsContext = createContext<PlacementReactions>({});
export const usePlacementReactions = () => useContext(PlacementReactionsContext);

type Conditions = Readonly<{
  visibilityCondition?: ConditionNode | undefined;
  requiredCondition?: ConditionNode | undefined;
  readOnlyCondition?: ConditionNode | undefined;
  enabledCondition?: ConditionNode | undefined;
  reactions?: PlacementReactions;
}>;

/** Subscribes only to the page and form slots that this placement actually reads. */
export function useLivePlacementReactions(
  state: FlowRuntimeState | undefined,
  conditions: Conditions,
): PlacementReactions {
  const parent = usePlacementReactions();
  const nodes = [
    conditions.visibilityCondition,
    conditions.requiredCondition,
    conditions.readOnlyCondition,
    conditions.enabledCondition,
  ] as const;
  const keys = new Set<string>();
  const collect = (node: ConditionNode): void => {
    if (node.kind === "comparison") {
      for (const operand of [node.left, node.right]) {
        if (operand?.source === "page") keys.add(`page:${operand.name}`);
        if (operand?.source === "form")
          keys.add(`form:${operand.form.toLowerCase()}:${operand.field}`);
      }
    } else if (node.kind === "not") collect(node.condition);
    else node.conditions.forEach(collect);
  };
  nodes.forEach((node) => {
    if (node !== undefined) collect(node);
  });
  const keyList = [...keys].sort().join("\n");
  const subscribe = useCallback(
    (listener: () => void) => {
      if (state === undefined || keyList === "") return () => {};
      const remove = keyList.split("\n").map((key) => state.subscribe(key, listener));
      return () => remove.forEach((unsubscribe) => unsubscribe());
    },
    [state, keyList],
  );
  const snapshot = () => {
    let mask = 0;
    nodes.forEach((condition, index) => {
      if (condition === undefined || state === undefined) return;
      let unresolved = false;
      try {
        const result = evaluateResolvedTypedCondition(condition, (operand) => {
          if (operand === undefined) {
            unresolved = true;
            return { value: null, missing: true };
          }
          if (operand.source === "value") return { value: operand.value, literal: operand.value };
          if (operand.source === "page") {
            const value = state.pageValues.readTyped(operand.name);
            if (value === undefined) {
              unresolved = true;
              return { value: null, missing: true };
            }
            const type = conditionValueType(value.type);
            return type === undefined
              ? { value: value.value }
              : { value: value.value, type, dialect: "flow" as const };
          }
          if (operand.source === "form") {
            const type = state.formType(operand.form, operand.field);
            const value =
              type === undefined
                ? undefined
                : pageFlowFormValue(type, state.readFormValue(operand.form, operand.field));
            if (value === undefined) {
              unresolved = true;
              return { value: null, missing: true };
            }
            const semanticType = conditionValueType(type);
            const raw = state.readFormValue(operand.form, operand.field);
            const resolved =
              semanticType === "record_reference" && raw !== undefined
                ? (raw as JsonValue)
                : value.value;
            return semanticType === undefined
              ? { value: value.value }
              : { value: resolved, type: semanticType, dialect: "flow" as const };
          }
          unresolved = true;
          return { value: null, missing: true };
        });
        if (result) mask |= 1 << index;
      } catch (error) {
        // A form field can be unmounted or withheld by field permissions; a reaction cannot grant access.
        if (!unresolved) console.error("[page] placement reaction failed", error);
      }
    });
    return mask;
  };
  const mask = useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    visible:
      parent.visible !== false &&
      (state === undefined || nodes[0] === undefined || (mask & 1) !== 0),
    required:
      state === undefined || nodes[1] === undefined
        ? conditions.reactions?.required
        : (mask & 2) !== 0,
    readOnly:
      state === undefined || nodes[2] === undefined
        ? conditions.reactions?.readOnly
        : (mask & 4) !== 0,
    enabled:
      state === undefined || nodes[3] === undefined
        ? conditions.reactions?.enabled
        : (mask & 8) !== 0,
    refusal: () => {
      const inherited = parent.refusal?.();
      if (inherited !== undefined) return inherited;
      const current = snapshot();
      if (nodes[0] !== undefined && (current & 1) === 0) return "hidden";
      if (nodes[2] === undefined ? conditions.reactions?.readOnly === true : (current & 4) !== 0)
        return "read_only";
      if (nodes[3] === undefined ? conditions.reactions?.enabled === false : (current & 8) === 0)
        return "disabled";
      return undefined;
    },
  };
}
