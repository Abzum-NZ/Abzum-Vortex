"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@vortex/ui/components/button";

type Props = Readonly<{ applicationPath: string; manifestUrl: string; snapshot: string; validUntil: string }>;
type State = "loading" | "available" | "unavailable" | "temporarily_unavailable";
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validManifest = (value: unknown, path: string): boolean => {
  if (!record(value) || !exactKeys(value, ["id", "name", "short_name", "start_url", "scope", "icons",
      "background_color", "theme_color", "display", "lang", "dir"]) ||
      value.id !== path || value.scope !== `${path}/` || value.start_url !== `${path}/_install` ||
      typeof value.name !== "string" || value.name.length < 1 || value.name.length > 120 ||
      value.short_name !== value.name || value.display !== "standalone" || value.lang !== "en" ||
      value.dir !== "ltr" || typeof value.background_color !== "string" ||
      typeof value.theme_color !== "string" || !Array.isArray(value.icons) || value.icons.length !== 1)
    return false;
  const icon: unknown = value.icons[0];
  return record(icon) && exactKeys(icon, ["src", "type", "sizes", "purpose"]) &&
    typeof icon.src === "string" && icon.src.startsWith("data:image/svg+xml,") && icon.src.length <= 100_000 &&
    icon.type === "image/svg+xml" && icon.sizes === "any" && icon.purpose === "any";
};

export function ApplicationInstallGuidance(props: Props) {
  const pathname = usePathname();
  const id = useId();
  const [state, setState] = useState<State>("loading");
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const ownedLink = useRef<HTMLLinkElement | null>(null);
  const removeOwnLink = useCallback(() => { ownedLink.current?.remove(); ownedLink.current = null; }, []);
  const pathMatches = pathname === props.applicationPath || pathname.startsWith(`${props.applicationPath}/`);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    removeOwnLink();
    setState("loading");
    const active = () => !controller.signal.aborted && generation.current === current && pathMatches;
    if (!pathMatches || !/^sha256:[a-f0-9]{64}$/.test(props.snapshot) ||
        !Number.isFinite(Date.parse(props.validUntil))) {
      setState("unavailable");
      return () => { controller.abort(); ++generation.current; removeOwnLink(); };
    }
    const requestTimer = setTimeout(() => {
      if (active()) { removeOwnLink(); setState("temporarily_unavailable"); controller.abort(); }
    }, 15_000);
    void (async () => {
      try {
        const response = await fetch(props.manifestUrl, { credentials: "same-origin", cache: "no-store",
          signal: controller.signal, redirect: "error" });
        if (!active()) return;
        if (!response.ok) { setState(response.status === 503 ? "temporarily_unavailable" : "unavailable"); return; }
        const validUntil = Date.parse(response.headers.get("X-Vortex-Install-Valid-Until") ?? "");
        const text = await response.text();
        if (!active()) return;
        const remaining = validUntil - Date.now();
        if (!Number.isFinite(validUntil) || remaining <= 0 || remaining > 15_000 || text.length > 200_000 ||
            response.headers.get("X-Vortex-Install-Snapshot") !== props.snapshot ||
            !response.headers.get("Content-Type")?.startsWith("application/manifest+json") ||
            !validManifest(JSON.parse(text), props.applicationPath)) { setState("unavailable"); return; }
        if (!active() || Date.now() >= validUntil) { setState("unavailable"); return; }
        // A document has one manifest owner; never mutate a different component's link.
        if (document.head.querySelector('link[rel="manifest"]') !== null) { setState("unavailable"); return; }
        const link = document.createElement("link");
        link.rel = "manifest";
        link.crossOrigin = "use-credentials";
        link.href = props.manifestUrl;
        ownedLink.current = link;
        document.head.appendChild(link);
        clearTimeout(requestTimer);
        setState("available");
        expiryTimer = setTimeout(() => {
          if (active()) { removeOwnLink(); setState("unavailable"); }
        }, Math.max(0, validUntil - Date.now()));
      } catch {
        if (active()) { removeOwnLink(); setState("temporarily_unavailable"); }
      } finally { clearTimeout(requestTimer); }
    })();
    const visible = () => { if (document.visibilityState === "visible") setReload((value) => value + 1); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort(); ++generation.current;
      clearTimeout(requestTimer);
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
      document.removeEventListener("visibilitychange", visible);
      removeOwnLink();
    };
  }, [pathname, pathMatches, props.applicationPath, props.manifestUrl, props.snapshot, props.validUntil,
    reload, removeOwnLink]);

  return <aside aria-label="Application installation" className="border-b px-4 py-2 text-sm">
    <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={id} onClick={() => {
      setOpen((value) => !value); if (!open) setReload((value) => value + 1);
    }}>Install this application</Button>
    <div id={id} hidden={!open}>
      <p role="status" aria-live="polite">{state === "loading" ? "Checking installation availability…" :
        state === "available" ? "Use your browser's Install or Add to Home Screen option if available." :
        state === "temporarily_unavailable" ? "Installation guidance is temporarily unavailable." :
        "Installation guidance is unavailable. Refresh this page to check the current application."}</p>
      <p>Installation uses your existing Vortex sign-in. It does not store private records for offline use.</p>
      {state === "temporarily_unavailable" && <Button type="button" variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>
        Try again</Button>}
    </div>
  </aside>;
}
