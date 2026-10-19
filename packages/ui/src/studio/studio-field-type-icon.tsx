"use client";
import type { ModuleFieldType } from "@vortex/platform/schema";
import {
  Type,
  AlignLeft,
  TextQuote,
  Hash,
  DecimalsArrowRight,
  Banknote,
  ToggleLeft,
  Calendar,
  CalendarClock,
  ListFilter,
  ListChecks,
  ListOrdered,
  Mail,
  Phone,
  Globe,
  Table2,
  Link,
  GitBranch,
  Calculator,
  Sigma,
  Paperclip,
  type LucideIcon,
} from "lucide-react";

const fieldIcons: Readonly<Record<ModuleFieldType, LucideIcon>> = {
  text: Type,
  long_text: AlignLeft,
  formatted_text: TextQuote,
  whole_number: Hash,
  decimal_number: DecimalsArrowRight,
  money: Banknote,
  yes_no: ToggleLeft,
  date: Calendar,
  date_time: CalendarClock,
  choice: ListFilter,
  several_choices: ListChecks,
  reference_number: ListOrdered,
  email_address: Mail,
  phone_number: Phone,
  web_address: Globe,
  table: Table2,
  link: Link,
  link_to_one_of_several: GitBranch,
  calculation: Calculator,
  total: Sigma,
  attachment: Paperclip,
};

/** Studio's field catalogue has a distinct glyph for every type, beside its readable name. */
export function StudioFieldTypeIcon({ type }: Readonly<{ type: string }>) {
  if (!Object.hasOwn(fieldIcons, type)) throw new Error(`Unknown Studio field type: ${type}`);
  const Glyph = fieldIcons[type as ModuleFieldType];
  return <Glyph aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
}
