/** The standard Next Node server awaits registration before ready request dispatch. */
export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build"
  )
    return;

  const { registerCleanNetworkStartup } = await import("./app/_lib/clean-network-startup");
  registerCleanNetworkStartup();

  // Without a configured wake-up credential no database webhook or Kestra tick can call the protected
  // dispatch route, so this server delivers committed events itself (local dev and local production).
  if (!process.env.VORTEX_EVENT_DISPATCHER_CREDENTIAL_SHA256) {
    const { startLocalEventDispatch } = await import("./app/_lib/local-event-dispatch");
    startLocalEventDispatch();
  }
}
