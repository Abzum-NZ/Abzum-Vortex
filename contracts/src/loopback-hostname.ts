const loopbackHostnames: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/**
 * True only for the exact local-loopback hostname spellings Vortex accepts:
 * `127.0.0.1`, `localhost`, and `[::1]` (how `URL#hostname` renders the IPv6
 * loopback literal). The comparison is exact -- no case folding beyond what
 * `URL` already applies, no configuration, and no other spellings.
 */
export const isLoopbackHostname = (hostname: string): boolean =>
  loopbackHostnames.includes(hostname);
