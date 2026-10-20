import "server-only";
import { setTimeout as idleTurn } from "node:timers/promises";

import type {
  ApplicationRootId,
  BuilderPreviewInstallation,
  IdentitySession,
  OrganizationId,
} from "@vortex/platform/schema";
import { materializeStudioPreviewDemand } from "./studio-application-preview";

type FillResult =
  | Readonly<{ kind: "ready" }>
  | Exclude<Awaited<ReturnType<typeof materializeStudioPreviewDemand>>, { kind: "ready" }>;

type Work = {
  visible: number;
  listeners: Set<() => void>;
  fill?: {
    previewId: string;
    revision: number;
    controller: AbortController;
    step?: AbortController;
    readers: number;
    result: Promise<FillResult>;
  };
};
const workKey = Symbol.for("vortex.web.studio-preview-work");
const processWork = globalThis as typeof globalThis & { [workKey]?: Map<string, Work> };
// Only live requests and pending work live here; completed results and authority never do.
const pending = (processWork[workKey] ??= new Map<string, Work>());
const keyOf = (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
) => `${session.identityId}|${organizationId}|${rootId}`.toLowerCase();
const workFor = (key: string): Work => {
  const work = pending.get(key) ?? { visible: 0, listeners: new Set<() => void>() };
  pending.set(key, work);
  return work;
};
const wake = (work: Work) => {
  for (const listener of work.listeners) listener();
};
const discard = (key: string, work: Work) => {
  if (work.visible === 0 && work.fill === undefined && pending.get(key) === work)
    pending.delete(key);
};

/** A visible read has priority until all of its row/value/total reads have answered. */
export const beginStudioPreviewRead = (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
): (() => void) => {
  const key = keyOf(session, organizationId, rootId);
  const work = workFor(key);
  work.visible += 1;
  work.fill?.step?.abort();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    work.visible -= 1;
    wake(work);
    discard(key, work);
  };
};

const whenIdle = (work: Work, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const changed = () => {
      if (!signal.aborted && work.visible !== 0) return;
      work.listeners.delete(changed);
      signal.removeEventListener("abort", changed);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    };
    work.listeners.add(changed);
    signal.addEventListener("abort", changed, { once: true });
    changed();
  });

/**
 * A client joins only after receiving a visible result and keeps this request open until the fill
 * ends or that reader leaves. Each transaction rechecks authority; only pending fills coalesce.
 */
export const fillStudioPreviewWhenIdle = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
  preview: BuilderPreviewInstallation,
  signal: AbortSignal,
): Promise<FillResult> => {
  signal.throwIfAborted();
  if (
    !preview.seedable ||
    preview.recordTypeIds.every((id) => preview.derivedReadyRecordTypeIds.includes(id))
  )
    return { kind: "ready" };
  const key = keyOf(session, organizationId, rootId);
  const work = workFor(key);
  let fill = work.fill;
  if (
    fill === undefined ||
    fill.controller.signal.aborted ||
    fill.previewId !== preview.previewInstallationId ||
    fill.revision !== preview.draftRevision
  ) {
    fill?.controller.abort();
    const controller = new AbortController();
    const started: NonNullable<Work["fill"]> = {
      previewId: preview.previewInstallationId,
      revision: preview.draftRevision,
      controller,
      readers: 0,
      result: Promise.resolve({ kind: "ready" }),
    };
    fill = started;
    work.fill = started;
    started.result = Promise.resolve()
      .then(async () => {
        const ready = new Set<string>(preview.derivedReadyRecordTypeIds);
        for (const recordTypeId of preview.recordTypeIds) {
          if (ready.has(recordTypeId)) continue;
          let completed = false;
          while (!completed) {
            await idleTurn(0, undefined, { signal: controller.signal });
            await whenIdle(work, controller.signal);
            controller.signal.throwIfAborted();
            if (work.visible !== 0) continue;
            const step = new AbortController();
            started.step = step;
            try {
              const result = await materializeStudioPreviewDemand(
                session,
                organizationId,
                rootId,
                preview,
                {
                  recordTypes: [{ recordTypeId, fieldIds: [], relationshipPaths: [] }],
                },
                AbortSignal.any([controller.signal, step.signal]),
              );
              if (result.kind !== "ready") return result;
              for (const id of result.readyRecordTypeIds) ready.add(id);
              completed = true;
            } catch (error) {
              controller.signal.throwIfAborted();
              if (!step.signal.aborted) throw error;
              // A visible reader interrupted this step. Its transaction rolls back at the next
              // cancellation boundary; resume the same type only after that reader has answered.
            } finally {
              if (started.step === step) delete started.step;
            }
          }
        }
        return { kind: "ready" } as const;
      })
      .finally(() => {
        if (work.fill === started) delete work.fill;
        discard(key, work);
      });
    // Every joined request observes the original result; observe cancellation during departure too.
    void started.result.catch(() => undefined);
  }
  const joined = fill;
  joined.readers += 1;
  let leave: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    leave = () => reject(signal.reason);
    signal.addEventListener("abort", leave, { once: true });
  });
  try {
    return await Promise.race([joined.result, cancelled]);
  } catch (error) {
    signal.throwIfAborted();
    // A new preview or revision superseded this fill while another tab still held its lease.
    // That is a stale read, rather than an outage, and the next reader uses its current revision.
    if (joined.controller.signal.aborted) return { kind: "conflict" };
    throw error;
  } finally {
    if (leave !== undefined) signal.removeEventListener("abort", leave);
    joined.readers -= 1;
    if (joined.readers === 0) joined.controller.abort();
  }
};
