import "server-only";

export type ContentKind =
  | "image"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "audio"
  | "video"
  | "archive"
  | "text"
  | "other";

const EXECUTABLE_MEDIA_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-executable",
  "application/x-dosexec",
  "application/x-sh",
  "text/x-shellscript",
  "text/x-sh",
  "application/x-csh",
  "application/x-bat",
  "application/bat",
  "application/x-msdos-batch",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "application/x-php",
  "text/x-php",
  "application/php",
  "application/vnd.microsoft.portable-executable",
  "application/x-mach-binary",
  "application/x-elf",
]);

const EXECUTABLE_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".com",
  ".bat",
  ".cmd",
  ".sh",
  ".bash",
  ".ps1",
  ".vbs",
  ".js",
  ".mjs",
  ".php",
  ".py",
  ".bin",
  ".scr",
  ".msi",
  ".cpl",
  ".wsf",
]);

/**
 * Categorizes a verified detected MIME type into a canonical Vortex content kind.
 * Browser-supplied headers are never used as detected content.
 */
export const detectContentKind = (detectedMediaType: string): ContentKind => {
  const normalized = detectedMediaType.toLowerCase().trim();

  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }

  if (
    normalized === "text/csv" ||
    normalized === "text/tab-separated-values" ||
    normalized.includes("spreadsheet") ||
    normalized.includes("ms-excel")
  ) {
    return "spreadsheet";
  }

  if (normalized.includes("presentation") || normalized.includes("ms-powerpoint")) {
    return "presentation";
  }

  if (
    normalized === "application/pdf" ||
    normalized === "application/msword" ||
    normalized.includes("wordprocessingml") ||
    normalized === "application/rtf" ||
    normalized.includes("opendocument.text")
  ) {
    return "document";
  }

  if (
    normalized === "application/zip" ||
    normalized === "application/x-tar" ||
    normalized === "application/gzip" ||
    normalized === "application/x-gzip" ||
    normalized === "application/x-7z-compressed" ||
    normalized.includes("rar")
  ) {
    return "archive";
  }

  if (normalized.startsWith("text/") && !EXECUTECUTABLE_MEDIA_TYPES.has(normalized)) {
    return "text";
  }

  return "other";
};

/**
 * Checks whether content is executable or a disguised executable.
 * Renaming an executable to an allowed extension (e.g. evil.exe -> evil.jpg) is detected
 * through mismatch against the verified media type.
 */
export const isExecutableOrDisguisedContent = (
  detectedMediaType: string,
  extension: string,
): boolean => {
  const normMedia = detectedMediaType.toLowerCase().trim();
  const normExt = extension.toLowerCase().trim();

  if (EXECUTABLE_MEDIA_TYPES.has(normMedia)) {
    return true;
  }
  if (EXECUTABLE_EXTENSIONS.has(normExt)) {
    return true;
  }
  return false;
};

export type ContentSafetyCheckInput = Readonly<{
  detectedMediaType: string;
  extension: string;
  sizeBytes: number;
  allowedKinds?: readonly ContentKind[];
  allowedExtensions?: readonly string[];
  maxFileSizeMb?: number;
}>;

export type ContentSafetyCheckResult =
  | Readonly<{ accepted: true; outcome: "clean"; detectedKind: ContentKind }>
  | Readonly<{
      accepted: false;
      outcome: "refused" | "quarantined";
      reason: string;
      detectedKind: ContentKind;
    }>;

/**
 * Enforces canonical attachment settings:
 * 1. Executable detection: executable content disguised with safe extensions is refused immediately.
 * 2. Allowed kinds: detected MIME must map to an allowed kind.
 * 3. Allowed extensions: file extension must be in the allowlist if specified.
 * 4. Maximum size: byte count must not exceed maximum size.
 */
export const verifyContentSafety = (
  input: ContentSafetyCheckInput,
): ContentSafetyCheckResult => {
  const detectedKind = detectContentKind(input.detectedMediaType);
  const normalizedExt = input.extension.toLowerCase().trim();

  // Executable check
  if (isExecutableOrDisguisedContent(input.detectedMediaType, normalizedExt)) {
    return {
      accepted: false,
      outcome: "refused",
      reason: "Executable content or disguised executable file refused by platform safety policy",
      detectedKind,
    };
  }

  // Size limit check
  if (input.maxFileSizeMb !== undefined && input.maxFileSizeMb > 0) {
    const maxBytes = input.maxFileSizeMb * 1024 * 1024;
    if (input.sizeBytes > maxBytes) {
      return {
        accepted: false,
        outcome: "refused",
        reason: `File size ${input.sizeBytes} bytes exceeds maximum allowed ${maxBytes} bytes (${input.maxFileSizeMb} MB)`,
        detectedKind,
      };
    }
  }

  // Allowed kinds check
  if (input.allowedKinds && input.allowedKinds.length > 0) {
    if (!input.allowedKinds.includes(detectedKind)) {
      return {
        accepted: false,
        outcome: "quarantined",
        reason: `Detected kind '${detectedKind}' (${input.detectedMediaType}) is not in allowed kinds: ${input.allowedKinds.join(", ")}`,
        detectedKind,
      };
    }
  }

  // Allowed extensions check
  if (input.allowedExtensions && input.allowedExtensions.length > 0) {
    const allowed = input.allowedExtensions.map((ext) => ext.toLowerCase().trim());
    if (!allowed.includes(normalizedExt)) {
      return {
        accepted: false,
        outcome: "quarantined",
        reason: `File extension '${normalizedExt}' is not in allowed extensions: ${allowed.join(", ")}`,
        detectedKind,
      };
    }
  }

  return { accepted: true, outcome: "clean", detectedKind };
};
