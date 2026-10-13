import { isRecord } from "@vortex/platform/schema";
import { useCallback, useEffect, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import {
  type ControlSemanticEvent,
  type ChoiceInputPayload,
  parseChoiceInputPayload,
} from "@vortex/ui";
import type {
  ReferenceChoiceSelectionEvidenceMap,
  ReferenceChoiceSelectionEvidence,
  ComponentRequestGeneration,
} from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../_lib/application-page";
import type { Notice } from "./types";
import { choiceScopeKey } from "./event-values";
import { unavailableNotice } from "./notices";

// The UI parser accepts at most 200 options in one projected choice payload.
const maximumVisibleChoices = 200;

export function useReferenceChoices({
  setChoicePagesOwner,
  model,
  setChoicePages,
  setDialogChoicePages,
  choiceSelectionsRef,
  choiceDefaultContextsRef,
  choiceRequestIdsRef,
  activeChoicePages,
  activeDialogChoicePages,
  currentData,
  placementRequestsRef,
  application,
  router,
  setNotice,
  requestChoicePageRef,
}: Readonly<{
  setChoicePagesOwner: Dispatch<SetStateAction<ApplicationPageModel>>;
  model: ApplicationPageModel;
  setChoicePages: Dispatch<SetStateAction<Readonly<Record<string, ChoiceInputPayload>>>>;
  setDialogChoicePages: Dispatch<SetStateAction<Readonly<Record<string, ChoiceInputPayload>>>>;
  choiceSelectionsRef: RefObject<Record<string, Readonly<{ key: string; evidence: ReferenceChoiceSelectionEvidence }>>>;
  choiceDefaultContextsRef: RefObject<Record<string, boolean>>;
  choiceRequestIdsRef: RefObject<Record<string, number>>;
  activeChoicePages: Readonly<Record<string, ChoiceInputPayload>>;
  activeDialogChoicePages: Readonly<Record<string, ChoiceInputPayload>>;
  currentData: ApplicationPageModel["data"];
  placementRequestsRef: RefObject<{ base: string; key: string; generations: Map<string, ComponentRequestGeneration> }>;
  application: ApplicationPageModel["invocation"];
  router: ReturnType<typeof useRouter>;
  setNotice: Dispatch<SetStateAction<Notice | undefined>>;
  requestChoicePageRef: RefObject<(placementId: string, event: Extract<ControlSemanticEvent, { event: "choices_requested" }>, formId?: string) => Promise<void>>;
}>) {
  useEffect(() => {
    setChoicePagesOwner(model);
    setChoicePages({});
    setDialogChoicePages({});
    choiceSelectionsRef.current = {};
    choiceDefaultContextsRef.current = {};
    for (const placementId of Object.keys(choiceRequestIdsRef.current))
      choiceRequestIdsRef.current[placementId] = (choiceRequestIdsRef.current[placementId] ?? 0) + 1;
  }, [model]);

  const parseChoicePage = useCallback(
    (placementId: string, values: unknown): ChoiceInputPayload =>
      parseChoiceInputPayload(values, { pageId: model.pageId, placementId },
        model.referenceChoiceInputs.find((field) => field.placementId === placementId)?.releaseVersion,
      ),
    [model.pageId, model.referenceChoiceInputs],
  );

  const choicePayloadFor = useCallback(
    (placementId: string, formId?: string): ChoiceInputPayload | undefined => {
      const key = choiceScopeKey(placementId, formId);
      const loaded = formId === undefined ? activeChoicePages[key] : activeDialogChoicePages[key];
      if (loaded !== undefined) return loaded;
      const data = currentData[placementId];
      if (!isRecord(data) || data.status !== "ready") return undefined;
      try {
        return parseChoicePage(placementId, data.values);
      } catch {
        return undefined;
      }
    },
    [activeChoicePages, activeDialogChoicePages, currentData, parseChoicePage],
  );

  const choiceEvidenceFor = useCallback(
    (
      formId: string,
      values: Readonly<Record<string, unknown>>,
      surface: "page" | "dialog" = "page",
    ): ReferenceChoiceSelectionEvidenceMap | undefined => {
      const evidence: Record<string, NonNullable<ChoiceInputPayload["optionEvidence"]>[string]> = {};
      for (const field of model.referenceChoiceInputs) {
        if (field.formId.toLowerCase() !== formId.toLowerCase()) continue;
        const selected = values[field.fieldKey];
        if (typeof selected !== "string") continue;
        const issued = choicePayloadFor(
          field.placementId,
          surface === "dialog" ? formId : undefined,
        )?.optionEvidence?.[selected];
        if (issued !== undefined) evidence[field.fieldKey] = issued;
      }
      return Object.keys(evidence).length === 0 ? undefined : evidence;
    },
    [choicePayloadFor, model.referenceChoiceInputs],
  );

  const requestChoicePage = useCallback(
    async (
      placementId: string,
      event: Extract<ControlSemanticEvent, { event: "choices_requested" }>,
      formId?: string,
    ): Promise<void> => {
      const stateKey = choiceScopeKey(placementId, formId);
      const field = model.referenceChoiceInputs.find((candidate) => candidate.placementId === placementId);
      const dependencyContext = model.referenceChoiceInputs.some((candidate) =>
        candidate.formId === field?.formId && candidate.dependency !== undefined,
      ) ? placementRequestsRef.current.key : undefined;
      const currentContext = (): boolean => dependencyContext === undefined ||
        placementRequestsRef.current.key === dependencyContext;
      const dependencyChoice = field?.dependency === undefined ? undefined :
        choiceSelectionsRef.current[choiceScopeKey(field.dependency.placementId, formId)];
      if (field?.dependency !== undefined && dependencyChoice === undefined) return;
      const selected = field?.dependency === undefined ||
        choiceSelectionsRef.current[stateKey]?.key === event.selectedKey;
      const requestId = (choiceRequestIdsRef.current[stateKey] ?? 0) + 1;
      choiceRequestIdsRef.current[stateKey] = requestId;
      try {
        const response = await fetch("/api/reference-choices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({
            tenantShortName: application.tenantShortName,
            organizationShortName: application.organizationShortName,
            applicationKey: application.applicationKey,
            pageKey: application.pageKey,
            placementId,
            installationRevision: application.installationRevision,
            releaseKey: application.releaseKey,
            ...(event.search === undefined ? {} : { search: event.search }),
            ...(event.continuationToken === undefined
              ? {}
              : { continuationToken: event.continuationToken }),
            ...(event.selectedKey === undefined || !selected ? {} : { selectedKey: event.selectedKey }),
            ...(event.selectedEvidence === undefined || !selected
              ? {}
              : { selectedEvidence: event.selectedEvidence }),
            ...(dependencyChoice === undefined ? {} : { dependencyChoice }),
          }),
        });
        const body: unknown = await response.json();
        if (!currentContext() || choiceRequestIdsRef.current[stateKey] !== requestId) return;
        if (
          isRecord(body) &&
          body.kind === "reload"
        ) {
          router.refresh();
          return;
        }
        if (!response.ok || !isRecord(body) || body.kind !== "completed") {
          setNotice(unavailableNotice);
          router.refresh();
          return;
        }
        const payload = parseChoicePage(placementId, body.values);
        if (dependencyChoice !== undefined && payload.dependencyKey !== dependencyChoice.key) return;
        const setPages = formId === undefined ? setChoicePages : setDialogChoicePages;
        setPages((current) => {
          if (!currentContext() || choiceRequestIdsRef.current[stateKey] !== requestId) return current;
          const previous = current[stateKey] ?? choicePayloadFor(placementId, formId);
          const append = event.continuationToken !== undefined && previous !== undefined &&
            previous.dependencyKey === payload.dependencyKey;
          const allOptions = append
            ? [
                ...new Map(
                  [...(previous.options ?? []), ...(payload.options ?? [])].map((option) => [
                    option.key,
                    option,
                  ]),
                ).values(),
              ]
            : (payload.options ?? []);
          const selected = allOptions.find((option) => option.key === payload.value);
          const recent = allOptions.slice(-maximumVisibleChoices);
          const options =
            selected !== undefined && !recent.some((option) => option.key === selected.key)
              ? [selected, ...recent.slice(1)]
              : recent;
          const availableEvidence = append
            ? { ...previous.optionEvidence, ...payload.optionEvidence }
            : (payload.optionEvidence ?? {});
          const optionEvidence = Object.fromEntries(
            options.map((option) => [option.key, availableEvidence[option.key]]),
          );
          return {
            ...current,
            [stateKey]: parseChoicePage(placementId, {
                kind: "choice_input",
                value: payload.value ?? null,
                options,
                optionEvidence,
                ...(payload.dependencyKey === undefined ? {} : { dependencyKey: payload.dependencyKey }),
                ...(payload.nextContinuationToken === undefined
                  ? {}
                  : { nextContinuationToken: payload.nextContinuationToken }),
                ...(payload.error === undefined ? {} : { error: payload.error }),
              }),
          };
        });
      } catch {
        if (currentContext() && choiceRequestIdsRef.current[stateKey] === requestId)
          setNotice(unavailableNotice);
      }
    },
    [application, choicePayloadFor, model.referenceChoiceInputs, parseChoicePage, router],
  );
  requestChoicePageRef.current = requestChoicePage;

  const clearChoiceForm = useCallback((formId: string, dialogFormId?: string): void => {
    const fields = model.referenceChoiceInputs.filter((field) =>
      field.formId.toLowerCase() === formId.toLowerCase(),
    );
    if (!fields.some((field) => field.dependency !== undefined)) return;
    const keys = new Set(fields.map((field) => choiceScopeKey(field.placementId, dialogFormId)));
    for (const key of keys) {
      delete choiceSelectionsRef.current[key];
      delete choiceDefaultContextsRef.current[key];
      choiceRequestIdsRef.current[key] = (choiceRequestIdsRef.current[key] ?? 0) + 1;
    }
    const setPages = dialogFormId === undefined ? setChoicePages : setDialogChoicePages;
    setPages((current) => {
      const pages = Object.fromEntries(Object.entries(current).filter(([key]) => !keys.has(key)));
      for (const field of fields)
        if (field.dependency !== undefined)
          pages[choiceScopeKey(field.placementId, dialogFormId)] = parseChoicePage(field.placementId, {
            kind: "choice_input", value: null, options: [], optionEvidence: {}, dependencyKey: null,
          });
      return pages;
    });
  }, [model.referenceChoiceInputs, parseChoicePage]);

  const initializeChoiceForm = useCallback((
    formId: string,
    dialogFormId?: string,
    defaults?: Readonly<Record<string, unknown>>,
  ): void => {
    clearChoiceForm(formId, dialogFormId);
    const fields = model.referenceChoiceInputs.filter((field) =>
      field.formId.toLowerCase() === formId.toLowerCase(),
    );
    if (!fields.some((field) => field.dependency !== undefined)) return;
    for (const field of fields) {
      if (field.dependency !== undefined) continue;
      const data = currentData[field.placementId];
      if (!isRecord(data) || data.status !== "ready") continue;
      let payload: ChoiceInputPayload;
      try { payload = parseChoicePage(field.placementId, data.values); } catch { continue; }
      const key = defaults !== undefined && Object.hasOwn(defaults, field.fieldKey)
        ? defaults[field.fieldKey] : payload.value;
      const evidence = typeof key === "string" ? payload.optionEvidence?.[key] : undefined;
      if (typeof key === "string" && evidence !== undefined &&
          payload.options?.some((option) => option.key === key))
        choiceSelectionsRef.current[choiceScopeKey(field.placementId, dialogFormId)] = { key, evidence };
    }
    const setPages = dialogFormId === undefined ? setChoicePages : setDialogChoicePages;
    for (const field of fields) {
      if (field.dependency === undefined) continue;
      const parent = choiceSelectionsRef.current[choiceScopeKey(field.dependency.placementId, dialogFormId)];
      if (parent === undefined) continue;
      const key = choiceScopeKey(field.placementId, dialogFormId);
      choiceDefaultContextsRef.current[key] = true;
      setPages((current) => ({ ...current, [key]: parseChoicePage(field.placementId, {
        kind: "choice_input", value: null, options: [], optionEvidence: {}, dependencyKey: parent.key,
      }) }));
      void requestChoicePageRef.current(field.placementId, { event: "choices_requested" }, dialogFormId);
    }
  }, [clearChoiceForm, currentData, model.referenceChoiceInputs, parseChoicePage]);

  useEffect(() => {
    const forms = new Set(model.referenceChoiceInputs.filter((field) => field.dependency !== undefined)
      .map((field) => field.formId));
    for (const formId of forms) initializeChoiceForm(formId);
    return () => {
      for (const formId of forms) clearChoiceForm(formId);
    };
  }, [clearChoiceForm, initializeChoiceForm, model.referenceChoiceInputs]);

  const changeChoiceField = useCallback((
    placementId: string,
    event: ControlSemanticEvent,
    dialogFormId?: string,
  ): void => {
    if (event.event !== "field_changed") return;
    const field = model.referenceChoiceInputs.find((candidate) => candidate.placementId === placementId);
    if (field === undefined || !model.referenceChoiceInputs.some((candidate) =>
      candidate.formId === field.formId && candidate.dependency !== undefined,
    )) return;
    const stateKey = choiceScopeKey(placementId, dialogFormId);
    if (field.dependency !== undefined) delete choiceDefaultContextsRef.current[stateKey];
    const previous = choiceSelectionsRef.current[stateKey]?.key;
    const payload = choicePayloadFor(placementId, dialogFormId);
    const evidence = typeof event.value === "string" ? payload?.optionEvidence?.[event.value] : undefined;
    const next = typeof event.value === "string" && evidence !== undefined &&
      payload?.options?.some((option) => option.key === event.value)
      ? { key: event.value, evidence } : undefined;
    if (next === undefined) delete choiceSelectionsRef.current[stateKey];
    else choiceSelectionsRef.current[stateKey] = next;
    if (previous === next?.key) return;
    const setPages = dialogFormId === undefined ? setChoicePages : setDialogChoicePages;
    for (const child of model.referenceChoiceInputs) {
      if (child.formId !== field.formId || child.dependency?.placementId !== placementId) continue;
      const key = choiceScopeKey(child.placementId, dialogFormId);
      delete choiceSelectionsRef.current[key];
      delete choiceDefaultContextsRef.current[key];
      choiceRequestIdsRef.current[key] = (choiceRequestIdsRef.current[key] ?? 0) + 1;
      setPages((current) => ({ ...current, [key]: parseChoicePage(child.placementId, {
        kind: "choice_input", value: null, options: [], optionEvidence: {}, dependencyKey: next?.key ?? null,
      }) }));
      if (next !== undefined)
        void requestChoicePageRef.current(child.placementId, { event: "choices_requested" }, dialogFormId);
    }
  }, [choicePayloadFor, model.referenceChoiceInputs, parseChoicePage]);

  return { choicePayloadFor, choiceEvidenceFor, changeChoiceField, initializeChoiceForm, clearChoiceForm, requestChoicePage };
}
