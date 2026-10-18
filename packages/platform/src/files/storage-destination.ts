import "server-only";

import { isLoopbackHostname } from "../schema";

/** Trusted server configuration, never a destination selected by an HTTP request. */
export type FileStorageDestination = Readonly<{
  environment: "local" | "testing" | "production";
  supabaseUrl: string;
}>;

/** Keep local transport behind the same explicit environment gate as Identity and Database. */
export const resolveFileStorageDestination = (configuration: FileStorageDestination) => {
  const destination = new URL(configuration.supabaseUrl);
  if (
    destination.username !== "" ||
    destination.password !== "" ||
    destination.pathname !== "/" ||
    destination.search !== "" ||
    destination.hash !== ""
  )
    throw new Error("FILE_STORAGE_DESTINATION_INVALID");
  if (configuration.environment === "local") {
    if (
      destination.protocol !== "http:" ||
      !isLoopbackHostname(destination.hostname) ||
      destination.port === ""
    )
      throw new Error("FILE_STORAGE_LOCAL_DESTINATION_INVALID");
    return {
      origin: destination.origin,
      destinationProject: "local",
      issuer: `${destination.origin}/auth/v1`,
    };
  }
  const match = /^([a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?)\.supabase\.co$/.exec(
    destination.hostname,
  );
  if (
    (configuration.environment !== "testing" && configuration.environment !== "production") ||
    destination.protocol !== "https:" ||
    destination.port !== "" ||
    match?.[1] === undefined
  )
    throw new Error("FILE_STORAGE_HOSTED_DESTINATION_INVALID");
  return {
    origin: destination.origin,
    destinationProject: match[1],
    issuer: `${destination.origin}/auth/v1`,
  };
};
