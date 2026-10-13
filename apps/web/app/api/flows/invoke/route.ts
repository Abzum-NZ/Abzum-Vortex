import { createFlowInvocationHandler } from "./flow-invocation-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createFlowInvocationHandler("web");
