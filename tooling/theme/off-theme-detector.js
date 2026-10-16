/*
 * Off-theme detector: a browser-run check that every rendered element follows the active theme.
 *
 * Run it on a signed-in page (paste it into the console, or pass the file's text to Playwright's
 * `page.evaluate`). It returns `{ root, findings }` and prints the findings as a table. It lists:
 *
 * - `outside-themed-root`: an element with no themed ancestor (`[data-vortex-theme]` carrying a
 *   `data-vortex-style`), or one whose nearest themed root is the document root while the document
 *   root carries a different theme from the application surface (a portal that escaped).
 * - `document-theme`: the document root's style, radius, fonts, spacing or colours differ from the
 *   application surface's.
 * - `font-family`: a font that is none of its theme root's body, heading or mono fonts.
 * - `border-radius`: a corner radius that is none of its theme root's radius tokens.
 * - `padding`: a padding that is not on its theme root's spacing scale or a density token.
 * - `style-variant`: a shadcn component part (`cn-*` class) whose radius, padding or font differs
 *   from what the active style variant gives the same part without the extra utility classes or
 *   inline style the renderer added.
 * - `dark-mode`: a themed root where the shadcn `dark:` variant or the light-dark() colour scheme
 *   disagrees with the mode of the nearest root carrying `data-vortex-theme-mode` (or a `.dark` /
 *   `.light` class); a light root nested in a dark document must render light, and the reverse.
 *
 * It never changes the page except for probe elements it removes again at once.
 */
(() => {
  const RADIUS_FACTORS = [
    0, 0.2, 0.25, 0.4, 0.5, 0.6, 0.75, 0.8, 1, 1.2, 1.25, 1.4, 1.5, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 3,
  ];
  const DENSITY_TOKENS = [
    "--vortex-space-xs",
    "--vortex-space-sm",
    "--vortex-space-md",
    "--vortex-space-lg",
    "--vortex-control-padding-y",
    "--vortex-control-padding-x",
    "--vortex-cell-padding-y",
    "--vortex-cell-padding-x",
    "--card-spacing",
  ];
  const SKIPPED_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "LINK",
    "META",
    "TEMPLATE",
    "NOSCRIPT",
    "HEAD",
    "TITLE",
    "BR",
    "OPTION",
    "OPTGROUP",
    "SOURCE",
    "TRACK",
    "WBR",
  ]);
  /** Utility classes that override a component's radius, padding or font; stripped for the probe. */
  const OVERRIDE_CLASS =
    /^(?:p|px|py|pt|pb|pl|pr|ps|pe)-|^rounded(?:-|$)|^font-(?:sans|serif|mono|heading|\[)/;
  const TOLERANCE = 0.05;
  const MAX_PER_KIND = 40;

  const themedRootOf = (element) => element.closest("[data-vortex-theme][data-vortex-style]");
  const surface = document.querySelector("[data-vortex-application-surface]");
  const documentRoot = document.documentElement;
  const activeRoot = surface ?? documentRoot;
  const px = (value) => Number.parseFloat(value) || 0;
  const normalizeFont = (value) =>
    value
      .replace(/["']/g, "")
      .replace(/\s*,\s*/g, ",")
      .trim()
      .toLowerCase();

  const describe = (element) => {
    const parts = [];
    let current = element;
    for (let depth = 0; current !== null && current.nodeType === 1 && depth < 4; depth += 1) {
      let part = current.tagName.toLowerCase();
      if (current.id) part += `#${current.id}`;
      const slot = current.getAttribute("data-slot");
      if (slot) part += `[data-slot=${slot}]`;
      const cn = [...current.classList].filter((name) => name.startsWith("cn-")).slice(0, 2);
      if (cn.length > 0) part += `.${cn.join(".")}`;
      const label = current.getAttribute("aria-label");
      if (label && depth === 0) part += `[aria-label="${label.slice(0, 40)}"]`;
      parts.unshift(part);
      if (current.id || current.hasAttribute("data-vortex-style-root")) break;
      current = current.parentElement;
    }
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
    return text === "" ? parts.join(" > ") : `${parts.join(" > ")} "${text}"`;
  };

  /** The theme values one themed root provides, read from probes placed inside it. */
  const tokenCache = new Map();
  const tokensOf = (root) => {
    const cached = tokenCache.get(root);
    if (cached !== undefined) return cached;
    const host = root === documentRoot ? document.body : root;
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:absolute;visibility:hidden;pointer-events:none;inset:0 auto auto 0";
    host.appendChild(probe);
    const read = (declaration, property) => {
      probe.style.cssText += `;${declaration}`;
      const value = getComputedStyle(probe).getPropertyValue(property);
      return value;
    };
    const fonts = new Set(
      [
        "font-family:var(--font-sans-family)",
        "font-family:var(--font-heading-family, var(--font-sans-family))",
        "font-family:var(--font-mono-family, ui-monospace, monospace)",
        "font-family:var(--vortex-font-family)",
        "font-family:var(--vortex-heading-font-family)",
      ].map((declaration) => normalizeFont(read(declaration, "font-family"))),
    );
    const radii = new Set(
      RADIUS_FACTORS.map((factor) =>
        px(
          read(`border-top-left-radius:calc(var(--radius) * ${factor})`, "border-top-left-radius"),
        ),
      ),
    );
    // Read over 100 units so sub-pixel layout rounding does not distort one unit.
    const spacing = px(read("width:calc(var(--spacing, 0.25rem) * 100)", "width")) / 100;
    const density = DENSITY_TOKENS.map((name) =>
      px(read(`width:var(${name}, 0px)`, "width")),
    ).filter((value) => value > 0);
    const computed = getComputedStyle(root);
    const theme = {
      style: root.getAttribute("data-vortex-style"),
      radius: computed.getPropertyValue("--radius").trim(),
      sans: computed.getPropertyValue("--font-sans-family").trim(),
      heading: computed.getPropertyValue("--font-heading-family").trim(),
      primary: computed.getPropertyValue("--primary").trim(),
      background: computed.getPropertyValue("--background").trim(),
      spacing: computed.getPropertyValue("--vortex-component-spacing").trim(),
    };
    probe.remove();
    const tokens = { fonts, radii: [...radii], spacing, density, theme };
    tokenCache.set(root, tokens);
    return tokens;
  };

  /**
   * A style variant may rescale `--radius` for a part of the page (a sidebar, a menu); a corner is
   * judged against the radius tokens of the `--radius` in force on the element itself, as well as
   * the root's.
   */
  const radiusCache = new Map();
  const radiiFor = (element, tokens) => {
    const local = getComputedStyle(element).getPropertyValue("--radius").trim();
    if (local === "" || local === tokens.theme.radius) return tokens.radii;
    const cached = radiusCache.get(local);
    if (cached !== undefined) return cached;
    const probe = document.createElement("div");
    probe.style.cssText = `position:absolute;visibility:hidden;--radius:${local}`;
    document.body.appendChild(probe);
    const radii = RADIUS_FACTORS.map((factor) => {
      probe.style.borderTopLeftRadius = `calc(var(--radius) * ${factor})`;
      return px(getComputedStyle(probe).borderTopLeftRadius);
    });
    probe.remove();
    // Variant values resolved on an ancestor keep the root's radius, so both scales are valid here.
    const both = [...tokens.radii, ...radii];
    radiusCache.set(local, both);
    return both;
  };

  const findings = [];
  const counts = {};
  const report = (kind, element, detail) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (counts[kind] > MAX_PER_KIND) return;
    findings.push({ kind, element: element === null ? "" : describe(element), detail });
  };

  // The document root must carry the application's theme while an application is shown.
  const documentMatches = (() => {
    if (surface === null) return true;
    const own = tokensOf(documentRoot).theme;
    const expected = tokensOf(surface).theme;
    const differences = Object.keys(expected).filter((key) => own[key] !== expected[key]);
    for (const key of differences)
      report(
        "document-theme",
        documentRoot,
        `${key}: document "${own[key]}", application "${expected[key]}"`,
      );
    return differences.length === 0;
  })();

  const isRendered = (element, style) => {
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
    if (element === documentRoot || element === document.body) return true;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const radiusOk = (value, radii) => {
    const radius = px(value);
    if (radius === 0 || radius >= 999 || value.trim().endsWith("%")) return true;
    return radii.some((token) => Math.abs(token - radius) <= TOLERANCE);
  };
  const paddingOk = (value, tokens) => {
    const padding = px(value);
    if (padding === 0) return true;
    if (tokens.density.some((token) => Math.abs(token - padding) <= TOLERANCE)) return true;
    if (tokens.spacing <= 0) return false;
    const steps = padding / (tokens.spacing / 2);
    return Math.abs(steps - Math.round(steps)) * (tokens.spacing / 2) <= TOLERANCE;
  };
  const CORNERS = [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
  ];
  const SIDES = ["padding-top", "padding-right", "padding-bottom", "padding-left"];

  /** What the active style variant gives this component part without the renderer's overrides. */
  const variantDifferences = (element, style) => {
    const classes = [...element.classList];
    const overrides = classes.filter((name) =>
      OVERRIDE_CLASS.test(name.slice(name.lastIndexOf(":") + 1)),
    );
    const inline = element.getAttribute("style") ?? "";
    const inlineOverride = /(?:^|;)\s*(?:padding|border-radius|font-family|font)\b/.test(inline);
    if (overrides.length === 0 && !inlineOverride) return [];
    const probe = document.createElement(element.tagName);
    for (const attribute of element.attributes)
      if (
        attribute.name.startsWith("data-") ||
        attribute.name === "role" ||
        attribute.name === "type"
      )
        probe.setAttribute(attribute.name, attribute.value);
    probe.className = classes.filter((name) => !overrides.includes(name)).join(" ");
    probe.setAttribute("aria-hidden", "true");
    probe.style.visibility = "hidden";
    const parent = element.parentElement;
    if (parent === null) return [];
    parent.insertBefore(
      probe,
      element.previousElementSibling === null ? element : element.nextSibling,
    );
    const expected = getComputedStyle(probe);
    const differences = [];
    for (const property of [...CORNERS, ...SIDES, "font-family"]) {
      const actual = style.getPropertyValue(property);
      const wanted = expected.getPropertyValue(property);
      const same =
        property === "font-family"
          ? normalizeFont(actual) === normalizeFont(wanted)
          : Math.abs(px(actual) - px(wanted)) <= TOLERANCE;
      if (!same) differences.push(`${property} ${actual} (variant ${wanted})`);
    }
    probe.remove();
    return differences.length === 0
      ? []
      : [
          `${differences.join("; ")} via ${[...overrides, inlineOverride ? "inline style" : ""].filter(Boolean).join(" ")}`,
        ];
  };

  const elements = [documentRoot, document.body, ...document.body.querySelectorAll("*")];
  for (const element of elements) {
    if (SKIPPED_TAGS.has(element.tagName)) continue;
    if (element instanceof SVGElement) continue;
    if (element.closest("[data-vortex-brand-loader], [data-vortex-detector-probe], nextjs-portal"))
      continue;
    const style = getComputedStyle(element);
    if (!isRendered(element, style)) continue;
    const root = themedRootOf(element);
    if (root === null) {
      report("outside-themed-root", element, "no themed ancestor");
      continue;
    }
    if (
      root === documentRoot &&
      surface !== null &&
      !documentMatches &&
      element !== documentRoot &&
      element !== document.body
    ) {
      report(
        "outside-themed-root",
        element,
        "rendered outside the application root, under a document root with another theme",
      );
      continue;
    }
    const tokens = tokensOf(root);
    const font = normalizeFont(style.fontFamily);
    if (!tokens.fonts.has(font)) report("font-family", element, `"${style.fontFamily}"`);
    for (const corner of CORNERS) {
      const value = style.getPropertyValue(corner);
      if (px(value) !== 0 && !radiusOk(value, radiiFor(element, tokens))) {
        report("border-radius", element, `${corner} ${value}`);
        break;
      }
    }
    for (const side of SIDES) {
      const value = style.getPropertyValue(side);
      if (!paddingOk(value, tokens)) {
        report("padding", element, `${side} ${value} (spacing ${tokens.spacing}px)`);
        break;
      }
    }
    if ([...element.classList].some((name) => name.startsWith("cn-")))
      for (const difference of variantDifferences(element, style))
        report("style-variant", element, difference);
  }

  // Dark mode follows the nearest mode root. Probes in each themed and mode root read the shadcn
  // `dark:` variant (`dark:text-muted-foreground`, which the application search uses) against the
  // same colour set directly, and the light-dark() colour scheme.
  const MODE_ROOT = "[data-vortex-theme-mode], .dark, .light";
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const expectedDark = (element) => {
    const root = element.closest(MODE_ROOT);
    if (root === null) return prefersDark;
    if (root.classList.contains("dark")) return true;
    if (root.classList.contains("light")) return false;
    const mode = root.getAttribute("data-vortex-theme-mode");
    return mode === "dark" || (mode === "system" && prefersDark);
  };
  const modeRoots = new Set([
    documentRoot,
    ...document.querySelectorAll(`${MODE_ROOT}, [data-vortex-theme][data-vortex-style]`),
  ]);
  for (const root of modeRoots) {
    const host = root === documentRoot ? document.body : root;
    const probe = document.createElement("div");
    probe.className = "dark:text-muted-foreground";
    probe.style.cssText =
      "position:absolute;visibility:hidden;background-color:light-dark(rgb(0, 0, 0), rgb(255, 255, 255))";
    const reference = document.createElement("div");
    reference.style.cssText = "position:absolute;visibility:hidden;color:var(--muted-foreground)";
    host.append(probe, reference);
    const computed = getComputedStyle(probe);
    const variantDark = computed.color === getComputedStyle(reference).color;
    const schemeDark = computed.backgroundColor === "rgb(255, 255, 255)";
    const wanted = expectedDark(probe);
    probe.remove();
    reference.remove();
    if (variantDark !== wanted || schemeDark !== wanted)
      report(
        "dark-mode",
        root,
        `nearest mode root is ${wanted ? "dark" : "light"}; dark: variant ${variantDark ? "dark" : "light"}, colour scheme ${schemeDark ? "dark" : "light"}`,
      );
  }

  const active = tokensOf(activeRoot).theme;
  const result = {
    root: { surface: surface !== null, ...active },
    counts,
    findings,
  };
  console.table(findings);
  return result;
})();
