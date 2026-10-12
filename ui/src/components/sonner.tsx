"use client";

import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

/**
 * The shadcn toast region. Its surface reads the theme tokens, so a toast follows the resolved
 * application theme and its light or dark scheme without a palette of its own.
 */
function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster, toast };
