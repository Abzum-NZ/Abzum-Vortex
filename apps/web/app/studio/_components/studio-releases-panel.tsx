"use client";
import { Button } from "@vortex/ui/components/button";
import { StudioPanelShell } from "./studio-frame";
import { studioReleasesSections, type StudioReleasesSection } from "./studio-rail-tabs";

/** The Releases tab's panel: what it can open in the centre. Publishing itself is the top bar's Publish button. */
export function StudioReleasesPanel({ hidden, section, onSection, savedStateLabel }: Readonly<{
  hidden: boolean;
  section: StudioReleasesSection;
  onSection: (section: StudioReleasesSection) => void;
  savedStateLabel: string;
}>) {
  return <StudioPanelShell title="Releases" hidden={hidden}
    description="Published versions of this application, and how they reach organisations.">
    <ul className="list-none space-y-1" aria-label="Release tools">
      {studioReleasesSections.map((entry) => <li key={entry.value}>
        <Button type="button" variant={section === entry.value ? "secondary" : "ghost"} aria-pressed={section === entry.value}
          className="h-auto w-full flex-col items-start whitespace-normal py-2 text-left" onClick={() => onSection(entry.value)}>
          <span className="font-medium">{entry.label}</span>
          <span className="text-xs text-muted-foreground">{entry.description}</span>
        </Button>
      </li>)}
    </ul>
    <p className="text-sm text-muted-foreground">Draft: {savedStateLabel}. Publish a new version with Publish… at the top.</p>
  </StudioPanelShell>;
}
