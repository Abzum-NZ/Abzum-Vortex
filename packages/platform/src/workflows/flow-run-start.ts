type SegmentShape = Readonly<{
  kind: string;
  finalOutputTypes?: Readonly<Record<string, unknown>>;
}>;

/** Completion outputs need a run record only when another server segment can precede them. */
export const flowNeedsRunStart = (segments: readonly SegmentShape[]): boolean => {
  const isCompletion = (segment: SegmentShape) =>
    segment.kind === "server" &&
    segment.finalOutputTypes !== undefined &&
    Object.keys(segment.finalOutputTypes).length > 0;
  return (
    segments.some(isCompletion) &&
    segments.some((segment) => segment.kind === "server" && !isCompletion(segment))
  );
};
