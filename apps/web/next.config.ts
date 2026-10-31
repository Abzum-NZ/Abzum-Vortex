import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  experimental: {
    // Pages are composed per viewer from current permissions and records. A page change without a
    // prefetch reads the page fresh (dynamic 0). A page the person pointed at, focused or touched is
    // prefetched in full and reused for up to 30 seconds (static), in this tab only; any committed
    // write empties those before the next page change (packages/ui/src/routing/prefetch.ts), and
    // signing in or out empties them because the session cookies change.
    staleTimes: { dynamic: 0, static: 30 },
  },
  transpilePackages: ["@vortex/platform", "@vortex/definitions", "@vortex/ui"],
  // The component host supplies its own framing policy on its dedicated origin.
  async headers() {
    return [
      {
        source: "/:path((?!api/components/).*)",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
      {
        source: "/:path((?!api/).*)",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
