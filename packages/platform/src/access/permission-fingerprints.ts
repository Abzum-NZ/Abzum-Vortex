import "server-only";

import type { PermissionDeclaration } from "../schema";
import { fingerprintCanonicalValue } from "../definition/definition-index";

/** Fingerprints authority-bearing meaning, excluding display-only metadata. */
export const fingerprintPermissionMeaning = (
  ownerKind: "platform" | "application" | "module",
  ownerId: string,
  permission: PermissionDeclaration,
) =>
  fingerprintCanonicalValue({
    ownerKind,
    ownerId,
    permissionId: permission.permissionId,
    key: permission.key,
    recordTypeId: permission.recordTypeId ?? null,
    actionKind: permission.actionKind,
    namedAction: permission.namedAction ?? null,
    administrative: permission.administrative,
    ...(permission.recordScope === undefined ? {} : { recordScope: permission.recordScope }),
    ...(permission.fieldPolicy === undefined ? {} : { fieldPolicy: permission.fieldPolicy }),
  });
