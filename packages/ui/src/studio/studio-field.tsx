"use client";
import {
  Fragment,
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
  report: (id: string, error: string | undefined) => void;
  undo: () => void;
}> | null>(null);

/** Invalid text stays outside the draft, but still belongs in the workspace's save feedback. */
export function StudioFieldProblemsProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  const [generation, setGeneration] = useState(0);
  const report = useCallback((id: string, error: string | undefined) => {
    setProblems((previous) => {
      if (previous[id] === error) return previous;
      const next = { ...previous };
      if (error === undefined) delete next[id];
      else next[id] = error;
      return next;
    });
  }, []);
  const undo = useCallback(() => {
    setProblems({});
    // Remount the form controls from the unchanged draft, preserving the owning draft history.
    setGeneration((previous) => previous + 1);
  }, []);
  const value = useMemo(
    () => ({ problems: Object.values(problems), report, undo }),
    [problems, report, undo],
  );
  return (
    <FieldProblemsContext.Provider value={value}>
      <Fragment key={generation}>{children}</Fragment>
    </FieldProblemsContext.Provider>
  );
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
  optional = false,
  children,
}: Readonly<{
  label: ReactNode;
  hint?: string | undefined;
  error?: string | undefined;
  optional?: boolean;
  children: (
    control: Readonly<{ id: string; "aria-invalid"?: true; "aria-describedby"?: string }>,
  ) => ReactNode;
}>) {
  const id = useId();
  const report = useStudioFieldProblems()?.report;
  useEffect(() => {
    report?.(id, error === "" ? undefined : error);
    return () => report?.(id, undefined);
  }, [id, error, report]);
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
