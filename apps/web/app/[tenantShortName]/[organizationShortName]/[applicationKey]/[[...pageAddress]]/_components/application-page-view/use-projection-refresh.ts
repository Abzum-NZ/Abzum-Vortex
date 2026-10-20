import { useEffect, useRef, type RefObject } from "react";
import { isRecord } from "@vortex/platform/schema";
import type { ApplicationPageModel, PageDataState } from "../../../../../../_lib/application-page";

const onScreen = (element: Element | null): boolean => {
  if (element === null || !element.checkVisibility({ checkVisibilityCSS: true })) return false;
  const bounds = element.getBoundingClientRect();
  let top = Math.max(0, bounds.top);
  let left = Math.max(0, bounds.left);
  let bottom = Math.min(window.innerHeight, bounds.bottom);
  let right = Math.min(window.innerWidth, bounds.right);
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clip = parent.getBoundingClientRect();
    if (style.overflowX !== "visible") {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (style.overflowY !== "visible") {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }
  return right > left && bottom > top;
};

/** A projected choice retains its key; labels never decide whether background work is pending. */
const pendingChoice = (cell: unknown, values: readonly string[]): boolean =>
  isRecord(cell) &&
  cell.kind === "choice" &&
  typeof cell.key === "string" &&
  values.includes(cell.key);

/** Rereads only a mounted projection displaying one of its definition's pending states. */
export function useProjectionRefresh(
  policies: ApplicationPageModel["refreshWhileByPlacement"],
  data: Readonly<Record<string, PageDataState>>,
  root: RefObject<HTMLDivElement | null>,
  refresh: (ids: readonly string[]) => Promise<void>,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // A payload update may replace the effect before an earlier read settles.
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;
    for (const [placementId, policy] of Object.entries(policies)) {
      const state = Object.entries(data).find(([id]) => id.toLowerCase() === placementId)?.[1];
      if (state?.status !== "ready" || !isRecord(state.values)) continue;
      const payload = state.values;
      const pendingRows =
        payload.kind === "table" && Array.isArray(payload.rows)
          ? payload.rows.filter(
              (row): row is Record<string, unknown> =>
                isRecord(row) &&
                isRecord(row.cells) &&
                pendingChoice(row.cells[policy.fieldId], policy.values),
            )
          : [];
      const pendingDetail =
        payload.kind === "record_detail" &&
        Array.isArray(payload.fields) &&
        payload.fields.some(
          (field) =>
            isRecord(field) &&
            field.key === policy.fieldId &&
            pendingChoice(field.value, policy.values),
        );
      if (pendingRows.length === 0 && !pendingDetail) continue;
      const tick = async (): Promise<void> => {
        if (disposed) return;
        const placement =
          root.current?.querySelector(`[data-vortex-placement-id="${CSS.escape(placementId)}"]`) ??
          null;
        if (
          !inFlight.current.has(placementId) &&
          document.visibilityState === "visible" &&
          onScreen(placement) &&
          ((pendingDetail &&
            onScreen(
              placement?.querySelector(`[data-vortex-field-key="${CSS.escape(policy.fieldId)}"]`) ??
                null,
            )) ||
            pendingRows.some(
              (row) =>
                typeof row.recordId === "string" &&
                onScreen(
                  placement?.querySelector(
                    `[data-vortex-record-id="${CSS.escape(row.recordId)}"] :is([data-col="${CSS.escape(policy.fieldId)}"], [data-vortex-field-key="${CSS.escape(policy.fieldId)}"])`,
                  ) ?? null,
                ),
            ))
        ) {
          inFlight.current.add(placementId);
          try {
            await refreshRef.current([placementId]);
          } finally {
            inFlight.current.delete(placementId);
          }
        }
        // Serial reads: a slow response never builds a queue. A new payload or navigation
        // disposes this policy, and a terminal state schedules no further work.
        if (!disposed) schedule();
      };
      const schedule = (): void => {
        timers.set(
          placementId,
          setTimeout(() => {
            void tick().catch((error: unknown) => {
              console.error("[page] projection refresh failed", { placementId, cause: error });
            });
          }, policy.intervalMilliseconds),
        );
      };
      schedule();
    }
    return () => {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [policies, data, root]);
}
