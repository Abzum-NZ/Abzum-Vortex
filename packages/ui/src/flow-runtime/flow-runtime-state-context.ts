"use client";

import { createContext } from "react";
import type { FlowRuntimeState } from "./flow-runtime";

/** The page's runtime state, shared with the controls rendered by its Puck tree. */
export const FlowRuntimeStateContext = createContext<FlowRuntimeState | undefined>(undefined);
