import "server-only";

import type { CookieOptions } from "@supabase/ssr";

export const sessionCookieChunkSize = 3_180;
export const sessionCookieMaximumChunks = 8;
export const sessionCookieMaximumBytes = sessionCookieChunkSize * sessionCookieMaximumChunks;

export type SessionCookie = Readonly<{ name: string; value: string }>;
export type SessionCookieMutation = Readonly<{
  name: string;
  value: string;
  options: CookieOptions;
}>;
export type SessionCookieHeaders = Readonly<Record<string, string>>;

export type SessionCookieProfile = Readonly<{
  name: "__Host-vortex-session" | "vortex-local-session";
  secure: boolean;
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  priority: "high";
}>;

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

export const identitySessionCookieProfile = (siteUrl: string): SessionCookieProfile => {
  const url = new URL(siteUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const localHttp = url.protocol === "http:" && loopback;
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid identity-session site URL");

  return Object.freeze({
    name: localHttp ? "vortex-local-session" : "__Host-vortex-session",
    secure: !localHttp,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    priority: "high",
  });
};

const cookieIndex = (name: string, profile: SessionCookieProfile): number | undefined => {
  if (!name.startsWith(`${profile.name}.`)) return undefined;
  const suffix = name.slice(profile.name.length + 1);
  if (!/^(0|[1-9][0-9]*)$/u.test(suffix)) return Number.NaN;
  return Number(suffix);
};

export const inspectIdentitySessionCookies = (
  cookies: readonly SessionCookie[],
  profile: SessionCookieProfile,
): Readonly<{ kind: "missing" | "valid" | "invalid"; cookies: readonly SessionCookie[] }> => {
  const relevant = cookies.filter(
    ({ name }) => name === profile.name || name.startsWith(`${profile.name}.`),
  );
  if (relevant.length === 0) return { kind: "missing", cookies: [] };

  const names = new Set<string>();
  if (relevant.some(({ name, value }) => names.has(name) || (names.add(name), value.length === 0)))
    return { kind: "invalid", cookies: [] };

  const base = relevant.find(({ name }) => name === profile.name);
  const chunks = relevant.filter(({ name }) => name !== profile.name);
  if (base && chunks.length > 0) return { kind: "invalid", cookies: [] };
  if (base)
    return utf8Length(base.value) <= sessionCookieChunkSize
      ? { kind: "valid", cookies: [base] }
      : { kind: "invalid", cookies: [] };

  const indexed = chunks.map((cookie) => ({ cookie, index: cookieIndex(cookie.name, profile) }));
  if (
    indexed.some(
      ({ cookie, index }) =>
        index === undefined ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= sessionCookieMaximumChunks ||
        utf8Length(cookie.value) > sessionCookieChunkSize,
    )
  )
    return { kind: "invalid", cookies: [] };

  indexed.sort((left, right) => left.index! - right.index!);
  if (indexed.some(({ index }, expected) => index !== expected))
    return { kind: "invalid", cookies: [] };
  if (
    indexed.reduce((total, { cookie }) => total + utf8Length(cookie.value), 0) >
    sessionCookieMaximumBytes
  )
    return { kind: "invalid", cookies: [] };
  return { kind: "valid", cookies: indexed.map(({ cookie }) => cookie) };
};

export const sessionCookieOptions = (
  profile: SessionCookieProfile,
  supplied: CookieOptions = {},
): CookieOptions => {
  const allowed = { ...supplied };
  delete allowed.domain;
  return {
    ...allowed,
    path: profile.path,
    secure: profile.secure,
    httpOnly: profile.httpOnly,
    sameSite: profile.sameSite,
    priority: profile.priority,
  };
};

export const identitySessionCookieDeletions = (
  profile: SessionCookieProfile,
): readonly SessionCookieMutation[] =>
  [
    profile.name,
    ...Array.from({ length: sessionCookieMaximumChunks }, (_, i) => `${profile.name}.${i}`),
  ].map((name) => ({
    name,
    value: "",
    options: sessionCookieOptions(profile, { maxAge: 0 }),
  }));

export const createSessionCookieStage = (
  initialCookies: readonly SessionCookie[],
  profile: SessionCookieProfile,
) => {
  const initialState = inspectIdentitySessionCookies(initialCookies, profile);
  let mutations: readonly SessionCookieMutation[] = [];
  let headers: SessionCookieHeaders = {};
  let refused = false;

  return Object.freeze({
    initialState,
    getAll: () => (initialState.kind === "invalid" ? [] : [...initialCookies]),
    setAll: (next: readonly SessionCookieMutation[], nextHeaders: SessionCookieHeaders = {}) => {
      const relevant = next.filter(
        ({ name }) => name === profile.name || name.startsWith(`${profile.name}.`),
      );
      const candidate = relevant.filter(
        ({ value, options }) => value.length > 0 && options.maxAge !== 0,
      );
      if (
        relevant.length !== next.length ||
        inspectIdentitySessionCookies(candidate, profile).kind === "invalid"
      ) {
        refused = true;
        mutations = [];
        headers = {};
        return;
      }
      mutations = relevant.map((mutation) => ({
        ...mutation,
        options: sessionCookieOptions(profile, mutation.options),
      }));
      headers = { ...nextHeaders };
    },
    snapshot: () => Object.freeze({ refused, mutations, headers }),
  });
};
