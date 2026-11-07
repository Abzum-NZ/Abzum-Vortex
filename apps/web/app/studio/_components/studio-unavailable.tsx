import { APPLICATION_MAIN_CONTENT_ID } from "@vortex/ui";
import { UnavailableState, type UnavailableWay } from "../../_components/unavailable-state";
import { loadStudioFrameContext } from "../_lib/studio-frame";
import { StudioFrameBar } from "./studio-header";
import { unavailableMessage, type StudioUnavailableKind } from "./studio-refusal-messages";

const titles: Readonly<Record<StudioUnavailableKind, string>> = {
  refused: "is not available to your account",
  conflict: "changed while it was loading",
  temporarily_unavailable: "is temporarily unavailable",
  validation_failed: "cannot be opened",
  dependency_unavailable: "is missing a release",
  no_change: "has no changes",
};

/** A loader that did not return, with the reason code when it gave one. */
export type StudioUnavailableResult =
  | Readonly<{ kind: StudioUnavailableKind; reason?: string | undefined }>
  /** The organisation names no App Store, or one that names no application. */
  | Readonly<{ kind: "not_configured"; invalid: boolean }>;

/** Reasons that say the organisation is not the person's: no frame is read for it, and no second line logged. */
const withoutFrame: ReadonlySet<string> = new Set([
  "session_ended",
  "organization_unavailable",
  "organization_mismatch",
]);

/** A state that heals on its own gets Try again; the others lead back to where the person can work. */
const retryKinds: ReadonlySet<string> = new Set(["temporarily_unavailable", "conflict"]);

/**
 * The one place a Studio page shows a loader that did not return the draft, with the sentence for
 * its reason (the reason code itself is never shown). Given the organisation, it draws inside
 * Studio's frame bar, with the organisation and account menus, when the person's Studio gives one.
 */
export async function StudioUnavailable({
  subject,
  result,
  organizationId,
}: {
  subject: string;
  result: StudioUnavailableResult;
  organizationId?: string;
}) {
  const reason = "reason" in result ? result.reason : undefined;
  const context =
    organizationId === undefined || (reason !== undefined && withoutFrame.has(reason))
      ? undefined
      : await loadStudioFrameContext(organizationId);
  const frame = context?.kind === "available" ? context.frame : undefined;
  const chooser = { kind: "back", label: "Choose an organisation", href: "/signed-in" } as const;
  const way: UnavailableWay =
    result.kind === "not_configured"
      ? chooser
      : retryKinds.has(result.kind)
        ? { kind: "retry" }
        : frame === undefined
          ? chooser
          : { kind: "back", label: "Back to Studio", href: frame.studioHref };
  const [title, sentence] =
    result.kind === "not_configured"
      ? [
          "App Store address not set",
          result.invalid
            ? "This organisation's App Store address names no application. An organisation administrator corrects it in Organisation administration."
            : "Studio has no App Store address in this organisation yet. An organisation administrator sets it in Organisation administration.",
        ]
      : [`${subject} ${titles[result.kind]}`, unavailableMessage(result.kind, reason)];
  const state = (
    <UnavailableState
      title={title}
      sentence={sentence}
      way={way}
      region={frame === undefined ? "page" : "content"}
    />
  );
  if (frame === undefined) return state;
  return (
    <div className="flex min-h-svh flex-col">
      <StudioFrameBar frame={frame} pageName="Studio" />
      {/* The frame bar's skip link lands here, as it lands in the editor's main. */}
      <main
        id={APPLICATION_MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 items-center justify-center p-6 outline-none"
      >
        {state}
      </main>
    </div>
  );
}
