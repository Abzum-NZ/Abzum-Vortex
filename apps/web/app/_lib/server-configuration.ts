import "server-only";

export const requiredEnvironmentValue = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim().length === 0)
    throw new Error(`Missing required server configuration: ${name}`);
  return value;
};

/** The one hosted Storage destination and signing configuration for file and component reads. */
export const hostedStorageSigningConfiguration = (supabaseUrl: string, service: string) => {
  const match = /^([a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?)\.supabase\.co$/.exec(
    new URL(supabaseUrl).hostname,
  );
  if (match === null || match[1] === undefined)
    throw new Error(`${service} requires a hosted Supabase destination project`);
  const destinationProject = match[1];
  return {
    destinationProject,
    issuer: `https://${destinationProject}.supabase.co/auth/v1`,
    keyId: requiredEnvironmentValue("VORTEX_FILE_STORAGE_SIGNING_KEY_ID"),
    privateKey: requiredEnvironmentValue("VORTEX_FILE_STORAGE_SIGNING_KEY").replace(/\\n/g, "\n"),
  };
};
