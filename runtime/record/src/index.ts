import "server-only";

export * from "./field-values";
export * from "./calculations";
export * from "./deadline-transitions";
export * from "./totals";
export * from "./save-record";
export * from "./transfer-record-ownership";
export * from "./action-flow-effects";
export * from "./action-record-port";
export * from "./record-lifecycle-policy";
export * from "./delete-record";

export const RecordService = Object.freeze({
  key: "record",
  boundary: "@vortex/record",
});
