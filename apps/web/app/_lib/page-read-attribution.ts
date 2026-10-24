import "server-only";

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import { after } from "next/server";
import { withProtectedReadObserver, type ProtectedReadMeasurement } from "@vortex/platform/server";

type Counter = { count: number; durationMs: number; returnedRows: number; failures: number };
type Summary = {
  requestId: string;
  route: string;
  organization: string;
  application: string;
  operation: "page" | "placements";
  rowCount: number;
  rowCountSource: "module_query_returned_rows";
  families: Record<ProtectedReadMeasurement["family"], Counter>;
};
type Collector = { summary: Summary; observe: (measurement: ProtectedReadMeasurement) => void };
const active = new AsyncLocalStorage<Collector>();

// Opt-in only, in every environment: a measurement run sets it; ordinary use logs nothing.
const enabled = (): boolean => process.env.VORTEX_PAGE_READ_ATTRIBUTION === "1";

const createCollector = (operation: Summary["operation"]): Collector => {
  const counter = (): Counter => ({ count: 0, durationMs: 0, returnedRows: 0, failures: 0 });
  const summary: Summary = {
    requestId: randomUUID(),
    // Never log the actual address, query string, organisation name or record id.
    route: "/[tenantShortName]/[organizationShortName]/[applicationKey]/[[...pageAddress]]",
    organization: "unresolved",
    application: "unresolved",
    operation,
    rowCount: 0,
    rowCountSource: "module_query_returned_rows",
    families: {
      eligibility_batch: counter(),
      eligibility_single: counter(),
      module_query: counter(),
      record_titles: counter(),
      installation: counter(),
      other_protected_read: counter(),
    },
  };
  let closed = false;
  after(() => {
    closed = true;
    for (const counter of Object.values(summary.families))
      counter.durationMs = Math.round(counter.durationMs * 100) / 100;
    console.info(`[page-read-attribution] ${JSON.stringify(summary)}`);
  });
  return {
    summary,
    observe: (measurement) => {
      if (closed) return;
      const counter = summary.families[measurement.family];
      counter.count += 1;
      counter.durationMs += measurement.durationMs;
      counter.returnedRows += measurement.returnedRows;
      counter.failures += Number(measurement.failed);
      if (measurement.family === "module_query") summary.rowCount += measurement.returnedRows;
    },
  };
};

// The frame, loading theme and page are separate React tasks in one RSC request.
const renderCollector = cache(() => createCollector("page"));

export const withPageReadAttribution = <Result>(
  operation: () => Promise<Result>,
  kind: Summary["operation"] = "page",
): Promise<Result> => {
  if (!enabled()) return operation();
  const collector =
    active.getStore() ?? (kind === "page" ? renderCollector() : createCollector(kind));
  return active.run(collector, () => withProtectedReadObserver(collector.observe, operation));
};

/** Only verified opaque identifiers, already carried by protected reads, enter the summary. */
export const attributePageReadScope = (organizationId: string, applicationRootId: string): void => {
  const collector = active.getStore();
  if (collector === undefined) return;
  collector.summary.organization = organizationId;
  collector.summary.application = applicationRootId;
};
