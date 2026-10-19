"use client";

import { useState } from "react";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import {
  applyStudioFieldPlacements,
  studioFieldPlacements,
  type StudioCompositionContext,
  type StudioFieldPlacement,
} from "@vortex/ui/studio";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

type Field = Readonly<{
  moduleKey: string;
  recordKey: string;
  key: string;
  label: string;
  type: string;
}>;

function FieldOffer({
  field,
  places,
  context,
  disabled,
  edit,
}: Readonly<{
  field: Field;
  places: readonly StudioFieldPlacement[];
  context: StudioCompositionContext;
  disabled: boolean;
  edit: StudioDataEdit;
}>) {
  const [problem, setProblem] = useState<string>();
  const add = () => {
    const result = edit(
      (source) => {
        const placed = applyStudioFieldPlacements(
          { ...context, source },
          field,
          places.filter((place) => place.unavailable === undefined).map((place) => place.id),
        );
        return placed.kind === "applied"
          ? { kind: "changed", source: placed.source }
          : { kind: "invalid", issues: placed.reasons };
      },
      { expected: context.source },
    );
    setProblem(studioEditProblem(result));
  };
  return (
    <li className="space-y-2 py-3">
      <p className="font-medium">{field.label}</p>
      <p className="text-muted-foreground">Not included in:</p>
      <ul className="space-y-1">
        {places.map((place) => (
          <li key={place.id}>
            {place.label}
            {place.unavailable === undefined ? null : ` (${place.unavailable})`}
          </li>
        ))}
      </ul>
      {places.some((place) => place.unavailable === undefined) && (
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={add}>
          <Icon name="plus" />
          Add {field.label} to these pages
        </Button>
      )}
      {problem === undefined ? null : (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      )}
    </li>
  );
}

/** Generated pages are authored content: offer explicit placements for this release's new fields. */
export function StudioFieldPageReview({
  addedFields,
  context,
  disabled,
  edit,
}: Readonly<{
  addedFields: readonly string[];
  context: StudioCompositionContext;
  disabled: boolean;
  edit: StudioDataEdit;
}>) {
  const added = new Set(addedFields);
  const offers = context.source.body.modules.flatMap((module) =>
    module.record_types.flatMap((record) =>
      record.fields.flatMap((field) => {
        const reference = `${module.key}:${record.key}.${field.key}`;
        if (!added.has(reference)) return [];
        const places = studioFieldPlacements(
          context,
          module.key,
          record.key,
          field.type,
          field.key,
        ).filter((place) => place.shown !== true);
        return places.length === 0
          ? []
          : [
              {
                reference,
                field: {
                  moduleKey: module.key,
                  recordKey: record.key,
                  key: field.key,
                  label: field.label,
                  type: field.type,
                },
                places,
              },
            ];
      }),
    ),
  );
  if (offers.length === 0) return null;
  return (
    <section aria-label="New fields on pages" className="space-y-2 text-sm">
      <h3 className="flex items-center gap-2 font-semibold">
        <Icon name="info" className="size-4" />
        New fields are missing from pages
      </h3>
      <p className="text-muted-foreground">
        Pages keep the fields you chose when you made them. Adding a field does not update them. Add
        it here, or publish with these pages as they are.
      </p>
      <ul className="space-y-2">
        {offers.map((offer) => (
          <FieldOffer
            key={offer.reference}
            {...offer}
            context={context}
            disabled={disabled}
            edit={edit}
          />
        ))}
      </ul>
    </section>
  );
}
