import { useRef } from "react";

/**
 * The value made in this render, or the one kept from an earlier render while `key` (what the value
 * holds, as a string) and the identities in `also` (what the key cannot hold, such as functions)
 * are the same. A value that is made again on every draft change but holds the same content then
 * keeps its identity, so what reads it does not draw again.
 */
export function useStudioSameByKey<T>(value: T, key: string, also: readonly unknown[] = []): T {
  const kept = useRef<Readonly<{ key: string; also: readonly unknown[]; value: T }> | null>(null);
  const current = kept.current;
  if (
    current === null ||
    current.key !== key ||
    current.also.length !== also.length ||
    current.also.some((entry, index) => entry !== also[index])
  )
    kept.current = { key, also, value };
  return kept.current!.value;
}
