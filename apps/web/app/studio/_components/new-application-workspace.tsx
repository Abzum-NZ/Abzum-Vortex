"use client";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { describeFailure } from "@vortex/platform/schema";
import { createStudioApplication } from "../actions";
import { minimumApplicationSource, type MinimumApplicationInputs } from "../_lib/minimum-application-source";
import { TechnicalDetails } from "@vortex/ui/components/technical-details";
import { StudioField } from "./studio-field";
import { conflictMessage, refusalMessage } from "./studio-refusal-messages";

const inputClass = "w-full";

export function NewApplicationWorkspace({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [inputs, setInputs] = useState<MinimumApplicationInputs>({
    key: "", name: "", description: "", moduleApplication: "", moduleKey: "",
    roleKey: "", roleName: "", homeName: "",
  });
  const [isCreating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Readonly<Partial<Record<keyof MinimumApplicationInputs, string>>>>({});
  const active = useRef(false);
  const lifetime = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    lifetime.current += 1;
    return () => { active.current = false; lifetime.current += 1; };
  }, []);

  const edit = (changes: Partial<MinimumApplicationInputs>) => {
    setInputs({ ...inputs, ...changes });
    setFieldErrors((current) => Object.fromEntries(
      Object.entries(current).filter(([name]) => !(name in changes))));
  };

  const textInput = (key: keyof MinimumApplicationInputs,
    label: string, maxLength: number, hint?: string) => <StudioField label={label} hint={hint} error={fieldErrors[key]}>
      {(control) => <Input {...control} required maxLength={maxLength} value={inputs[key]}
        disabled={isCreating} onChange={(event) => edit({ [key]: event.target.value })} />}
    </StudioField>;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    const candidate = minimumApplicationSource(inputs);
    if (candidate.kind !== "valid") { setFieldErrors(candidate.fieldErrors); setMessage(candidate.message); return; }
    setFieldErrors({});
    pending.current = true;
    const requestLifetime = lifetime.current;
    setCreating(true);
    setMessage("Creating the application…");
    try {
      const result = await createStudioApplication(organizationId, candidate.source);
      if (!active.current || requestLifetime !== lifetime.current) return;
      if (result.kind === "available") {
        // Navigate only to the writer's committed identity; the route then reads it afresh.
        router.replace(`/studio/${encodeURIComponent(result.draft.organizationId)}/${encodeURIComponent(result.draft.rootId)}`);
        setMessage("Application created. Opening it…");
      } else {
        setMessage(result.kind === "conflict"
          ? conflictMessage(result.reason, "No draft was created.")
          : result.kind === "refused"
            ? refusalMessage(result.reason, "No draft was created.")
            : "Creation could not be verified. Your inputs are preserved; try again.");
      }
    } catch (failure) {
      console.error("STUDIO_APPLICATION_CREATE_FAILED", describeFailure(failure));
      if (active.current && requestLifetime === lifetime.current)
        setMessage("Creation could not be verified. Your inputs are preserved; try again.");
    } finally {
      pending.current = false;
      if (active.current && requestLifetime === lifetime.current) setCreating(false);
    }
  };

  return <main className="mx-auto max-w-3xl space-y-6 p-6">
    <header><h1 className="text-2xl font-semibold">New application</h1>
      <p>This creates an unpublished draft with one empty home page. It does not publish or install anything.</p>
      <TechnicalDetails><p className="break-all text-sm">Organization id: {organizationId}</p></TechnicalDetails></header>
    <form onSubmit={create} className="grid gap-4" aria-busy={isCreating} noValidate>
      {textInput("key", "Technical name", 120, "Lowercase words separated by dots, for example team.workspace. It cannot be changed later.")}
      {textInput("name", "Name", 120)}
      <StudioField label="Description" error={fieldErrors.description}>
        {(control) => <Textarea {...control} className={inputClass} required maxLength={1000} value={inputs.description}
          disabled={isCreating} onChange={(event) => edit({ description: event.target.value })} />}
      </StudioField>
      <fieldset className="space-y-4 rounded-xl border bg-card text-card-foreground border-border p-4"><legend>Module this application uses</legend>
        {textInput("moduleApplication", "Technical name of the application that owns the module", 120)}
        {textInput("moduleKey", "Module technical name", 120)}
        <p className="text-sm">This records which module the application builds on. Each published version of this application records the module version it was built with.</p>
      </fieldset>
      {textInput("roleKey", "Access group technical name", 40, "Lowercase letters, digits and underscores.")}
      {textInput("roleName", "Access group name", 60)}
      {textInput("homeName", "Home page title", 60)}
      <p className="text-sm">The access group only allows people to open the home page. Who belongs to it is set separately, after the application is live.</p>
      <Button type="submit" disabled={isCreating}>Create application</Button>
      <p role="status" aria-live="polite">{message}</p>
    </form>
  </main>;
}
