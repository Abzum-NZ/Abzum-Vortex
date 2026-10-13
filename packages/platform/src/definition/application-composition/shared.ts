import { z } from "zod";

// Schema helpers shared between the application-composition modules; deliberately not re-exported from schema.ts.
export const iconKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const nonNegativeFiniteSchema = z.number().finite().nonnegative();
export const positiveFiniteSchema = z.number().finite().positive();

export const deterministicDependencyList = <
  Entry extends { blockId: string; releaseVersion: string },
>(
  entries: Entry[],
): boolean =>
  entries.every((entry, index) => {
    if (index === 0) return true;
    const previous = entries[index - 1]!;
    const previousBlock = String(previous.blockId);
    const currentBlock = String(entry.blockId);
    if (previousBlock !== currentBlock) return previousBlock < currentBlock;
    return previous.releaseVersion < entry.releaseVersion;
  });
