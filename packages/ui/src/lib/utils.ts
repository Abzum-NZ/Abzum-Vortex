import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// tailwind-merge builds its class map on the first call it receives. That call is made when this
// module loads (the server loads its route modules when it starts), not inside the first render.
twMerge();

/** Joins conditional class names and resolves conflicting Tailwind utilities, last one wins. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
