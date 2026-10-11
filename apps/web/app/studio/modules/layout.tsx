import type { ReactNode } from "react";
import { ModuleQueryNavigation } from "../_components/module-query-navigation";

export default function StudioModulesLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <>
      {children}
      <ModuleQueryNavigation />
    </>
  );
}
