import { createWebPrivateInvalidationResponse } from "../../_lib/private-invalidation-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request): Response => createWebPrivateInvalidationResponse(request);
