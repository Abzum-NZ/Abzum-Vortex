"use client";
import type { VortexIconName } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import { StudioNavItem } from "./studio-nav-tree";
import { StudioPanelShell, StudioSection } from "./studio-frame";
import { studioReleasesSections, type StudioReleasesSection } from "./studio-rail-tabs";

const sectionIcons: Record<StudioReleasesSection, VortexIconName> = {
  history: "history",
  "page-adoption": "blocks",
  import: "arrow-up",
};

/** The Releases tab's panel: what it can open in the centre. Publishing itself is the top bar's Publish button. */
export function StudioReleasesPanel({
  hidden,
  section,
  onSection,
}: Readonly<{
  hidden: boolean;
  section: StudioReleasesSection;
  onSection: (section: StudioReleasesSection) => void;
}>) {
  return (
    <StudioPanelShell title="Releases" hidden={hidden}>
      <StudioSection title="Release tools">
        <ul className="m-0 list-none space-y-1 p-0" aria-label="Release tools">
          {studioReleasesSections.map((entry) => (
            <li key={entry.value}>
              <StudioNavItem
                label={entry.label}
                description={entry.description}
                icon={sectionIcons[entry.value]}
                selected={section === entry.value}
                onClick={() => onSection(entry.value)}
                meta={
                  entry.value === "import" ? <Badge variant="outline">Advanced</Badge> : undefined
                }
              />
            </li>
          ))}
        </ul>
      </StudioSection>
    </StudioPanelShell>
  );
}
