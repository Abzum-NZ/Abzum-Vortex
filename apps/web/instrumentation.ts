/** The standard Next Node server awaits registration before ready request dispatch. */
export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build"
  )
    return;

  const { registerCleanNetworkStartup } = await import("./app/_lib/clean-network-startup");
  registerCleanNetworkStartup();
}
