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

  const { prepareApplicationRuntime } = await import("./app/_lib/prepare-application-runtime");
  await prepareApplicationRuntime();
  const { registerCommittedTransactionListener } = await import("@vortex/platform/server");
  const { scheduleCommittedEventDispatch } = await import("./app/_lib/event-dispatch-after");
  registerCommittedTransactionListener(scheduleCommittedEventDispatch);
}
