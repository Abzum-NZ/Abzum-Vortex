import "server-only";

import { headers } from "next/headers";
import { requestAddressHeader } from "../../_lib/request-address";
import { studioContinuationFromAddress } from "../../auth/_lib/sign-in-continuation";
import { continueSessionOrEnd } from "../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../auth/_lib/session-server";

/** Page-entry navigation only: save actions keep their in-place session recovery dialog. */
export const continueStudioSession = async () =>
  continueSessionOrEnd(
    await resolveIdentitySession(),
    studioContinuationFromAddress((await headers()).get(requestAddressHeader)),
  );
