import { isRecord } from "@vortex/platform/schema";
import { useCallback, useEffect, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import {
  type ControlSemanticEvent,
  type ChoiceInputPayload,
  parseChoiceInputPayload,
} from "@vortex/ui";
import type { ReferenceChoiceSelectionEvidenceMap } from "@vortex/platform/schema";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
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
  choiceRequestIdsRef,
  activeChoicePages,
  activeDialogChoicePages,
  currentData,
  application,
  router,
  setNotice,
  requestChoicePageRef,
}: Readonly<{
  setChoicePagesOwner: Dispatch<SetStateAction<ApplicationPageModel>>;
  model: ApplicationPageModel;
  setChoicePages: Dispatch<SetStateAction<Readonly<Record<string, ChoiceInputPayload>>>>;
  setDialogChoicePages: Dispatch<SetStateAction<Readonly<Record<string, ChoiceInputPayload>>>>;
  choiceRequestIdsRef: RefObject<Record<string, number>>;
  activeChoicePages: Readonly<Record<string, ChoiceInputPayload>>;
  activeDialogChoicePages: Readonly<Record<string, ChoiceInputPayload>>;
  currentData: ApplicationPageModel["data"];
  application: ApplicationPageModel["invocation"];
  router: ReturnType<typeof useRouter>;
  setNotice: Dispatch<SetStateAction<Notice | undefined>>;
  requestChoicePageRef: RefObject<
    (
      placementId: string,
      event: Extract<ControlSemanticEvent, { event: "choices_requested" }>,
      formId?: string,
    ) => Promise<void>
  >;
}>) {
  useEffect(() => {
    setChoicePagesOwner(model);
    setChoicePages({});
    setDialogChoicePages({});
    for (const placementId of Object.keys(choiceRequestIdsRef.current))
      choiceRequestIdsRef.current[placementId] =
        (choiceRequestIdsRef.current[placementId] ?? 0) + 1;
  }, [model]);

  const parseChoicePage = useCallback(
    (placementId: string, values: unknown): ChoiceInputPayload =>
      parseChoiceInputPayload(values, { pageId: model.pageId, placementId }),
    [model.pageId],
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
      const evidence: Record<string, NonNullable<ChoiceInputPayload["optionEvidence"]>[string]> =
        {};
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
            ...(event.selectedKey === undefined ? {} : { selectedKey: event.selectedKey }),
            ...(event.selectedEvidence === undefined
              ? {}
              : { selectedEvidence: event.selectedEvidence }),
          }),
        });
        const body: unknown = await response.json();
        if (choiceRequestIdsRef.current[stateKey] !== requestId) return;
        if (isRecord(body) && body.kind === "reload") {
          router.refresh();
          return;
        }
        if (!response.ok || !isRecord(body) || body.kind !== "completed") {
          setNotice(unavailableNotice);
          router.refresh();
          return;
        }
        const payload = parseChoicePage(placementId, body.values);
        const setPages = formId === undefined ? setChoicePages : setDialogChoicePages;
        setPages((current) => {
          if (choiceRequestIdsRef.current[stateKey] !== requestId) return current;
          const previous = current[stateKey] ?? choicePayloadFor(placementId, formId);
          const append = event.continuationToken !== undefined && previous !== undefined;
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
              ...(payload.nextContinuationToken === undefined
                ? {}
                : { nextContinuationToken: payload.nextContinuationToken }),
              ...(payload.error === undefined ? {} : { error: payload.error }),
            }),
          };
        });
      } catch {
        if (choiceRequestIdsRef.current[stateKey] === requestId) setNotice(unavailableNotice);
      }
    },
    [application, choicePayloadFor, model.referenceChoiceInputs, parseChoicePage, router],
  );
  requestChoicePageRef.current = requestChoicePage;

  return { choicePayloadFor, choiceEvidenceFor, requestChoicePage };
}
