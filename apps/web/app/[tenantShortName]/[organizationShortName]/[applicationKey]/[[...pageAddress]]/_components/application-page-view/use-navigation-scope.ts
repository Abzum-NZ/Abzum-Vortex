import { useRef } from "react";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import type { ComponentRequestGeneration } from "@vortex/platform/schema";
import { searchWithoutTablePages } from "../../../../../../_lib/table-page-position";

export function useNavigationScope({
  model,
  pathname,
  currentSearch,
  application,
}: Readonly<{
  model: ApplicationPageModel;
  pathname: string;
  currentSearch: string;
  application: ApplicationPageModel["invocation"];
}>) {
  const serverDataRef = useRef(model.data);
  const serverModelRef = useRef(model);
  const serverDataGenerationRef = useRef(0);
  if (serverDataRef.current !== model.data || serverModelRef.current !== model) {
    serverDataRef.current = model.data;
    serverModelRef.current = model;
    serverDataGenerationRef.current += 1;
  }
  const navigationBase = JSON.stringify([
    pathname,
    // A table page change is shallow: it keeps the frame and the data already read.
    searchWithoutTablePages(currentSearch),
    model.pageId,
    application.installationRevision,
    application.releaseKey,
    serverDataGenerationRef.current,
  ]);
  const navigationSequenceRef = useRef(0);
  const placementRequestsRef = useRef<{
    base: string;
    key: string;
    generations: Map<string, ComponentRequestGeneration>;
  }>({ base: "", key: "", generations: new Map<string, ComponentRequestGeneration>() });
  const boardContinuationInFlightRef = useRef(new Set<string>());
  const tableContinuationScopeRef = useRef<{
    scopeKey: string;
    inFlight: Set<string>;
  }>({ scopeKey: "", inFlight: new Set() });
  if (placementRequestsRef.current.base !== navigationBase) {
    navigationSequenceRef.current += 1;
    placementRequestsRef.current = {
      base: navigationBase,
      key: `${navigationBase}:${navigationSequenceRef.current}`,
      generations: new Map(),
    };
  }
  const navigationKey = placementRequestsRef.current.key;

  return {
    navigationKey,
    placementRequestsRef,
    boardContinuationInFlightRef,
    tableContinuationScopeRef,
  };
}
