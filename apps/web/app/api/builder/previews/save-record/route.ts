import type { NextRequest } from "next/server";
import { builderPreviewSaveRecordRequestSchema } from "@vortex/contracts";
import {
  builderPreviewOperations,
  handleBuilderPreviewOperationRequest,
} from "../../../../_lib/builder-preview-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: NextRequest) =>
  handleBuilderPreviewOperationRequest(
    request,
    builderPreviewSaveRecordRequestSchema,
    builderPreviewOperations.saveRecordInPreview,
  );
