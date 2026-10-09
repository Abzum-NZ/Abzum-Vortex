import "server-only";

import { Notice, type NoticeContentPart } from "@vortex/ui/components/notice";
import type { PreApplicationStatusProjection } from "../_lib/pre-application-status";

type PreApplicationStatusNoticeProps = Readonly<{
  projection: PreApplicationStatusProjection;
  retryHref: string;
}>;

const neutralNoticeContent = (retryHref: string): readonly NoticeContentPart[] => [
  { kind: "text", value: "This request could not be confirmed. " },
  { kind: "link", label: "Try again", href: retryHref },
  { kind: "text", value: " to continue." },
];

export function PreApplicationStatusNotice({
  projection,
  retryHref,
}: PreApplicationStatusNoticeProps) {
  if (projection.kind === "neutral_unavailable")
    return (
      <Notice
        severity="info"
        title="Sign-in could not be confirmed"
        content={neutralNoticeContent(retryHref)}
      />
    );

  const { notice } = projection;
  const linkIndex = notice.message.indexOf(notice.linkLabel);
  if (
    notice.code !== "identity_session_confirmation_unavailable" ||
    notice.linkBasePath !== "/auth/sign-in" ||
    linkIndex < 0 ||
    notice.message.indexOf(notice.linkLabel, linkIndex + notice.linkLabel.length) >= 0
  )
    return (
      <Notice
        severity="info"
        title="Sign-in could not be confirmed"
        content={neutralNoticeContent(retryHref)}
      />
    );

  const content: readonly NoticeContentPart[] = [
    { kind: "text", value: notice.message.slice(0, linkIndex) },
    { kind: "link", label: notice.linkLabel, href: retryHref },
    { kind: "text", value: notice.message.slice(linkIndex + notice.linkLabel.length) },
  ];

  return (
    <Notice
      severity={notice.severity}
      content={content}
    />
  );
}
