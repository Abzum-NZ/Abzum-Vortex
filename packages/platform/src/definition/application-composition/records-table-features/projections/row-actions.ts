import { z } from "zod";
import { namedActionAvailabilitySchema } from "../../../../pages/named-action-availability-schema";
import { recordsTableActionCapabilities, recordsTableRowActionIcons } from "../row-actions";

const textSchema = z.string().min(1);
const rowActionSchema = z
  .object({
    eventId: textSchema,
    label: textSchema,
    icon: z.enum(recordsTableRowActionIcons),
    placement: z.enum(["inline", "menu"]),
    capability: z.enum(recordsTableActionCapabilities).optional(),
  })
  .strict()
  .readonly();

export const rowActionsProjectionSchema = z
  .object({
    actions: z
      .array(rowActionSchema)
      .min(1)
      .max(20)
      .refine(
        (actions) => new Set(actions.map((action) => action.eventId)).size === actions.length,
        "Each row action is named once",
      )
      .readonly(),
    availability: namedActionAvailabilitySchema,
  })
  .strict()
  .readonly();
