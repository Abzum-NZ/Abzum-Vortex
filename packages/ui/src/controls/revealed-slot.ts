"use client";

import { createContext } from "react";

/**
 * The key of the slot of this placement that holds the block the builder has selected, or
 * undefined. The editor supplies it (a live page never does), so a block of tabs shows the tab
 * that holds the selection: the builder's tab strip takes no pointer.
 */
export const RevealedSlotContext = createContext<string | undefined>(undefined);
