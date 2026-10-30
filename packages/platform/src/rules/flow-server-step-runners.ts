import type { ServerStepType } from "../workflows/flow-task-registry";

/**
 * Which server runner executes each step that runs on the server today (`ServerStepType`): this
 * interpreter or the protected task runner (`definition/flow-task-runner.ts`; a transaction flow's
 * record steps are collected into one change by `rules/transaction-flow-run.ts`).
 */
type ServerStepRunner = "interpreter" | "protected_task";
const serverStepRunners = {
  if: "interpreter",
  switch: "interpreter",
  for_each: "interpreter",
  sequential: "interpreter",
  run_flow: "interpreter",
  stop: "interpreter",
  "data.calculate": "interpreter",
  "data.record_link": "interpreter",
  "data.format": "interpreter",
  "data.set_variable": "interpreter",
  "rule.require": "interpreter",
  "rule.warn": "interpreter",
  "rule.refuse": "interpreter",
  "record.save": "protected_task",
  "record.query": "protected_task",
  "record.read_fields": "protected_task",
  "record.pin_identity": "protected_task",
  "form.save_draft": "protected_task",
  "form.discard_draft": "protected_task",
  "operation.call": "protected_task",
  "backend.run": "protected_task",
  "record.create": "protected_task",
  "record.set_fields": "protected_task",
  "record.delete": "protected_task",
  "record.restore": "protected_task",
  "record.link": "protected_task",
  "record.changes": "protected_task",
  "event.announce": "protected_task",
} as const satisfies Record<ServerStepType, ServerStepRunner>;

/** Whether the server runs this step with the given runner. */
export const serverRuns = (type: string, runner: ServerStepRunner): boolean =>
  Object.hasOwn(serverStepRunners, type) && serverStepRunners[type as ServerStepType] === runner;
