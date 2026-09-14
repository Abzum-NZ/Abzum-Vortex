import "server-only";

export * from "./field-values";
export * from "./calculations";
export * from "./totals";
export * from "./save-record";
export * from "./transfer-record-ownership";

export const RecordService = Object.freeze({
  key: "record",
  boundary: "@vortex/record",
});
