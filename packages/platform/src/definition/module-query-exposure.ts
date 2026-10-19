import { z } from "zod";

/**
 * Who may read a Module query: "private" only the Application that owns the Module, "exposed"
 * also every Application that uses the Module. One rule decides it everywhere: the Studio picker,
 * the draft compile, publication validation and the database read.
 */
export const moduleQueryExposureSchema = z.enum(["private", "exposed"]);
export type ModuleQueryExposure = z.infer<typeof moduleQueryExposureSchema>;

/** Whether an Application that only uses the query's Module may read the query. */
export const moduleQueryBorrowable = (query: Readonly<{ exposure?: unknown }>): boolean =>
  query.exposure === "exposed";
