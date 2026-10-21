"use client";
import dynamic from "next/dynamic";
import { Component, type ComponentType, type ReactNode } from "react";

/** A deferred part that failed to load or draw says so in words; the cause goes to the console. */
class DeferredPartBoundary extends Component<
  Readonly<{ what: string; children: ReactNode }>,
  Readonly<{ failed: boolean }>
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error(`[studio] the ${this.props.what} could not be shown`, error);
  }

  override render() {
    return this.state.failed ? (
      <p role="alert" className="p-4 text-sm text-destructive">
        The {this.props.what} could not be loaded. Your changes are kept. Reload Studio and try
        again.
      </p>
    ) : (
      this.props.children
    );
  }
}

/**
 * A Studio panel, editor or dialog whose code loads the first time it is shown: one loading status
 * and, when its code cannot be loaded, one refusal, both in business words. `what` names it ("data
 * editor"). Create it once at module level.
 */
export function deferredStudioPart<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
  what: string,
): ComponentType<Props> {
  const Part = dynamic<Props>(load, { loading: () => <p role="status">Loading the {what}…</p> });
  return function DeferredStudioPart(props: Props) {
    return (
      <DeferredPartBoundary what={what}>
        <Part {...(props as Props & Record<string, unknown>)} />
      </DeferredPartBoundary>
    );
  };
}
