import {
  isPlatformPermissionKey,
  platformPermissionDeclarations,
  platformPermissionFor,
  platformPermissionOwnerId,
} from "@vortex/definitions";
import type { PlatformPermissionSource } from "@vortex/platform/server";

/** The shipped platform permission catalogue, passed to every platform operation that needs it. */
export const platformPermissionSource: PlatformPermissionSource = {
  ownerId: platformPermissionOwnerId,
  declarations: platformPermissionDeclarations,
  forKey: platformPermissionFor,
  hasKey: isPlatformPermissionKey,
};
