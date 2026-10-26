/** The standard Next Node server awaits registration before ready request dispatch. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build")
    return;

  // Set before any module constructs a schema: Zod then parses with its interpreter and never
  // generates and compiles a parser for each object schema the first requests meet.
  const { z } = await import("zod");
  z.config({ jitless: true });

  const { registerCleanNetworkStartup } = await import("./app/_lib/clean-network-startup");
  registerCleanNetworkStartup();

  // Each deployment explicitly selects its single event-delivery trigger.
  const deliveryMode = process.env.VORTEX_EVENT_DELIVERY_MODE;
  if (deliveryMode !== "in_process" && deliveryMode !== "external")
    throw new Error(
      "Configure VORTEX_EVENT_DELIVERY_MODE: a local server adds VORTEX_EVENT_DELIVERY_MODE=in_process to apps/web/.env.development.local; a hosted deployment sets external",
    );
  if (deliveryMode === "external" && !process.env.VORTEX_EVENT_DISPATCHER_CREDENTIAL_SHA256)
    throw new Error("External event delivery requires a dispatcher credential digest");
  const { prepareApplicationRuntime } = await import("./app/_lib/prepare-application-runtime");
  await prepareApplicationRuntime();
  if (deliveryMode === "in_process") {
    const { startLocalEventDispatch } = await import("./app/_lib/local-event-dispatch");
    startLocalEventDispatch();
  }
}
