import { createHash } from "node:crypto";

/**
 * The deterministic identity of one record's change in one multi-record command, so a resubmitted
 * command replays each record's completed change instead of repeating it. `domain` keeps commands
 * of different features apart even when they share a gesture identity.
 */
export const recordCommandId = (domain: string, commandId: string, recordId: string): string => {
  const digest = createHash("sha256")
    .update(`${domain}:${commandId.toLowerCase()}:${recordId.toLowerCase()}`)
    .digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
