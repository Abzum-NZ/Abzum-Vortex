import { applicationInstallAddressSchema } from "@vortex/platform/server";
import { notFound } from "next/navigation";
import ApplicationAddressPage from "../[[...pageAddress]]/page";

export const dynamic = "force-dynamic";
type Props = Readonly<{ params: Promise<{ tenantShortName: string;
  organizationShortName: string; applicationKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>> }>;

/** The current Page owns exact-home redirection and ordinary sign-in; no duplicate guide mounts. */
export default async function ApplicationInstallLaunch({ params, searchParams }: Props) {
  const route = await params;
  const address = applicationInstallAddressSchema.safeParse(route);
  if (!address.success) notFound();
  return <ApplicationAddressPage params={Promise.resolve({ tenantShortName: address.data.tenantShortName,
    organizationShortName: address.data.organizationShortName,
    applicationKey: address.data.applicationKey })} searchParams={searchParams} />;
}
