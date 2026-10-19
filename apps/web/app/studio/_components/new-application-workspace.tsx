"use client";
import { Button } from "@vortex/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vortex/ui/components/collapsible";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { describeFailure, type ImmutablePlatformBlockCatalogue } from "@vortex/platform/schema";
import { createStudioApplication } from "../actions";
import {
  applicationKeyFromName,
  minimumApplicationSource,
  type MinimumApplicationInputs,
} from "../_lib/minimum-application-source";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@vortex/ui/components/card";
import { StudioField } from "./studio-field";
import { conflictMessage, refusalMessage } from "./studio-refusal-messages";

const inputClass = "w-full";

/**
 * The new application form: a name and a description. The key is made from the name (it can be
 * set under Advanced); the home page, who can open it and the application's own empty Module are
 * made with it, and it starts in a layout with the application menu.
 */
export function NewApplicationWorkspace({
  organizationId,
  catalogue,
}: Readonly<{
  organizationId: string;
  catalogue: ImmutablePlatformBlockCatalogue;
}>) {
  const router = useRouter();
  const [inputs, setInputs] = useState<MinimumApplicationInputs>({
    name: "",
    description: "",
    key: "",
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isCreating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<keyof MinimumApplicationInputs, string>>>
  >({});
  const active = useRef(false);
  const lifetime = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    lifetime.current += 1;
    return () => {
      active.current = false;
      lifetime.current += 1;
    };
  }, []);

  const edit = (changes: Partial<MinimumApplicationInputs>) => {
    setInputs({ ...inputs, ...changes });
    setFieldErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([name]) => !(name in changes) && !(name === "key" && "name" in changes),
        ),
      ),
    );
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    const candidate = minimumApplicationSource(inputs, catalogue);
    if (candidate.kind !== "valid") {
      setFieldErrors(candidate.fieldErrors);
      if (candidate.fieldErrors.key !== undefined) setAdvancedOpen(true);
      setMessage(candidate.message);
      return;
    }
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
        router.replace(
          `/studio/${encodeURIComponent(result.draft.organizationId)}/${encodeURIComponent(result.draft.rootId)}`,
        );
        setMessage("Application created. Opening it…");
      } else {
        setMessage(
          result.kind === "conflict"
            ? conflictMessage(result.reason, "No draft was created.")
            : result.kind === "refused"
              ? refusalMessage(result.reason, "No draft was created.")
              : "Creation could not be verified. Your inputs are preserved; try again.",
        );
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

  return (
    <main className="flex min-h-dvh items-start justify-center px-6 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold tracking-tight">New application</h1>
          </CardTitle>
          <CardDescription>
            Start with a name and description, then add pages and records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="grid gap-4" aria-busy={isCreating} noValidate>
            <StudioField
              label="Name"
              hint="Give your application a clear name."
              error={fieldErrors.name}
            >
              {(control) => (
                <Input
                  {...control}
                  required
                  maxLength={120}
                  value={inputs.name}
                  autoFocus
                  disabled={isCreating}
                  onChange={(event) => edit({ name: event.target.value })}
                />
              )}
            </StudioField>
            <StudioField
              label="Description"
              hint="What people use this application for."
              error={fieldErrors.description}
            >
              {(control) => (
                <Textarea
                  {...control}
                  className={inputClass}
                  required
                  maxLength={1000}
                  value={inputs.description}
                  disabled={isCreating}
                  onChange={(event) => edit({ description: event.target.value })}
                />
              )}
            </StudioField>
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="space-y-2">
              <CollapsibleTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                  />
                }
              >
                Advanced
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4">
                <StudioField
                  label="Key"
                  error={fieldErrors.key}
                  hint="Made from the name. It identifies the application everywhere and cannot be changed after it is created."
                >
                  {(control) => (
                    <Input
                      {...control}
                      maxLength={100}
                      value={inputs.key}
                      placeholder={applicationKeyFromName(inputs.name) || "app.assets_hub"}
                      disabled={isCreating}
                      onChange={(event) => edit({ key: event.target.value })}
                    />
                  )}
                </StudioField>
              </CollapsibleContent>
            </Collapsible>
            <Button type="submit" disabled={isCreating}>
              Create application
            </Button>
            <p role="status" aria-live="polite">
              {message}
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
