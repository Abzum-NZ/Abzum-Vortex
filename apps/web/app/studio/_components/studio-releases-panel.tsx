"use client";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@vortex/ui/components/item";
import { Badge } from "@vortex/ui/components/badge";
import { StudioPanelShell } from "./studio-frame";
import { studioReleasesSections, type StudioReleasesSection } from "./studio-rail-tabs";

/** The Releases tab's panel: what it can open in the centre. Publishing itself is the top bar's Publish button. */
export function StudioReleasesPanel({
  hidden,
  section,
  onSection,
  savedStateLabel,
}: Readonly<{
  hidden: boolean;
  section: StudioReleasesSection;
  onSection: (section: StudioReleasesSection) => void;
  savedStateLabel: string;
}>) {
  return (
    <StudioPanelShell
      title="Releases"
      hidden={hidden}
      description="Published versions of this application. Organisations install and upgrade them from the App Store."
    >
      <ul className="list-none space-y-1" aria-label="Release tools">
        {studioReleasesSections.map((entry) => (
          <li key={entry.value}>
            <Item
              size="sm"
              variant={section === entry.value ? "muted" : "default"}
              className={section === entry.value ? "bg-accent text-accent-foreground" : undefined}
              render={
                <button
                  type="button"
                  aria-pressed={section === entry.value}
                  onClick={() => onSection(entry.value)}
                />
              }
            >
              <ItemContent>
                <ItemTitle>
                  {entry.label}
                  {entry.value === "import" && <Badge variant="outline">Advanced</Badge>}
                </ItemTitle>
                <ItemDescription
                  className={
                    section === entry.value ? "line-clamp-1 text-accent-foreground" : "line-clamp-1"
                  }
                >
                  {entry.description}
                </ItemDescription>
              </ItemContent>
            </Item>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <Badge variant="outline" role="status" aria-live="polite">
          {savedStateLabel}
        </Badge>
      </div>
    </StudioPanelShell>
  );
}
