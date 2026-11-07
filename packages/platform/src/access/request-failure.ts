import "server-only";

import { describeFailure } from "../catalogue/runtime-primitives";
import { classifyRequestFailure } from "./request-failure-table";

/**
 * The one line for a failure caught outside the request runner (which logs its own answers): at
 * the level its class decides, so a refusal or a moved state is information and a fault an error.
 */
export const logClassifiedFailure = (line: string, error: unknown): void => {
  if (classifyRequestFailure(error, { addressed: false }).level === "info") console.info(line);
  else console.error(line);
};

/**
 * The one server-side line for a refusal or a caught failure: the route or service, the operation,
 * a stable reason code and, when there is one, the safe description of its cause (class names and
 * codes only). Ids may be part of `op`; personal data, values and secrets never are. Without a
 * cause it is an expected refusal and information; with one the cause's class decides the level.
 */
export const logRefusal = (route: string, op: string, code: string, cause?: unknown): void => {
  const message = `[${route}] ${op} refused: code=${code}`;
  if (cause === undefined) console.info(message);
  else logClassifiedFailure(`${message} cause=${describeFailure(cause)}`, cause);
};
