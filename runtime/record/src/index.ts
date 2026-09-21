import "server-only";

export * from "./field-values";
export * from "./calculations";
export * from "./totals";
export * from "./save-record";
export * from "./transfer-record-ownership";
export * from "./named-actions";
export * from "./record-lifecycle-selection";
export * from "./record-removal-protection";

export const RecordService = Object.freeze({
  key: "record",
  boundary: "@vortex/record",
});
