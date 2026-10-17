/** The standard Next Node server awaits registration before ready request dispatch. */
export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build"
  )
    return;

  const { registerCleanNetworkStartup } = await import("./app/_lib/clean-network-startup");
  registerCleanNetworkStartup();

  // Development servers never have a database webhook or Kestra tick, and without a configured wake-up
  // credential nothing can call the protected dispatch route (the local production demo), so in both
  // cases this server delivers committed events itself.
  if (
    process.env.NODE_ENV === "development" ||
    !process.env.VORTEX_EVENT_DISPATCHER_CREDENTIAL_SHA256
  ) {
    const { startLocalEventDispatch } = await import("./app/_lib/local-event-dispatch");
    startLocalEventDispatch();
  }
}
