import {
  platformPermissionDeclarations,
  platformPermissionFor,
  platformPermissionOwnerId,
  isPlatformPermissionKey,
} from "@vortex/modules";
import { installPlatformPermissionSource } from "@vortex/platform/server";

installPlatformPermissionSource({
  ownerId: platformPermissionOwnerId,
  declarations: platformPermissionDeclarations,
  forKey: platformPermissionFor,
  hasKey: isPlatformPermissionKey,
});

export * from "@vortex/platform/server";
