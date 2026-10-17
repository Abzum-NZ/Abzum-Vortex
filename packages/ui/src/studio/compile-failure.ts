/** Why the saved draft would not compile. */
export type StudioCompileFailure = Readonly<{
  reasonCode: string;
  family: string;
  blockAlias?: string;
  tokenKey?: string;
}>;
