/** Closed limits from the architecture decisions, exported so one number governs every consumer. */
export const flowMaximumTaskCount = 100;
export const flowMaximumTaskNestingDepth = 5;

export const flowMaximumForEachItemsDurable = 1_000;
export const flowMaximumForEachItemsOther = 100;
export const flowMaximumRunFlowDepth = 3;
/** Runtime budgets for one interactive or background run; enforced by the orchestrator. */
export const flowMaximumProtectedOperations = 25;
export const flowMaximumServerSeconds = 10;
