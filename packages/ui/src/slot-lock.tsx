"use client";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * On Tablet and Phone a block only reorders within its slot, so while one is dragged every other
 * slot takes nothing. The store holds the zone the dragged block sits in; each slot reads it and
 * draws Puck's own `allow` prop (an empty list accepts nothing). A live page never supplies one.
 */
export type SlotLockStore = Readonly<{
  /**
   * The zone a block was pressed in, noted before Puck starts the drag; ignored unless armed. A
   * press belongs to one pointer gesture: it is forgotten when that gesture ends in `doc`.
   */
  press: (placementId: string, doc: Document) => void;
  /** Puck's drag began or ended: the pressed zone locks the other slots, or everything is open. */
  drag: (dragging: boolean) => void;
  /** The zone whose slot alone takes a drop, or `null` when every slot does. */
  get: () => string | null;
  subscribe: (listener: () => void) => () => void;
}>;

/**
 * `zoneOf` is where a placement sits (Puck's own `getSelectorForId`); `armed` is whether the screen
 * shown is one where blocks only reorder within their slot.
 */
export const createSlotLockStore = ({
  zoneOf,
  armed,
}: Readonly<{
  zoneOf: (placementId: string) => string | undefined;
  armed: () => boolean;
}>): SlotLockStore => {
  let pressed: string | null = null;
  let locked: string | null = null;
  const listeners = new Set<() => void>();
  return {
    press: (placementId, doc) => {
      pressed = armed() ? (zoneOf(placementId) ?? null) : null;
      const end = new AbortController();
      const forget = () => {
        pressed = null;
        end.abort();
      };
      // The drag has locked its slots by now (Puck reports it on activation), so this leaves them.
      for (const type of ["pointerup", "pointercancel"])
        doc.addEventListener(type, forget, { capture: true, signal: end.signal });
    },
    drag: (dragging) => {
      // A drag that starts with no press (the Blocks drawer, the Outline) locks nothing.
      const next = dragging && armed() ? pressed : null;
      if (next === locked) return;
      locked = next;
      for (const listener of listeners) listener();
    },
    get: () => locked,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const OPEN: SlotLockStore = createSlotLockStore({ zoneOf: () => undefined, armed: () => false });

const SlotLockContext = createContext<SlotLockStore>(OPEN);

/** Supplies the lock to the slots below it; only the editor does. */
export function SlotLockProvider({
  store,
  children,
}: Readonly<{ store: SlotLockStore; children: ReactNode }>) {
  return <SlotLockContext.Provider value={store}>{children}</SlotLockContext.Provider>;
}

/** The press handler of a block's wrapper: only the innermost block under the pointer counts. */
export const useSlotLockPress = () => useContext(SlotLockContext).press;

type SlotProps = Readonly<{ className?: string; style?: CSSProperties }>;

/**
 * Puck's slot component for the slot `zone`, which takes no drop while a block from another slot is
 * dragged on a screen where blocks only reorder within their slot.
 */
export function LockableSlot({
  Slot,
  zone,
  ...props
}: Readonly<{
  Slot: (props: SlotProps & { allow?: string[] }) => ReactNode;
  zone: string;
}> &
  SlotProps) {
  const store = useContext(SlotLockContext);
  const source = useSyncExternalStore(store.subscribe, store.get, () => null);
  return <Slot {...props} {...(source === null || source === zone ? {} : { allow: [] })} />;
}
