import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  transpilePackages: [
    "@vortex/contracts",
    "@vortex/modules",
    "@vortex/ui",
    "@vortex/access",
    "@vortex/app",
    "@vortex/connection",
    "@vortex/definition",
    "@vortex/event",
    "@vortex/file",
    "@vortex/identity",
    "@vortex/interface",
    "@vortex/module",
    "@vortex/page",
    "@vortex/query",
    "@vortex/record",
    "@vortex/rule",
    "@vortex/search",
    "@vortex/theme",
    "@vortex/workflow",
  ],
};

export default nextConfig;
