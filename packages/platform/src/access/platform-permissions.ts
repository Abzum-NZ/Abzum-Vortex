import type { PlatformId } from "../catalogue/identifiers";
import type { PermissionDeclaration } from "./permissions";

/** The shipped platform permission catalogue, passed explicitly by the composition root. */
export type PlatformPermissionSource = Readonly<{
  ownerId: PlatformId;
  declarations: readonly PermissionDeclaration[];
  forKey: (key: string) => PermissionDeclaration | undefined;
  hasKey: (key: string) => boolean;
}>;
