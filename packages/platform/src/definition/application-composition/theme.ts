import { z } from "zod";
import { sourceProvenanceUnchanged } from "../definition-source-common";
import {
  builderKeySchema,
  fingerprintSchema,
  platformIdSchema,
  semanticVersionSchema,
} from "../../catalogue/identifiers";
import { nonNegativeFiniteSchema, positiveFiniteSchema } from "./shared";

export const themeTokenKindSchema = z.enum([
  "color_pair",
  "typography",
  "spacing",
  "corners",
  "border",
  "elevation",
  "focus",
  "asset",
  "density",
]);

const colorComponentPattern = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const hexColorPattern = /^#[0-9a-fA-F]{6}$/;
const oklchColorPattern = new RegExp(
  `^oklch\\(\\s*${colorComponentPattern}%?\\s+${colorComponentPattern}\\s+${colorComponentPattern}(?:deg)?\\s*(?:\\/\\s*${colorComponentPattern}%?)?\\s*\\)$`,
);

/** A theme colour is a six-digit hex value or an oklch() function, the two app-lightness forms. */
export const themeColorSchema = z
  .string()
  .refine((value) => hexColorPattern.test(value) || oklchColorPattern.test(value), {
    message: "Use a six-digit hex or an oklch() colour value",
  });

/**
 * Declares how a platform theme colour is used, so readability checks follow the
 * catalogue's declaration rather than token names. Only platform theme releases
 * declare roles; application and placement overrides inherit them unchanged.
 */
export const themeColorRoleSchema = z.enum(["foreground", "background"]);
export type ThemeColorRole = z.infer<typeof themeColorRoleSchema>;

export const themeTokenValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("color_pair")),
      light: sourceProvenanceUnchanged(themeColorSchema),
      dark: sourceProvenanceUnchanged(themeColorSchema),
      role: sourceProvenanceUnchanged(themeColorRoleSchema.optional()),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("typography")),
      family: sourceProvenanceUnchanged(builderKeySchema),
      sizeRem: sourceProvenanceUnchanged(positiveFiniteSchema),
      lineHeight: sourceProvenanceUnchanged(positiveFiniteSchema),
      weight: sourceProvenanceUnchanged(z.number().int().min(100).max(900)),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("spacing")),
      rem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("corners")),
      rem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("border")),
      widthRem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
      style: sourceProvenanceUnchanged(z.enum(["solid", "dashed"])),
      colorToken: sourceProvenanceUnchanged(builderKeySchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("elevation")),
      level: sourceProvenanceUnchanged(z.number().int().nonnegative()),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("focus")),
      colorToken: sourceProvenanceUnchanged(builderKeySchema),
      widthRem: sourceProvenanceUnchanged(positiveFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("asset")),
      assetId: sourceProvenanceUnchanged(platformIdSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("density")),
      value: sourceProvenanceUnchanged(z.enum(["compact", "comfortable"])),
    })
    .strict(),
]);

export const sourceThemeTokenValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("color_pair")),
      light: sourceProvenanceUnchanged(themeColorSchema),
      dark: sourceProvenanceUnchanged(themeColorSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("typography")),
      family: sourceProvenanceUnchanged(builderKeySchema),
      size_rem: sourceProvenanceUnchanged(positiveFiniteSchema),
      line_height: sourceProvenanceUnchanged(positiveFiniteSchema),
      weight: sourceProvenanceUnchanged(z.number().int().min(100).max(900)),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("spacing")),
      rem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("corners")),
      rem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("border")),
      width_rem: sourceProvenanceUnchanged(nonNegativeFiniteSchema),
      style: sourceProvenanceUnchanged(z.enum(["solid", "dashed"])),
      color_token: sourceProvenanceUnchanged(builderKeySchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("elevation")),
      level: sourceProvenanceUnchanged(z.number().int().nonnegative()),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("focus")),
      color_token: sourceProvenanceUnchanged(builderKeySchema),
      width_rem: sourceProvenanceUnchanged(positiveFiniteSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("asset")),
      asset_id: sourceProvenanceUnchanged(platformIdSchema),
    })
    .strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("density")),
      value: sourceProvenanceUnchanged(z.enum(["compact", "comfortable"])),
    })
    .strict(),
]);

export const exactPlatformThemeDependencySchema = z
  .object({
    kind: sourceProvenanceUnchanged(z.literal("platform_theme")),
    catalogueThemeId: sourceProvenanceUnchanged(platformIdSchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
    contentFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
  })
  .strict();

export const sourceExactPlatformThemeDependencySchema = z
  .object({
    kind: sourceProvenanceUnchanged(z.literal("platform_theme")),
    catalogue_theme_id: sourceProvenanceUnchanged(platformIdSchema),
    release_version: sourceProvenanceUnchanged(semanticVersionSchema),
  })
  .strict();

/** Identity pinned by shipped definitions for the platform's default theme release. */
export const DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY = Object.freeze({
  catalogueThemeId: platformIdSchema.parse("3f0a2b14-9c6d-4e58-8a71-6d2e5f4b1c09"),
  releaseVersion: semanticVersionSchema.parse("3.0.0"),
});

/**
 * One option id from the checked-in shadcn/create theme catalogue
 * (`../catalogue/catalogue/shadcn-create-theme-catalogue.json`). Option ids are
 * lowercase kebab-case, for example `default-translucent`, and are matched against the catalogue
 * exactly.
 */
export const themeCatalogueOptionIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * One catalogue option id per shadcn/create dimension. A selection is
 * strict: every dimension appears exactly once and no other key is admitted. Runtime/theme
 * resolves the selected options into the complete token set and the style id, refusing an unknown
 * id, a refused option or a missing dimension.
 *
 * The icon library names one of the shadcn/create icon libraries
 * (`../pages/shadcn-icon-libraries.ts`).
 *
 * The body and heading fonts name fonts of the shadcn/create font catalogue
 * (`../theme/shadcn-font-catalogue.ts`); the heading font may also be `inherit`, which paints
 * headings in the body font.
 */
export const applicationThemeSelectionSchema = z
  .object({
    style: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    baseColor: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    theme: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    chartColor: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    radius: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    menuColor: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    menuAccent: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    iconLibrary: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    bodyFont: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    headingFont: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
  })
  .strict();
export type ApplicationThemeSelection = z.infer<typeof applicationThemeSelectionSchema>;

/**
 * The authored form of the catalogue selection, with the snake_case keys every source document
 * uses. Compilation maps it one to one onto the canonical selection above.
 */
export const sourceApplicationThemeSelectionSchema = z
  .object({
    style: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    base_color: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    theme: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    chart_color: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    radius: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    menu_color: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    menu_accent: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    icon_library: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    body_font: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
    heading_font: sourceProvenanceUnchanged(themeCatalogueOptionIdSchema),
  })
  .strict();
export type SourceApplicationThemeSelection = z.infer<typeof sourceApplicationThemeSelectionSchema>;

/** Small authored and canonical values for the platform's current default theme selection. */
export const DEFAULT_APPLICATION_THEME_SELECTION = applicationThemeSelectionSchema.parse({
  style: "nova",
  baseColor: "neutral",
  theme: "neutral",
  chartColor: "neutral",
  radius: "default",
  menuColor: "default",
  menuAccent: "subtle",
  iconLibrary: "lucide",
  bodyFont: "inter",
  headingFont: "inherit",
});

export const DEFAULT_SOURCE_APPLICATION_THEME_SELECTION =
  sourceApplicationThemeSelectionSchema.parse({
    style: "nova",
    base_color: "neutral",
    theme: "neutral",
    chart_color: "neutral",
    radius: "default",
    menu_color: "default",
    menu_accent: "subtle",
    icon_library: "lucide",
    body_font: "inter",
    heading_font: "inherit",
  });

/** Maps an authored selection onto its canonical form. */
export const canonicalApplicationThemeSelection = (
  source: SourceApplicationThemeSelection,
): ApplicationThemeSelection => ({
  style: source.style,
  baseColor: source.base_color,
  theme: source.theme,
  chartColor: source.chart_color,
  radius: source.radius,
  menuColor: source.menu_color,
  menuAccent: source.menu_accent,
  iconLibrary: source.icon_library,
  bodyFont: source.body_font,
  headingFont: source.heading_font,
});

/**
 * Canonical  themes contain the complete resolved application token set plus the catalogue
 * selection they were materialised from. Every theme records its selection, including the icon
 * library, so a theme without one cannot be represented.
 */
export const applicationThemeSchema = z
  .object({
    base: sourceProvenanceUnchanged(exactPlatformThemeDependencySchema),
    selection: sourceProvenanceUnchanged(applicationThemeSelectionSchema),
    tokens: sourceProvenanceUnchanged(z.record(builderKeySchema, themeTokenValueSchema)),
  })
  .strict();

/**
 * Authored  themes carry the catalogue selection (its icon library included) and may omit overrides;
 * compilation resolves the selection into the full token set. A theme without a selection is
 * refused at publication, and a selection is only accepted on the catalogue's base release.
 */
export const sourceApplicationThemeSchema = z
  .object({
    base: sourceProvenanceUnchanged(sourceExactPlatformThemeDependencySchema),
    selection: sourceProvenanceUnchanged(sourceApplicationThemeSelectionSchema),
    token_overrides: sourceProvenanceUnchanged(
      z.record(builderKeySchema, sourceThemeTokenValueSchema),
    ),
  })
  .strict();

/** Complete immutable platform-theme content needed to materialise one  Application theme. */
export const platformThemeReleaseSchema = z
  .object({
    catalogueThemeId: sourceProvenanceUnchanged(platformIdSchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
    contentFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    tokens: sourceProvenanceUnchanged(z.record(builderKeySchema, themeTokenValueSchema)),
  })
  .strict();

/**
 * The token-role vocabulary shared by the platform theme release, the readability checks and
 * the renderer. Each entry names one role and the token kind a complete platform theme release
 * must map it with; a colour role also declares the foreground/background role the release must
 * mark that pair with, and a colour role that declares none stays unmarked (fills such as
 * `primary` are judged through their paired foreground). Defining the roles once here keeps
 * those three consumers from drifting into separate token conventions. A platform theme release
 * is complete only when it maps every role below; application and placement overrides inherit
 * the kind and declared colour role.
 */
export const platformThemeTokenRoleSchema = z
  .object({
    key: sourceProvenanceUnchanged(builderKeySchema),
    kind: sourceProvenanceUnchanged(themeTokenKindSchema),
    colorRole: sourceProvenanceUnchanged(themeColorRoleSchema.optional()),
  })
  .strict();
export type PlatformThemeTokenRole = z.infer<typeof platformThemeTokenRoleSchema>;

export const platformThemeTokenRoles = [
  { key: "background", kind: "color_pair", colorRole: "background" },
  { key: "surface", kind: "color_pair", colorRole: "background" },
  { key: "text", kind: "color_pair", colorRole: "foreground" },
  { key: "muted_text", kind: "color_pair", colorRole: "foreground" },
  { key: "border_color", kind: "color_pair" },
  { key: "border", kind: "border" },
  { key: "primary", kind: "color_pair" },
  { key: "primary_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "secondary", kind: "color_pair" },
  { key: "secondary_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "danger", kind: "color_pair" },
  { key: "danger_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "danger_text", kind: "color_pair", colorRole: "foreground" },
  { key: "warning_text", kind: "color_pair", colorRole: "foreground" },
  { key: "info_text", kind: "color_pair", colorRole: "foreground" },
  // The shadcn CSS variables the shared components read. Each card, popover, accent and sidebar
  // surface carries its own foreground role, so the readability checks judge each painted pair.
  { key: "card", kind: "color_pair", colorRole: "background" },
  { key: "card_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "popover", kind: "color_pair", colorRole: "background" },
  { key: "popover_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "muted", kind: "color_pair", colorRole: "background" },
  { key: "accent", kind: "color_pair", colorRole: "background" },
  { key: "accent_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "input", kind: "color_pair" },
  { key: "ring", kind: "color_pair" },
  { key: "chart_1", kind: "color_pair" },
  { key: "chart_2", kind: "color_pair" },
  { key: "chart_3", kind: "color_pair" },
  { key: "chart_4", kind: "color_pair" },
  { key: "chart_5", kind: "color_pair" },
  { key: "sidebar", kind: "color_pair", colorRole: "background" },
  { key: "sidebar_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "sidebar_primary", kind: "color_pair" },
  { key: "sidebar_primary_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "sidebar_accent", kind: "color_pair" },
  { key: "sidebar_accent_foreground", kind: "color_pair", colorRole: "foreground" },
  { key: "sidebar_border", kind: "color_pair" },
  { key: "sidebar_ring", kind: "color_pair" },
  { key: "focus", kind: "focus" },
  { key: "body", kind: "typography" },
  { key: "heading", kind: "typography" },
  { key: "space_xs", kind: "spacing" },
  { key: "space_sm", kind: "spacing" },
  { key: "space_md", kind: "spacing" },
  { key: "space_lg", kind: "spacing" },
  { key: "radius_sm", kind: "corners" },
  { key: "radius_md", kind: "corners" },
  { key: "radius_lg", kind: "corners" },
  { key: "radius_base", kind: "corners" },
  { key: "elevation_low", kind: "elevation" },
  { key: "elevation_high", kind: "elevation" },
  { key: "density", kind: "density" },
] as const satisfies readonly PlatformThemeTokenRole[];

/** Every token-role key a complete platform theme release must map. */
export type PlatformThemeTokenRoleKey = (typeof platformThemeTokenRoles)[number]["key"];

export type PlatformThemeRelease = z.infer<typeof platformThemeReleaseSchema>;
