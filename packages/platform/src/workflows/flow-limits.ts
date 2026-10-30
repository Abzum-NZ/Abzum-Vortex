/** Closed limits from the architecture decisions, exported so one number governs every consumer. */
export const flowMaximumTaskCount = 100;
export const flowMaximumTaskNestingDepth = 5;

export const flowMaximumForEachItemsOther = 100;
/** A set-based For each (one change over record steps) runs up to the paging maximum. */
export const flowMaximumSetBasedForEachItems = 200;
export const flowMaximumRunFlowDepth = 3;
/** Runtime budgets for one interactive or background run; enforced by the orchestrator. */
export const flowMaximumProtectedOperations = 25;
export const flowMaximumServerSeconds = 10;
