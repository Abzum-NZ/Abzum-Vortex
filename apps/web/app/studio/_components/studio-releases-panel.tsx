"use client";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@vortex/ui/components/item";
import { Badge } from "@vortex/ui/components/badge";
import { Icon, type VortexIconName } from "@vortex/ui";
import { StudioPanelShell } from "./studio-frame";
import { studioReleasesSections, type StudioReleasesSection } from "./studio-rail-tabs";

const sectionIcons: Record<StudioReleasesSection, VortexIconName> = {
  history: "history",
  "page-adoption": "files",
  import: "upload",
};

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
      <ul className="m-0 list-none space-y-1 p-0" aria-label="Release tools">
        {studioReleasesSections.map((entry) => (
          <li key={entry.value}>
            <Item
              size="sm"
              className="text-left text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
              render={
                <button
                  type="button"
                  aria-pressed={section === entry.value}
                  onClick={() => onSection(entry.value)}
                />
              }
            >
              <ItemMedia>
                <Icon name={sectionIcons[entry.value]} className="size-4" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {entry.label}
                  {entry.value === "import" && <Badge variant="outline">Advanced</Badge>}
                </ItemTitle>
                <ItemDescription
                  className={
                    section === entry.value
                      ? "line-clamp-1 text-accent-foreground"
                      : "line-clamp-1 text-muted-foreground group-hover/item:text-accent-foreground group-focus-visible/item:text-accent-foreground"
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
