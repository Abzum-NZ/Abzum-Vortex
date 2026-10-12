import type { PermissionDeclaration, PlatformId } from "../schema";

type PlatformPermissionSource = Readonly<{
  ownerId: PlatformId;
  declarations: readonly PermissionDeclaration[];
  forKey: (key: string) => PermissionDeclaration | undefined;
  hasKey: (key: string) => boolean;
}>;

let source: PlatformPermissionSource | undefined;

export const installPlatformPermissionSource = (value: PlatformPermissionSource): void => {
  source = value;
};

export const platformPermissionSource = (): PlatformPermissionSource => {
  if (source === undefined) throw new Error("Platform permission source is not installed");
  return source;
};
