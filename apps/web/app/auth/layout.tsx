import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Account access · Vortex",
  description: "Secure account access for Vortex.",
};

export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
