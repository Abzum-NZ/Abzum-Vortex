import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  typescript: {
    tsconfigPath: "tsconfig.build.json",
  },
  transpilePackages: [
    "@vortex/contracts",
    "@vortex/modules",
    "@vortex/ui",
    "@vortex/access",
    "@vortex/app",
    "@vortex/definition",
    "@vortex/event",
    "@vortex/file",
    "@vortex/identity",
    "@vortex/module",
    "@vortex/page",
    "@vortex/query",
    "@vortex/record",
    "@vortex/workflow",
  ],
  // No other origin may frame a Vortex page or response (clickjacking); same-origin framing stays
  // allowed. The component host under /api/components/ is excluded: it answers on the dedicated
  // component origin, and its bootstrap document already names the site origin as its only frame
  // ancestor. Next keeps a header configured here over the same header a route sets, so the
  // Content-Security-Policy form is applied to pages only: API routes such as the private file read
  // set their own policy, which must not be replaced, and X-Frame-Options covers them.
  async headers() {
    return [
      {
        source: "/:path((?!api/components/).*)",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
      {
        source: "/:path((?!api/).*)",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }],
      },
    ];
  },
};

export default nextConfig;
