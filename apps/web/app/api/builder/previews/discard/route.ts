import type { NextRequest } from "next/server";
import { builderPreviewDiscardRequestSchema } from "@vortex/contracts";
import {
  builderPreviewOperations,
  handleBuilderPreviewOperationRequest,
} from "../../../../_lib/builder-preview-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: NextRequest) =>
  handleBuilderPreviewOperationRequest(
    request,
    builderPreviewDiscardRequestSchema,
    builderPreviewOperations.discardPreviewInstallation,
  );
