"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Button } from "../components/button";
import { Info } from "lucide-react";

const FieldProblemsContext = createContext<Readonly<{
  problems: readonly string[];
  report: (id: string, error: string | undefined, onUndo?: () => void) => void;
  canUndo: boolean;
  undo: () => void;
}> | null>(null);

/** Invalid text stays outside the draft, but still belongs in the workspace's save feedback. */
export function StudioFieldProblemsProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [problems, setProblems] = useState<
    Readonly<Record<string, Readonly<{ message: string; onUndo: (() => void) | undefined }>>>
  >({});
  const report = useCallback((id: string, error: string | undefined, onUndo?: () => void) => {
    setProblems((previous) => {
      if (previous[id]?.message === error && previous[id]?.onUndo === onUndo) return previous;
      const next = { ...previous };
      if (error === undefined) delete next[id];
      else next[id] = { message: error, onUndo };
      return next;
    });
  }, []);
  const undo = useCallback(() => {
    // Undo only the field shown in save feedback. Its owner clears the problem after resetting.
    Object.values(problems)[0]?.onUndo?.();
  }, [problems]);
  const value = useMemo(
    () => ({
      problems: Object.values(problems).map((problem) => problem.message),
      canUndo: Object.values(problems)[0]?.onUndo !== undefined,
      report,
      undo,
    }),
    [problems, report, undo],
  );
  return <FieldProblemsContext.Provider value={value}>{children}</FieldProblemsContext.Provider>;
}

export const useStudioFieldProblems = () => useContext(FieldProblemsContext);

/** Long help is available on focus and remains the control's accessible description. */
export function StudioHelp({ hint, id }: Readonly<{ hint: string; id?: string }>) {
  const generated = useId();
  const descriptionId = id ?? generated;
  return hint.length <= 80 ? (
    <FieldDescription id={descriptionId} className="text-sm">
      {hint}
    </FieldDescription>
  ) : (
    <>
      <span id={descriptionId} className="sr-only">
        {hint}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="More information"
              aria-describedby={descriptionId}
            />
          }
        >
          <Info className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent className="max-w-prose">{hint}</TooltipContent>
      </Tooltip>
    </>
  );
}

export function StudioField({
  label,
  hint,
  error,
  onUndo,
  optional = false,
  children,
}: Readonly<{
  label: ReactNode;
  hint?: string | undefined;
  error?: string | undefined;
  onUndo?: (() => void) | undefined;
  optional?: boolean;
  children: (
    control: Readonly<{ id: string; "aria-invalid"?: true; "aria-describedby"?: string }>,
  ) => ReactNode;
}>) {
  const id = useId();
  const report = useStudioFieldProblems()?.report;
  useEffect(() => {
    report?.(id, error === "" ? undefined : error, onUndo);
    return () => report?.(id, undefined);
  }, [id, error, onUndo, report]);
  const description = [
    hint === undefined ? undefined : id + "-hint",
    error === undefined ? undefined : id + "-error",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <div className="flex items-center gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {optional && <span className="text-xs text-muted-foreground">Optional</span>}
        {hint !== undefined && hint.length > 80 && <StudioHelp hint={hint} id={id + "-hint"} />}
      </div>
      {children({
        id,
        ...(error === undefined ? {} : { "aria-invalid": true as const }),
        ...(description === "" ? {} : { "aria-describedby": description }),
      })}
      {hint !== undefined && hint.length <= 80 && <StudioHelp hint={hint} id={id + "-hint"} />}
      {error !== undefined && <FieldError id={id + "-error"}>{error}</FieldError>}
    </Field>
  );
}
