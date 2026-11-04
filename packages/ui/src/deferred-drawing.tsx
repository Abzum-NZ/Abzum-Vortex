"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * What the editor knows about where the person is looking, so a slot far below or above can wait:
 * whether an element is near what the canvas shows, and a way to be told when that changes (a
 * scroll). A live page supplies none, so it draws everything.
 */
export type DeferredDrawing = Readonly<{
  near: (element: Element, holder: string) => boolean;
  subscribe: (listener: () => void) => () => void;
  /** Called before slots are drawn: notes what the person is looking at. */
  anchor: () => void;
  /** Called once they are drawn: the view is moved so that what was noted has not moved. */
  settle: () => void;
}>;

const DeferredDrawingContext = createContext<DeferredDrawing | null>(null);

export const DeferredDrawingProvider = DeferredDrawingContext.Provider;

/** The room a slot that has not been drawn yet holds, so the page below it is not pulled up. */
const WAITING_SLOT: CSSProperties = { minHeight: "10rem" };

/**
 * A block's slot on the editor's canvas (`holder` is the block). Puck draws and registers every block of a slot it is given
 * to draw, which for a page of hundreds of blocks is most of the time it takes to open: a slot is
 * drawn once it comes near what the canvas shows (or holds the selected block), and then stays
 * drawn. A page that is not being edited draws every slot at once.
 */
export function DeferredSlot({
  holder,
  forced,
  children,
}: Readonly<{
  /** The placement whose slot this is. */
  holder: string;
  forced: boolean;
  children: ReactNode;
}>): ReactNode {
  const deferral = useContext(DeferredDrawingContext);
  const [placed, setPlaced] = useState(deferral === null);
  const waiting = useRef<HTMLDivElement>(null);
  const drawn = placed || forced;
  useLayoutEffect(() => {
    if (forced) setPlaced(true);
  }, [forced]);
  // Drawn above what the person is looking at: the content they look at keeps its place.
  useLayoutEffect(() => {
    if (drawn) deferral?.settle();
  }, [drawn, deferral]);
  // Before the first paint: a slot that is near is never seen waiting (no jump of the page below).
  useLayoutEffect(() => {
    if (drawn || deferral === null) return;
    const check = () => {
      const element = waiting.current;
      if (element === null || !deferral.near(element, holder)) return;
      deferral.anchor();
      setPlaced(true);
    };
    check();
    return deferral.subscribe(check);
  }, [drawn, deferral]);
  return drawn ? children : <div ref={waiting} aria-hidden="true" style={WAITING_SLOT} />;
}
