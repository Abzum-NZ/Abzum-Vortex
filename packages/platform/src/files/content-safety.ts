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

const EXECUTABLE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-ms-dos-executable",
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
  "application/ecmascript",
  "text/ecmascript",
  "application/x-php",
  "text/x-php",
  "application/php",
  "application/x-httpd-php",
  "application/vnd.microsoft.portable-executable",
  "application/x-mach-binary",
  "application/x-elf",
  "application/x-msi",
  "application/x-ms-shortcut",
  "application/x-ms-application",
  "application/hta",
  "application/java-archive",
  "application/x-java-archive",
  "application/x-powershell",
  "application/x-perl",
  "text/x-perl",
  "text/x-python",
  "application/x-python-code",
  "application/x-ruby",
  "text/x-ruby",
]);

const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".dll",
  ".com",
  ".bat",
  ".cmd",
  ".sh",
  ".bash",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".js",
  ".mjs",
  ".cjs",
  ".jse",
  ".wsf",
  ".wsh",
  ".hta",
  ".lnk",
  ".scf",
  ".jar",
  ".php",
  ".py",
  ".pl",
  ".rb",
  ".bin",
  ".scr",
  ".msi",
  ".msp",
  ".cpl",
  ".msc",
  ".pif",
  ".gadget",
  ".reg",
  ".app",
]);

/**
 * Extensions whose content kind is known in advance. A detected kind that
 * disagrees with the extension's expected kind is a disguised file, so it is
 * held for review rather than accepted on the strength of its name.
 */
const EXPECTED_EXTENSION_KINDS: ReadonlyMap<string, ReadonlySet<ContentKind>> = new Map([
  [".jpg", new Set<ContentKind>(["image"])],
  [".jpeg", new Set<ContentKind>(["image"])],
  [".png", new Set<ContentKind>(["image"])],
  [".gif", new Set<ContentKind>(["image"])],
  [".webp", new Set<ContentKind>(["image"])],
  [".bmp", new Set<ContentKind>(["image"])],
  [".tif", new Set<ContentKind>(["image"])],
  [".tiff", new Set<ContentKind>(["image"])],
  [".heic", new Set<ContentKind>(["image"])],
  [".svg", new Set<ContentKind>(["image", "text"])],
  [".pdf", new Set<ContentKind>(["document"])],
  [".doc", new Set<ContentKind>(["document"])],
  [".docx", new Set<ContentKind>(["document"])],
  [".odt", new Set<ContentKind>(["document"])],
  [".rtf", new Set<ContentKind>(["document", "text"])],
  [".xls", new Set<ContentKind>(["spreadsheet"])],
  [".xlsx", new Set<ContentKind>(["spreadsheet"])],
  [".ods", new Set<ContentKind>(["spreadsheet"])],
  [".csv", new Set<ContentKind>(["spreadsheet", "text"])],
  [".tsv", new Set<ContentKind>(["spreadsheet", "text"])],
  [".ppt", new Set<ContentKind>(["presentation"])],
  [".pptx", new Set<ContentKind>(["presentation"])],
  [".odp", new Set<ContentKind>(["presentation"])],
  [".mp3", new Set<ContentKind>(["audio"])],
  [".wav", new Set<ContentKind>(["audio"])],
  [".flac", new Set<ContentKind>(["audio"])],
  [".m4a", new Set<ContentKind>(["audio"])],
  [".ogg", new Set<ContentKind>(["audio", "video"])],
  [".mp4", new Set<ContentKind>(["video"])],
  [".mov", new Set<ContentKind>(["video"])],
  [".avi", new Set<ContentKind>(["video"])],
  [".mkv", new Set<ContentKind>(["video"])],
  [".webm", new Set<ContentKind>(["audio", "video"])],
  [".zip", new Set<ContentKind>(["archive"])],
  [".tar", new Set<ContentKind>(["archive"])],
  [".gz", new Set<ContentKind>(["archive"])],
  [".7z", new Set<ContentKind>(["archive"])],
  [".rar", new Set<ContentKind>(["archive"])],
  [".txt", new Set<ContentKind>(["text"])],
  [".md", new Set<ContentKind>(["text"])],
  [".log", new Set<ContentKind>(["text"])],
  [".json", new Set<ContentKind>(["text", "other"])],
  [".xml", new Set<ContentKind>(["text", "other"])],
  [".yaml", new Set<ContentKind>(["text", "other"])],
  [".yml", new Set<ContentKind>(["text", "other"])],
]);

/**
 * The content kinds an extension is known to name, or undefined when this
 * platform does not recognise the extension.
 */
export const expectedContentKindsForExtension = (
  extension: string,
): ReadonlySet<ContentKind> | undefined =>
  EXPECTED_EXTENSION_KINDS.get(normalizeFileExtension(extension));

/** Normalises an extension to the canonical lowercase dotted form. */
export const normalizeFileExtension = (extension: string): string => {
  const trimmed = extension.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
};

/**
 * Reduces a detected media type to its bare lowercase type, so a parameter such as
 * a charset cannot hide an executable type behind a suffix.
 */
const normalizeMediaType = (detectedMediaType: string): string =>
  detectedMediaType.split(";")[0]?.trim().toLowerCase() ?? "";

/**
 * Categorises a verified detected media type into a canonical Vortex content kind.
 * Browser-supplied headers are never used as detected content.
 */
export const detectContentKind = (detectedMediaType: string): ContentKind => {
  const normalized = normalizeMediaType(detectedMediaType);

  if (EXECUTABLE_MEDIA_TYPES.has(normalized)) {
    return "other";
  }

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

  if (normalized.startsWith("text/")) {
    return "text";
  }

  return "other";
};

/**
 * Reports whether the verified media type or the extension names executable content.
 * Renaming an executable to an allowed extension does not help: the detected media
 * type is checked independently of the name.
 */
export const isExecutableContent = (detectedMediaType: string, extension: string): boolean =>
  EXECUTABLE_MEDIA_TYPES.has(normalizeMediaType(detectedMediaType)) ||
  EXECUTABLE_EXTENSIONS.has(normalizeFileExtension(extension));

/**
 * Reports whether a non-executable file's extension disagrees with its verified
 * content, which is how content disguised under a harmless name presents itself.
 * An extension this platform does not recognise is not treated as a disagreement;
 * the allowed-kind and allowed-extension settings decide those.
 */
export const isDisguisedContent = (detectedMediaType: string, extension: string): boolean => {
  const expectedKinds = EXPECTED_EXTENSION_KINDS.get(normalizeFileExtension(extension));
  if (expectedKinds === undefined) {
    return false;
  }
  return !expectedKinds.has(detectContentKind(detectedMediaType));
};

export type ContentSafetyCheckInput = Readonly<{
  detectedMediaType: string;
  extension: string;
  sizeBytes: number;
  existingAttachmentCount: number;
  allowedKinds?: readonly ContentKind[];
  allowedExtensions?: readonly string[];
  maxFileSizeMb?: number;
  multiple?: boolean;
  maxFiles?: number;
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
 * Enforces the canonical attachment settings against verified content:
 * 1. Executable content is refused, whatever the file is called.
 * 2. A file whose extension disagrees with its verified content is quarantined for review.
 * 3. The detected kind must satisfy `allowed_kinds` and the extension must satisfy
 *    `allowed_extensions`; when both are configured both must be satisfied.
 * 4. `max_file_size_mb`, `multiple` and `max_files` bound what the field accepts.
 */
export const verifyContentSafety = (
  input: ContentSafetyCheckInput,
): ContentSafetyCheckResult => {
  const detectedKind = detectContentKind(input.detectedMediaType);
  const normalizedExtension = normalizeFileExtension(input.extension);

  if (isExecutableContent(input.detectedMediaType, normalizedExtension)) {
    return {
      accepted: false,
      outcome: "refused",
      reason: "Executable content is refused by platform safety policy",
      detectedKind,
    };
  }

  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    return {
      accepted: false,
      outcome: "refused",
      reason: "Verified file size is not a usable byte count",
      detectedKind,
    };
  }

  if (!Number.isSafeInteger(input.existingAttachmentCount) || input.existingAttachmentCount < 0) {
    return {
      accepted: false,
      outcome: "refused",
      reason: "Current attachment count is not a usable file count",
      detectedKind,
    };
  }

  if (input.maxFileSizeMb !== undefined) {
    if (!Number.isFinite(input.maxFileSizeMb) || input.maxFileSizeMb <= 0) {
      return {
        accepted: false,
        outcome: "refused",
        reason: "Attachment field maximum file size is not a usable limit",
        detectedKind,
      };
    }
    const maximumBytes = Math.floor(input.maxFileSizeMb * 1024 * 1024);
    if (input.sizeBytes > maximumBytes) {
      return {
        accepted: false,
        outcome: "refused",
        reason: `File size ${input.sizeBytes} bytes exceeds the ${input.maxFileSizeMb} MB field maximum`,
        detectedKind,
      };
    }
  }

  if (input.multiple === true && input.maxFiles === undefined) {
    return {
      accepted: false,
      outcome: "refused",
      reason: "A multiple-file attachment field must declare its maximum number of files",
      detectedKind,
    };
  }

  const maximumFiles = input.multiple === true ? input.maxFiles : 1;
  if (maximumFiles !== undefined) {
    if (!Number.isSafeInteger(maximumFiles) || maximumFiles < 1) {
      return {
        accepted: false,
        outcome: "refused",
        reason: "Attachment field maximum number of files is not a usable limit",
        detectedKind,
      };
    }
    if (input.existingAttachmentCount >= maximumFiles) {
      return {
        accepted: false,
        outcome: "refused",
        reason: `Attachment field already holds its maximum of ${maximumFiles} file(s)`,
        detectedKind,
      };
    }
  }

  if (isDisguisedContent(input.detectedMediaType, normalizedExtension)) {
    return {
      accepted: false,
      outcome: "quarantined",
      reason: `Extension '${normalizedExtension}' disagrees with verified content '${input.detectedMediaType}'`,
      detectedKind,
    };
  }

  if (input.allowedKinds !== undefined && input.allowedKinds.length > 0) {
    if (!input.allowedKinds.includes(detectedKind)) {
      return {
        accepted: false,
        outcome: "quarantined",
        reason: `Detected kind '${detectedKind}' (${input.detectedMediaType}) is not an allowed kind: ${input.allowedKinds.join(", ")}`,
        detectedKind,
      };
    }
  }

  if (input.allowedExtensions !== undefined && input.allowedExtensions.length > 0) {
    const allowed = input.allowedExtensions.map(normalizeFileExtension);
    if (!allowed.includes(normalizedExtension)) {
      return {
        accepted: false,
        outcome: "quarantined",
        reason: `File extension '${normalizedExtension}' is not an allowed extension: ${allowed.join(", ")}`,
        detectedKind,
      };
    }
  }

  return { accepted: true, outcome: "clean", detectedKind };
};
