import type { NextRequest } from "next/server";
import { builderPreviewCreateRequestSchema } from "@vortex/contracts";
import {
  builderPreviewOperations,
  handleBuilderPreviewOperationRequest,
} from "../../../../_lib/builder-preview-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: NextRequest) =>
  handleBuilderPreviewOperationRequest(
    request,
    builderPreviewCreateRequestSchema,
    builderPreviewOperations.createPreviewInstallation,
  );
