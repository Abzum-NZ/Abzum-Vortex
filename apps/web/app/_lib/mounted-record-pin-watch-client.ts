import {
  containedComponentIdSchema,
  mountedRecordPinAssociationSchema,
  mountedRecordPinElementProperty,
  mountedRecordPinFrameSchema,
  projectedRecordPinTilesSchema,
  recordIdSchema,
  revisionSchema,
  type MountedRecordPinFrame,
  type MountedRecordPinMembership,
} from "@vortex/contracts";
import {
  createPrivateInvalidationSubscriber,
  type PrivateInvalidationSubscriber,
} from "@vortex/event/client";
import {
  openWebPrivateInvalidationSource,
  type WebPrivateInvalidationSourceResult,
} from "./private-invalidation-client";

const membershipSchema = mountedRecordPinAssociationSchema.extend({
  placementId: containedComponentIdSchema,
  sourceRecordId: recordIdSchema,
  sourceRevision: revisionSchema,
  frame: mountedRecordPinFrameSchema,
}).strict();

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const sameAssociation = (left: MountedRecordPinMembership, right: MountedRecordPinMembership): boolean =>
  sameId(left.organizationId, right.organizationId) &&
  sameId(left.applicationRootId, right.applicationRootId) && left.applicationKey === right.applicationKey &&
  sameId(left.recordTypeId, right.recordTypeId) && sameId(left.recordId, right.recordId);

/** DOM membership is a routing hint, corroborated against this protected current frame and rows. */
export const readMountedRecordPinMemberships = (
  root: HTMLElement,
  frame: MountedRecordPinFrame,
  data: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): readonly MountedRecordPinMembership[] => {
  if (!root.isConnected) return [];
  const placements = new Map<string, Readonly<{
    placementId: string;
    rows: ReturnType<typeof projectedRecordPinTilesSchema.parse>["rows"];
  }>>();
  for (const [placementId, state] of Object.entries(data)) {
    if (state.status !== "ready" || typeof state.values !== "object" || state.values === null ||
        !("kind" in state.values) || state.values.kind !== "record_pin_tiles") continue;
    const id = containedComponentIdSchema.safeParse(placementId);
    const parsed = projectedRecordPinTilesSchema.safeParse(state.values);
    if (!id.success || !parsed.success || placements.has(id.data.toLowerCase())) return [];
    placements.set(id.data.toLowerCase(), { placementId: id.data, rows: parsed.data.rows });
  }
  const sections = root.querySelectorAll<HTMLElement>('[data-vortex-display="record-pin-tiles"]');
  if (sections.length > placements.size) return [];
  const seen = new Set<string>();
  const result: MountedRecordPinMembership[] = [];
  for (const section of sections) {
    const key = section.dataset.vortexPlacementId?.toLowerCase();
    const placement = key === undefined ? undefined : placements.get(key);
    // Error or unavailable sections must not retain prior membership.
    if (placement === undefined) continue;
    if (seen.has(placement.placementId.toLowerCase())) return [];
    seen.add(placement.placementId.toLowerCase());
    const elements = section.querySelectorAll<HTMLLIElement>(":scope > ul > li");
    if (elements.length > placement.rows.length) return [];
    const rows = new Map(placement.rows.map((row) => [row.sourceRecordId.toLowerCase(), row]));
    const sources = new Set<string>();
    for (const element of elements) {
      let candidate: unknown;
      try { candidate = Reflect.get(element, mountedRecordPinElementProperty); } catch { return []; }
      if (candidate === undefined) continue; // The renderer owns hidden/filter/availability semantics.
      const parsed = membershipSchema.safeParse(candidate);
      if (!parsed.success) return [];
      const membership = parsed.data;
      const row = rows.get(membership.sourceRecordId.toLowerCase());
      if (!sameId(membership.placementId, placement.placementId) || row === undefined ||
          row.sourceRevision !== membership.sourceRevision || row.target.kind !== "record" ||
          !sameId(membership.frame.pageId, frame.pageId) ||
          membership.frame.installationRevision !== frame.installationRevision ||
          membership.frame.releaseKey !== frame.releaseKey ||
          !sameAssociation(membership, { ...membership, ...row.target.association }) ||
          sources.has(membership.sourceRecordId.toLowerCase())) return [];
      sources.add(membership.sourceRecordId.toLowerCase());
      result.push({ ...membership, placementId: placement.placementId });
    }
  }
  return result;
};

type AvailableSource = Extract<WebPrivateInvalidationSourceResult, { kind: "available" }>;
type Group = {
  organizationId: MountedRecordPinMembership["organizationId"];
  applicationRootId: MountedRecordPinMembership["applicationRootId"];
  applicationKey: string;
  members: Map<string, MountedRecordPinMembership>;
  unregister: Map<string, () => void>;
  abort: AbortController;
  source?: AvailableSource;
  subscriber?: PrivateInvalidationSubscriber;
  closed: boolean;
  terminal: boolean;
  terminalRereadPending: boolean;
  terminalMembership: string | undefined;
};
const memberKey = (member: MountedRecordPinMembership): string => JSON.stringify([
  member.placementId.toLowerCase(), member.sourceRecordId.toLowerCase(), member.sourceRevision,
  member.recordTypeId.toLowerCase(), member.recordId.toLowerCase(),
]);
const routingMembershipKey = (members: ReadonlyMap<string, MountedRecordPinMembership>): string =>
  JSON.stringify([...new Set([...members.values()].map((member) => JSON.stringify([
    member.placementId.toLowerCase(), member.recordTypeId.toLowerCase(), member.recordId.toLowerCase(),
  ])))].sort());

/** One page lifetime owns all sources, refcounts, observers and serial protected rereads. */
export const createMountedRecordPinWatchClient = (options: Readonly<{
  root: HTMLElement;
  selectors: Readonly<{ tenantShortName: string; organizationShortName: string;
    applicationKey: string; pageKey: string }>;
  isCurrent(): boolean;
  readMemberships(): readonly MountedRecordPinMembership[];
  refreshPlacements(placementIds: readonly string[]): Promise<void>;
}>): Readonly<{ reconcile(): void; dispose(): void }> => {
  const groups = new Map<string, Group>();
  const queued = new Set<string>();
  const resizeTargets = new Set<Element>();
  let disposed = false;
  let flushing = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const current = (): boolean => !disposed && options.isCurrent();
  const close = (group: Group): void => {
    if (group.closed) return;
    group.closed = true;
    for (const unregister of group.unregister.values()) unregister();
    group.unregister.clear();
    group.subscriber?.stop();
    group.source?.dispose();
    group.abort.abort();
  };
  const watchedPlacements = (): Set<string> => new Set(
    [...groups.values()].filter((group) => !group.closed)
      .flatMap((group) => [...group.members.values()].map((member) => member.placementId)),
  );
  const scheduleRefresh = (): void => {
    if (!current() || flushing || refreshTimer !== undefined || queued.size === 0) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void flush(); }, 0);
  };
  const enqueue = (ids: readonly string[]): void => {
    if (!current()) return;
    const watched = watchedPlacements();
    for (const id of ids) if (watched.has(id)) queued.add(id);
    scheduleRefresh();
  };
  const enqueueGroup = (group: Group): void =>
    enqueue([...group.members.values()].map((member) => member.placementId));
  const terminal = (group: Group): void => {
    if (!current() || group.closed || group.terminal) return;
    group.terminal = true;
    group.terminalRereadPending = true;
    group.terminalMembership = routingMembershipKey(group.members);
    enqueueGroup(group);
  };
  async function flush(): Promise<void> {
    if (!current() || flushing) return;
    // Resample immediately before reading: nodes may have been hidden or replaced since the notice.
    reconcile();
    const watched = watchedPlacements();
    const ids = [...queued].filter((id) => watched.has(id));
    queued.clear();
    if (ids.length === 0) return;
    const terminalGroups = [...groups.values()].filter((group) => group.terminalRereadPending);
    for (const group of terminalGroups) group.terminalRereadPending = false;
    flushing = true;
    try { if (current()) await options.refreshPlacements(ids); }
    catch { /* The protected caller owns neutral read failures; transport values never replace data. */ }
    finally {
      flushing = false;
      for (const group of terminalGroups) close(group);
      if (current()) { scheduleReconcile(); scheduleRefresh(); }
    }
  }
  const open = (group: Group): void => {
    void openWebPrivateInvalidationSource({ ...options.selectors, targetApplicationKey: group.applicationKey }, {
      signal: group.abort.signal,
      onConnection(connection) {
        if (!current() || group.closed || group.terminal) return;
        if (connection.kind === "ready") {
          if (!sameId(connection.scope.organizationId, group.organizationId) ||
              !sameId(connection.scope.applicationRootId, group.applicationRootId)) terminal(group);
          else if (connection.reconnected) enqueueGroup(group);
        } else if (connection.kind === "gap") enqueueGroup(group);
        else if (connection.kind === "unavailable") terminal(group);
      },
    }).then((result) => {
      if (!current() || group.closed || group.terminal) {
        if (result.kind === "available") result.dispose();
        return;
      }
      if (result.kind !== "available") { terminal(group); return; }
      if (!sameId(result.scope.organizationId, group.organizationId) ||
          !sameId(result.scope.applicationRootId, group.applicationRootId)) {
        result.dispose(); terminal(group); return;
      }
      group.source = result;
      try {
        group.subscriber = createPrivateInvalidationSubscriber({ scope: result.scope, source: result.source,
          onStale(ids) { if (current() && !group.closed && !group.terminal) enqueue(ids); } });
        for (const [key, member] of group.members)
          group.unregister.set(key, group.subscriber.registerWatch({ placementId: member.placementId,
            recordTypeId: member.recordTypeId, recordId: member.recordId }));
        group.subscriber.start();
      } catch { terminal(group); }
    }).catch(() => terminal(group));
  };
  function reconcile(): void {
    if (!current()) return;
    // The ownership wrapper preserves layout with display:contents; observe its actual layout boxes.
    const boxes = new Set<Element>(options.root.children);
    for (const element of resizeTargets)
      if (!boxes.has(element)) { resize.unobserve(element); resizeTargets.delete(element); }
    for (const element of boxes)
      if (!resizeTargets.has(element)) { resizeTargets.add(element); resize.observe(element); }
    let members: readonly MountedRecordPinMembership[];
    try { members = options.readMemberships(); } catch { members = []; }
    const desired = new Map<string, Map<string, MountedRecordPinMembership>>();
    const keysByRoot = new Map<string, string>();
    const rootsByKey = new Map<string, string>();
    let organizationId: string | undefined;
    let ambiguous = false;
    for (const member of members) {
      const root = member.applicationRootId.toLowerCase();
      const organization = member.organizationId.toLowerCase();
      if ((organizationId !== undefined && organizationId !== organization) ||
          (keysByRoot.has(root) && keysByRoot.get(root) !== member.applicationKey) ||
          (rootsByKey.has(member.applicationKey) && rootsByKey.get(member.applicationKey) !== root)) {
        ambiguous = true; break;
      }
      organizationId = organization;
      keysByRoot.set(root, member.applicationKey);
      rootsByKey.set(member.applicationKey, root);
      const key = JSON.stringify([organization, root, member.applicationKey]);
      const entries = desired.get(key) ?? new Map<string, MountedRecordPinMembership>();
      entries.set(memberKey(member), member);
      desired.set(key, entries);
    }
    if (ambiguous) desired.clear();
    for (const [key, group] of groups) {
      const next = desired.get(key);
      if (next === undefined) { close(group); groups.delete(key); continue; }
      // A protected reread of the same routes must not restart exhausted transport retries.
      // A genuinely new visible routing membership may make a new finite attempt.
      if (group.closed && group.terminalMembership !== routingMembershipKey(next)) {
        groups.delete(key);
        continue;
      }
      for (const [watchKey, unregister] of group.unregister)
        if (!next.has(watchKey)) { unregister(); group.unregister.delete(watchKey); }
      group.members = next;
      if (group.subscriber !== undefined && !group.closed && !group.terminal)
        for (const [watchKey, member] of next)
          if (!group.unregister.has(watchKey)) group.unregister.set(watchKey,
            group.subscriber.registerWatch({ placementId: member.placementId,
              recordTypeId: member.recordTypeId, recordId: member.recordId }));
      desired.delete(key);
    }
    for (const [key, entries] of desired) {
      const member = entries.values().next().value;
      if (member === undefined) continue;
      const group: Group = { organizationId: member.organizationId, applicationRootId: member.applicationRootId,
        applicationKey: member.applicationKey, members: entries, unregister: new Map(),
        abort: new AbortController(), closed: false, terminal: false, terminalRereadPending: false,
        terminalMembership: undefined };
      groups.set(key, group);
      open(group);
    }
    const watched = watchedPlacements();
    for (const id of queued) if (!watched.has(id)) queued.delete(id);
  }
  function scheduleReconcile(): void {
    if (!current() || reconcileTimer !== undefined) return;
    reconcileTimer = setTimeout(() => { reconcileTimer = undefined; reconcile(); }, 0);
  }
  const mutations = new MutationObserver(scheduleReconcile);
  mutations.observe(options.root, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
  // Inherited visibility can change without changing any descendant's size or attributes.
  // This observes only this root's ancestry, never scans another page or document's memberships.
  for (let ancestor = options.root.parentElement; ancestor !== null; ancestor = ancestor.parentElement)
    mutations.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
  const resize = new ResizeObserver(scheduleReconcile);
  resize.observe(options.root);
  window.addEventListener("resize", scheduleReconcile);
  document.addEventListener("visibilitychange", scheduleReconcile);
  reconcile();
  return Object.freeze({ reconcile: scheduleReconcile, dispose(): void {
    if (disposed) return;
    disposed = true;
    mutations.disconnect(); resize.disconnect(); resizeTargets.clear();
    window.removeEventListener("resize", scheduleReconcile);
    document.removeEventListener("visibilitychange", scheduleReconcile);
    if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    queued.clear();
    for (const group of groups.values()) close(group);
    groups.clear();
  } });
};
