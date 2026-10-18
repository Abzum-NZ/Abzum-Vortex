"use client";
import { Label } from "@vortex/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@vortex/ui/components/radio-group";
import { StudioHelp, StudioInspectorGroup, type StudioSettingValues } from "@vortex/ui/studio";
import { peopleDirectory, type LinkCardinality } from "@vortex/platform/schema";

type LinkTarget = Readonly<{ key: string; label: string; titleLabel: string | undefined }>;

/** The record types a link field's settings point at, in order. */
export const linkSettingTargets = (settings: StudioSettingValues): readonly string[] => {
  const single = settings.target;
  if (single?.kind === "record_type_reference") return [single.record_type];
  const list = settings.targets;
  return list?.kind === "list"
    ? list.items.flatMap((item) =>
        item.kind === "record_type_reference" ? [item.record_type] : [],
      )
    : [];
};

/**
 * What a link field makes of its record type, read as a relationship: how many records may link to
 * one linked record, how each linked record is shown, the link in both directions, and, for a
 * link to a person, what it adds to the application.
 */
export function StudioLinkSection({
  settings,
  cardinality,
  label,
  recordName,
  recordPlural,
  targets,
  usesDirectory,
  disabled,
  onCardinality,
}: Readonly<{
  settings: StudioSettingValues;
  cardinality: LinkCardinality;
  /** The field's label, its name from the linking side. */
  label: string;
  recordName: string;
  recordPlural: string;
  targets: readonly LinkTarget[];
  /** Whether the application already uses the people directory. */
  usesDirectory: boolean;
  disabled: boolean;
  onCardinality: (cardinality: LinkCardinality) => void;
}>) {
  const chosen = linkSettingTargets(settings).map(
    (key) =>
      targets.find((target) => target.key === key) ?? { key, label: key, titleLabel: undefined },
  );
  const names =
    chosen.length === 0
      ? "the linked record type"
      : chosen.map((target) => target.label).join(" or ");
  const reverse =
    settings.reverse_name?.kind === "text" && settings.reverse_name.value.trim() !== ""
      ? settings.reverse_name.value.trim()
      : undefined;
  const linksPerson = chosen.some((target) => target.key === peopleDirectory.recordType);
  const name = label.trim() === "" ? "this link" : `"${label.trim()}"`;
  return (
    <StudioInspectorGroup title="Relationship">
      <fieldset className="space-y-2">
        <legend className="text-sm">
          How many {recordPlural.toLowerCase()} may link to one {names}?
        </legend>
        <RadioGroup
          value={cardinality}
          disabled={disabled}
          onValueChange={(value) => onCardinality(value as LinkCardinality)}
        >
          <div className="flex items-start gap-2">
            <RadioGroupItem id="module-field-cardinality-many" value="many_to_one" />
            <Label htmlFor="module-field-cardinality-many" className="font-normal">
              Many: several {recordPlural.toLowerCase()} may link to the same record
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem id="module-field-cardinality-one" value="one_to_one" />
            <Label htmlFor="module-field-cardinality-one" className="font-normal">
              One: each linked record has one {recordName.toLowerCase()} at most (each value is then
              different)
            </Label>
          </div>
        </RadioGroup>
      </fieldset>
      <dl className="space-y-1 text-sm">
        <div>
          <dt className="inline font-semibold">Shown as: </dt>
          <dd className="inline">
            {chosen.length === 0
              ? "choose the linked record type first."
              : chosen
                  .map((target) =>
                    target.titleLabel === undefined
                      ? `each ${target.label} by its title field`
                      : `each ${target.label} by its ${target.titleLabel.toLowerCase()}`,
                  )
                  .join("; ")}
            {chosen.length === 0 ? null : ". The title field is set on the linked record type."}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">From {recordName}: </dt>
          <dd className="inline">
            {name} links to one {names}.
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">From {names}: </dt>
          <dd className="inline">
            {reverse === undefined
              ? "name the link back in the settings above."
              : `"${reverse}" lists the ${cardinality === "one_to_one" ? recordName.toLowerCase() : recordPlural.toLowerCase()} linked to it.`}
          </dd>
        </div>
      </dl>
      {linksPerson && (
        <StudioHelp
          hint={`People come from the organisation's shared people directory.${usesDirectory ? "" : " The link also adds the directory to the modules this application uses."} Every role that can read ${recordPlural.toLowerCase()} can also read the names of the people they link to.`}
        />
      )}
    </StudioInspectorGroup>
  );
}
