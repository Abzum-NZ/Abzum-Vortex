"use client";

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApplicationSourceDocumentV2 } from "@vortex/contracts";
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
  source: Readonly<ApplicationSourceDocumentV2>;
  localLifetime: number;
  generation: number;
}>;

type PreviewRequest = Readonly<{
  context: SavedHomepagePreviewContext;
  breakpoint: ApplicationPreviewBreakpoint;
  generation: number;
}>;

type PreviewState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "pending"; request: PreviewRequest }>
  | Readonly<{ kind: "unavailable"; request: PreviewRequest; message: string }>
  | Readonly<{ kind: "available"; request: PreviewRequest;
      artifact: ApplicationPreviewArtifact; resolutionFingerprint: string }>;

const sameContext = (left: SavedHomepagePreviewContext, right: SavedHomepagePreviewContext | null): boolean =>
  right !== null && left.organizationId === right.organizationId && left.rootId === right.rootId &&
  left.key === right.key && left.draftRevision === right.draftRevision &&
  left.sourceFingerprint === right.sourceFingerprint && left.source === right.source &&
  left.localLifetime === right.localLifetime && left.generation === right.generation;

const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";
const breakpoints: readonly ApplicationPreviewBreakpoint[] = ["desktop", "tablet", "phone"];

class PreviewRenderBoundary extends Component<{
  children: ReactNode; onUnavailable: () => void;
}, { unavailable: boolean }> {
  override state = { unavailable: false };
  static getDerivedStateFromError() { return { unavailable: true }; }
  override componentDidCatch() { this.props.onUnavailable(); }
  override render() {
    return this.state.unavailable
      ? <p role="status">This saved homepage could not be rendered. No substitute content is shown.</p>
      : this.props.children;
  }
}

/** Consumes only the protected saved-homepage producer; it never sends local source or effects. */
export function ApplicationDraftPreview({ context, readContext }: {
  context: SavedHomepagePreviewContext | null;
  readContext: () => SavedHomepagePreviewContext | null;
}) {
  const registry = useMemo(() => createFullPlatformComponentRegistry(), []);
  const [breakpoint, setBreakpoint] = useState<ApplicationPreviewBreakpoint>("desktop");
  const selectedBreakpoint = useRef<ApplicationPreviewBreakpoint>("desktop");
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  const [simulation, setSimulation] = useState("");
  const active = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; generation.current += 1; pending.current = false; };
  }, []);

  // Context transitions also invalidate a request that would later return to the same snapshot.
  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setState({ kind: "idle" });
    setSimulation("");
  }, [context?.organizationId, context?.rootId, context?.key, context?.draftRevision,
    context?.sourceFingerprint, context?.source, context?.localLifetime, context?.generation, breakpoint]);

  const isCurrent = (request: PreviewRequest): boolean => active.current &&
    request.generation === generation.current && request.breakpoint === selectedBreakpoint.current &&
    sameContext(request.context, readContext());

  const preview = async () => {
    const current = readContext();
    if (!active.current || pending.current || current === null || context === null ||
      !sameContext(context, current)) return;
    const request: PreviewRequest = {
      context: current, breakpoint: selectedBreakpoint.current, generation: ++generation.current,
    };
    pending.current = true;
    setState({ kind: "pending", request });
    setSimulation("");
    try {
      const result = await previewStudioApplicationHomepage(current.organizationId, {
        rootId: current.rootId, draftRevision: current.draftRevision, breakpoint: request.breakpoint,
      });
      if (!isCurrent(request)) return;
      if (result.kind !== "available") {
        const message = result.kind === "conflict"
          ? "The saved draft changed. Reopen it explicitly before requesting another preview."
          : result.kind === "refused"
            ? result.reason === "dependency_unavailable"
              ? "The saved draft's required release is unavailable. No substitute theme or component is used."
              : "The saved homepage could not be previewed with the current permissions and source."
            : "Preview is temporarily unavailable. Your editing inputs are preserved.";
        setState({ kind: "unavailable", request, message });
        return;
      }
      if (result.organizationId !== current.organizationId || result.key !== current.key ||
        result.sourceFingerprint !== current.sourceFingerprint ||
        typeof result.resolutionFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(result.resolutionFingerprint)) {
        setState({ kind: "unavailable", request, message: "The preview did not match the saved draft. No preview is shown." });
        return;
      }
      const artifact = parseApplicationPreviewArtifact(result.artifact);
      if (artifact.rootId !== current.rootId || artifact.draftRevision !== current.draftRevision ||
        artifact.breakpoint !== request.breakpoint) {
        setState({ kind: "unavailable", request, message: "The preview did not match the requested saved revision and size." });
        return;
      }
      if (isCurrent(request)) setState({ kind: "available", request, artifact,
        resolutionFingerprint: result.resolutionFingerprint });
    } catch {
      if (isCurrent(request)) setState({ kind: "unavailable", request,
        message: "The saved homepage preview could not be verified. Your editing inputs are preserved." });
    } finally {
      if (request.generation === generation.current) pending.current = false;
    }
  };

  // Check the live workspace as well as rendered props before showing a retained artifact.
  const visible = state.kind !== "idle" && context !== null &&
    sameContext(state.request.context, context) && isCurrent(state.request) ? state : null;
  const isPending = visible?.kind === "pending";
  return <section className="space-y-3 rounded border border-border p-4" aria-label="Saved homepage preview"
    aria-busy={isPending}>
    <h2 className="font-semibold">Saved homepage preview</h2>
    <p className="text-sm">Preview the saved homepage and its first declared guided step. Interactions are simulations;
      nothing is saved, published or installed.</p>
    <fieldset className="flex flex-wrap gap-2"><legend className="mb-2 text-sm">Preview size</legend>
      {breakpoints.map((size) => <button key={size} type="button" className={buttonClass}
        aria-pressed={breakpoint === size} onClick={() => {
          if (selectedBreakpoint.current === size) return;
          selectedBreakpoint.current = size;
          generation.current += 1;
          pending.current = false;
          setState({ kind: "idle" });
          setSimulation("");
          setBreakpoint(size);
        }}>{size === "desktop" ? "Desktop" : size === "tablet" ? "Tablet" : "Phone"}</button>)}
    </fieldset>
    <button type="button" className={buttonClass} disabled={context === null || isPending}
      onClick={preview}>Preview saved homepage</button>
    <p role="status" aria-live="polite">{context === null
      ? "Preview requires a verified saved baseline with no unsaved or pending inputs. Finish editing or reopen the saved draft explicitly."
      : visible?.kind === "pending" ? "Reading the saved homepage preview…"
        : visible?.kind === "unavailable" ? visible.message
          : visible?.kind === "available" ? `Saved revision ${visible.artifact.draftRevision} preview. ${simulation}`
            : "Choose a size and request the saved homepage preview."}</p>
    {visible?.kind === "available" && <PreviewRenderBoundary key={visible.request.generation}
      onUnavailable={() => {
        if (isCurrent(visible.request)) setState({ kind: "unavailable", request: visible.request,
          message: "This saved homepage could not be rendered. No substitute content is shown." });
      }}>
      <ApplicationPreview artifact={visible.artifact} registry={registry}
        breakpoint={visible.request.breakpoint} onSimulation={() => {
          if (isCurrent(visible.request)) setSimulation("Simulated interaction only. No business action was performed.");
        }} />
    </PreviewRenderBoundary>}
  </section>;
}
