import "server-only";

export * from "./workflow-registration-readiness";

export const WorkflowService = Object.freeze({
  key: "workflow",
  boundary: "@vortex/workflow",
});
