import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  experimental: {
    // Pages are composed per viewer from current permissions and records, so the client router
    // never reuses a dynamic page it fetched earlier: every navigation reads the page fresh. This
    // is Next's default, stated here because hover prefetch and navigation rely on it.
    staleTimes: { dynamic: 0 },
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
