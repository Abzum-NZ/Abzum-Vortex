"use client";

import type { ReactElement } from "react";
import { Button } from "../components/button";
import type { SubRowNotice } from "./sub-rows";

/** The notice of a level of sub-rows, in the grid and the cards alike: its message and its control. */
export function SubRowNoticeView({ notice }: Readonly<{ notice: SubRowNotice }>): ReactElement {
  return (
    <div
      role={notice.tone === "alert" ? "alert" : "status"}
      {...(notice.busy === true ? { "aria-busy": true } : {})}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      {notice.message === undefined ? null : (
        <span className="text-muted-foreground">{notice.message}</span>
      )}
      {notice.action === undefined ? null : (
        <Button
          variant="ghost"
          size="sm"
          disabled={notice.action.disabled === true}
          onClick={notice.action.run}
        >
          {notice.action.label}
        </Button>
      )}
    </div>
  );
}
