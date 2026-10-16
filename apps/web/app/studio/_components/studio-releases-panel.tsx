"use client";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@vortex/ui/components/item";
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
        <Item size="sm" variant={section === entry.value ? "muted" : "default"}
          render={<button type="button" aria-pressed={section === entry.value} onClick={() => onSection(entry.value)} />}>
          <ItemContent>
            <ItemTitle>{entry.label}</ItemTitle>
            <ItemDescription>{entry.description}</ItemDescription>
          </ItemContent>
        </Item>
      </li>)}
    </ul>
    <p className="text-sm text-muted-foreground">Draft: {savedStateLabel}. Publish a new version with Publish… at the top.</p>
  </StudioPanelShell>;
}
