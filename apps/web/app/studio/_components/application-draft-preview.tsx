"use client";
import { Button } from "@vortex/ui/components/button";
import { NativeSelect } from "@vortex/ui/components/native-select";

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fingerprintSchema,
  pageCompositionSchema,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import {
  ApplicationPreview,
  createFullPlatformComponentRegistry,
  parseApplicationPreviewArtifact,
  type ApplicationPreviewArtifact,
  type ApplicationPreviewBreakpoint,
} from "@vortex/ui";
import { previewStudioApplicationHomepage } from "../preview-actions";

export type SavedHomepagePreviewContext = Readonly<{
  organizationId: string;
  rootId: string;
  key: string;
  draftRevision: number;
  sourceFingerprint: string;
  source: Readonly<ApplicationSourceDocument>;
  localLifetime: number;
  generation: number;
}>;

type PreviewRequest = Readonly<{
  context: SavedHomepagePreviewContext;
  breakpoint: ApplicationPreviewBreakpoint;
  pageKey: string;
  stepAlias?: string;
  generation: number;
}>;

type PreviewSelection = Readonly<{
  context: SavedHomepagePreviewContext;
  pageKey: string;
  stepAlias?: string;
}>;

type PreviewState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "pending"; request: PreviewRequest }>
  | Readonly<{ kind: "unavailable"; request: PreviewRequest; message: string }>
  | Readonly<{
      kind: "available";
      request: PreviewRequest;
      artifact: ApplicationPreviewArtifact;
      resolutionFingerprint: string;
    }>;

const sameContext = (
  left: SavedHomepagePreviewContext,
  right: SavedHomepagePreviewContext | null,
): boolean =>
  right !== null &&
  left.organizationId === right.organizationId &&
  left.rootId === right.rootId &&
  left.key === right.key &&
  left.draftRevision === right.draftRevision &&
  left.sourceFingerprint === right.sourceFingerprint &&
  left.source === right.source &&
  left.localLifetime === right.localLifetime &&
  left.generation === right.generation;

const selectionFor = (
  context: SavedHomepagePreviewContext | null,
  selection: PreviewSelection | null,
): PreviewSelection | null => {
  if (context === null) return null;
  if (selection !== null && sameContext(selection.context, context)) return selection;
  const pages = context.source.body.pages.filter(
    (page) => page.key === context.source.body.home_page,
  );
  const page = pages[0];
  if (pages.length !== 1 || page === undefined) return null;
  if (page.type !== "guided_form") return { context, pageKey: page.key };
  const firstStep = page.steps[0];
  return firstStep === undefined ? null : { context, pageKey: page.key, stepAlias: firstStep.id };
};

const buttonClass = "";
const breakpoints: readonly ApplicationPreviewBreakpoint[] = ["desktop", "tablet", "phone"];

class PreviewRenderBoundary extends Component<
  {
    children: ReactNode;
    onUnavailable: () => void;
  },
  { unavailable: boolean }
> {
  override state = { unavailable: false };
  static getDerivedStateFromError() {
    return { unavailable: true };
  }
  override componentDidCatch() {
    this.props.onUnavailable();
  }
  override render() {
    return this.state.unavailable ? (
      <p role="status">This saved page could not be rendered. No substitute content is shown.</p>
    ) : (
      this.props.children
    );
  }
}

/** Consumes only the protected saved-draft producer; it never sends local source or effects. */
export function ApplicationDraftPreview({
  context,
  readContext,
}: {
  context: SavedHomepagePreviewContext | null;
  readContext: () => SavedHomepagePreviewContext | null;
}) {
  const registry = useMemo(() => createFullPlatformComponentRegistry(), []);
  const [breakpoint, setBreakpoint] = useState<ApplicationPreviewBreakpoint>("desktop");
  const selectedBreakpoint = useRef<ApplicationPreviewBreakpoint>("desktop");
  const [selection, setSelection] = useState<PreviewSelection | null>(null);
  const selectedSelection = useRef<PreviewSelection | null>(null);
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  const [simulation, setSimulation] = useState("");
  const active = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current += 1;
      pending.current = false;
    };
  }, []);

  // Context transitions also invalidate a request that would later return to the same snapshot.
  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    selectedSelection.current = null;
    setSelection(null);
    setState({ kind: "idle" });
    setSimulation("");
  }, [
    context?.organizationId,
    context?.rootId,
    context?.key,
    context?.draftRevision,
    context?.sourceFingerprint,
    context?.source,
    context?.localLifetime,
    context?.generation,
  ]);

  const isCurrent = (request: PreviewRequest): boolean => {
    const current = readContext();
    const chosen = selectionFor(current, selectedSelection.current);
    return (
      active.current &&
      request.generation === generation.current &&
      request.breakpoint === selectedBreakpoint.current &&
      sameContext(request.context, current) &&
      chosen !== null &&
      request.pageKey === chosen.pageKey &&
      request.stepAlias === chosen.stepAlias
    );
  };

  const invalidate = () => {
    generation.current += 1;
    pending.current = false;
    setState({ kind: "idle" });
    setSimulation("");
  };

  const choose = (next: PreviewSelection) => {
    selectedSelection.current = next;
    invalidate();
    setSelection(next);
  };

  const chosen = selectionFor(context, selection);
  const chosenPage = context?.source.body.pages.find((page) => page.key === chosen?.pageKey);

  const preview = async () => {
    const current = readContext();
    const currentSelection = selectionFor(current, selectedSelection.current);
    if (
      !active.current ||
      pending.current ||
      current === null ||
      context === null ||
      !sameContext(context, current) ||
      currentSelection === null ||
      !fingerprintSchema.safeParse(current.sourceFingerprint).success
    )
      return;
    const request: PreviewRequest = {
      context: current,
      breakpoint: selectedBreakpoint.current,
      generation: ++generation.current,
      pageKey: currentSelection.pageKey,
      ...(currentSelection.stepAlias === undefined
        ? {}
        : { stepAlias: currentSelection.stepAlias }),
    };
    pending.current = true;
    setState({ kind: "pending", request });
    setSimulation("");
    try {
      const result = await previewStudioApplicationHomepage(current.organizationId, {
        rootId: current.rootId,
        draftRevision: current.draftRevision,
        breakpoint: request.breakpoint,
        sourceFingerprint: current.sourceFingerprint,
        pageKey: request.pageKey,
        ...(request.stepAlias === undefined ? {} : { stepAlias: request.stepAlias }),
      });
      if (!isCurrent(request)) return;
      if (result.kind !== "available") {
        const message =
          result.kind === "conflict"
            ? "The saved draft changed. Reopen it explicitly before requesting another preview."
            : result.kind === "refused"
              ? result.reason === "dependency_unavailable"
                ? "The saved draft's required release is unavailable. No substitute theme or component is used."
                : "The selected saved page could not be previewed with the current permissions and source."
              : "Preview is temporarily unavailable. Your editing inputs are preserved.";
        setState({ kind: "unavailable", request, message });
        return;
      }
      const sourceFingerprint = fingerprintSchema.safeParse(result.sourceFingerprint);
      const resolutionFingerprint = fingerprintSchema.safeParse(result.resolutionFingerprint);
      if (
        !sourceFingerprint.success ||
        !resolutionFingerprint.success ||
        result.organizationId !== current.organizationId ||
        result.key !== current.key ||
        result.sourceFingerprint !== current.sourceFingerprint ||
        result.selection.pageKey !== request.pageKey ||
        result.selection.stepAlias !== request.stepAlias
      ) {
        setState({
          kind: "unavailable",
          request,
          message: "The preview did not match the saved draft. No preview is shown.",
        });
        return;
      }
      const artifact = parseApplicationPreviewArtifact(result.artifact);
      const page = artifact.composition.pages[0];
      const sourcePage = current.source.body.pages.find((item) => item.key === request.pageKey);
      const stepMatches = page?.steps?.filter((step) => step.id === artifact.activeStepId);
      if (
        artifact.rootId !== current.rootId ||
        artifact.draftRevision !== current.draftRevision ||
        artifact.breakpoint !== request.breakpoint ||
        artifact.pageId !== result.selection.pageId ||
        artifact.activeStepId !== result.selection.activeStepId ||
        sourcePage === undefined ||
        artifact.composition.pages.length !== 1 ||
        page === undefined ||
        page.pageId !== artifact.pageId ||
        (sourcePage.type === "guided_form"
          ? artifact.activeStepId === undefined ||
            stepMatches?.length !== 1 ||
            page.steps?.length !== sourcePage.steps.length ||
            !("stepContent" in page.composition) ||
            !Object.hasOwn(page.composition.stepContent, artifact.activeStepId)
          : artifact.activeStepId !== undefined ||
            page.steps !== undefined ||
            !pageCompositionSchema.safeParse(page.composition).success)
      ) {
        setState({
          kind: "unavailable",
          request,
          message: "The preview did not match the requested saved page, step, revision and size.",
        });
        return;
      }
      if (isCurrent(request))
        setState({
          kind: "available",
          request,
          artifact,
          resolutionFingerprint: resolutionFingerprint.data,
        });
    } catch {
      if (isCurrent(request))
        setState({
          kind: "unavailable",
          request,
          message:
            "The selected saved page preview could not be verified. Your editing inputs are preserved.",
        });
    } finally {
      if (request.generation === generation.current) pending.current = false;
    }
  };

  // Check the live workspace as well as rendered props before showing a retained artifact.
  const visible =
    state.kind !== "idle" &&
    context !== null &&
    sameContext(state.request.context, context) &&
    isCurrent(state.request)
      ? state
      : null;
  const isPending = visible?.kind === "pending";
  return (
    <section
      className="space-y-3 rounded-xl border bg-card text-card-foreground border-border p-4"
      aria-label="Saved draft preview"
      aria-busy={isPending}
    >
      <h2 className="font-semibold">Saved draft preview</h2>
      <p className="text-sm">
        Choose a saved page and, for guided forms, a declared step. Interactions are simulations;
        nothing is saved, published or installed.
      </p>
      <label className="block text-sm">
        Saved page
        <NativeSelect
          className={`${buttonClass} ml-2`}
          value={chosen?.pageKey ?? ""}
          disabled={context === null}
          onChange={(event) => {
            const current = readContext();
            if (current === null || context === null || !sameContext(context, current)) return;
            const page = current.source.body.pages.find(
              (item) => item.key === event.currentTarget.value,
            );
            if (page === undefined) return;
            if (page.type !== "guided_form") choose({ context: current, pageKey: page.key });
            else {
              const firstStep = page.steps[0];
              if (firstStep !== undefined)
                choose({ context: current, pageKey: page.key, stepAlias: firstStep.id });
            }
          }}
        >
          {context === null && <option value="">No saved baseline</option>}
          {context?.source.body.pages.map((page) => (
            <option key={page.key} value={page.key}>
              {page.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      {chosenPage?.type === "guided_form" && (
        <label className="block text-sm">
          Guided step
          <NativeSelect
            className={`${buttonClass} ml-2`}
            value={chosen?.stepAlias ?? ""}
            onChange={(event) => {
              const current = readContext();
              const currentSelection = selectionFor(current, selectedSelection.current);
              if (
                current === null ||
                context === null ||
                !sameContext(context, current) ||
                currentSelection === null
              )
                return;
              const page = current.source.body.pages.find(
                (item) => item.key === currentSelection.pageKey,
              );
              if (
                page?.type !== "guided_form" ||
                !page.steps.some((step) => step.id === event.currentTarget.value)
              )
                return;
              choose({ context: current, pageKey: page.key, stepAlias: event.currentTarget.value });
            }}
          >
            {chosenPage.steps.map((step) => (
              <option key={step.id} value={step.id}>
                {step.name}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}
      <fieldset className="flex flex-wrap gap-2">
        <legend className="mb-2 text-sm">Preview size</legend>
        {breakpoints.map((size) => (
          <Button
            key={size}
            type="button"
            className={buttonClass}
            aria-pressed={breakpoint === size}
            onClick={() => {
              if (selectedBreakpoint.current === size) return;
              selectedBreakpoint.current = size;
              invalidate();
              setBreakpoint(size);
            }}
          >
            {size === "desktop" ? "Desktop" : size === "tablet" ? "Tablet" : "Phone"}
          </Button>
        ))}
      </fieldset>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={buttonClass}
        disabled={context === null || chosen === null || isPending}
        onClick={preview}
      >
        Preview saved page
      </Button>
      <p role="status" aria-live="polite">
        {context === null
          ? "Preview requires a verified saved baseline with no unsaved or pending inputs. Finish editing or reopen the saved draft explicitly."
          : visible?.kind === "pending"
            ? "Reading the selected saved page preview…"
            : visible?.kind === "unavailable"
              ? visible.message
              : visible?.kind === "available"
                ? `Saved revision ${visible.artifact.draftRevision} preview. ${simulation}`
                : "Choose a page, step and size, then request its saved preview."}
      </p>
      {visible?.kind === "available" && (
        <PreviewRenderBoundary
          key={visible.request.generation}
          onUnavailable={() => {
            if (isCurrent(visible.request))
              setState({
                kind: "unavailable",
                request: visible.request,
                message: "This saved page could not be rendered. No substitute content is shown.",
              });
          }}
        >
          <ApplicationPreview
            artifact={visible.artifact}
            registry={registry}
            breakpoint={visible.request.breakpoint}
            onSimulation={() => {
              if (isCurrent(visible.request))
                setSimulation("Simulated interaction only. No business action was performed.");
            }}
          />
        </PreviewRenderBoundary>
      )}
    </section>
  );
}
