import { StudioModuleAddress, type StudioModuleAddressParams } from "../../../../_lib/module-address-redirect";

export const dynamic = "force-dynamic";

/** Opens this module's editor in the Studio of the application that uses it. */
export default function StudioModuleAddressPage({ params }: { params: StudioModuleAddressParams }) {
  return <StudioModuleAddress params={params} tool="before-save" />;
}
