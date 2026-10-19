"use client";
import { Button } from "../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { Copy } from "lucide-react";
import { toast } from "sonner";

export function StudioCopyButton({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).catch((cause: unknown) => {
          console.error("[studio] could not copy details", cause);
          toast.error("Could not copy. Select the text and copy it.");
        });
      }}
    >
      <Copy />
    </Button>
  );
}

export type StudioInspectorAction = Readonly<{
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onSelect: () => void;
}>;

export function StudioInspectorActions({
  actions,
}: Readonly<{ actions: readonly StudioInspectorAction[] }>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="ghost" size="icon-sm" aria-label="More" />}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {actions.map((action, index) => (
          <span key={action.label}>
            {action.destructive && index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              disabled={action.disabled}
              variant={action.destructive ? "destructive" : "default"}
              onClick={action.onSelect}
            >
              {action.label}
            </DropdownMenuItem>
          </span>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
