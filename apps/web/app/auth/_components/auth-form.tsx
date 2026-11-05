"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Field, FieldDescription, FieldError } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";

type Entry = Readonly<{ check: () => boolean; focus: () => void }>;
type Register = (entry: Entry) => () => void;

const FormContext = createContext<Register | undefined>(undefined);

/**
 * A sign-in style form that checks its fields itself instead of the browser's validation bubble:
 * each invalid field shows its message beside it (linked with aria-describedby, aria-invalid set)
 * and focus moves to the first one. A form that passes goes to its server action unchanged; the
 * checks never read a value into a message or the console.
 */
export function AuthForm({
  action,
  children,
}: Readonly<{ action: (formData: FormData) => void | Promise<void>; children: ReactNode }>) {
  const entries = useRef(new Set<Entry>());
  const register = useCallback<Register>((entry) => {
    entries.current.add(entry);
    return () => entries.current.delete(entry);
  }, []);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    const invalid = [...entries.current].filter((entry) => !entry.check());
    if (invalid.length === 0) return;
    event.preventDefault();
    invalid[0]?.focus();
  };
  return (
    <FormContext.Provider value={register}>
      <form className="flex flex-col gap-5" action={action} onSubmit={submit} noValidate>
        {children}
      </form>
    </FormContext.Provider>
  );
}

/** Registers a field's check with the form and keeps the field's message in step with its value. */
const useFieldCheck = (
  message: () => string | undefined,
  focus: () => void,
): Readonly<{ error: string | undefined; revalidate: () => void }> => {
  const register = useContext(FormContext);
  const [error, setError] = useState<string | undefined>(undefined);
  const messageRef = useRef(message);
  messageRef.current = message;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(
    () =>
      register?.({
        check: () => {
          const found = messageRef.current();
          setError(found);
          return found === undefined;
        },
        focus: () => focusRef.current(),
      }),
    [register],
  );
  const revalidate = useCallback(
    () => setError((current) => (current === undefined ? current : messageRef.current())),
    [],
  );
  return { error, revalidate };
};

type AuthTextFieldProps = Readonly<{
  id: string;
  name: string;
  label: string;
  type: "email" | "password" | "text";
  autoComplete: string;
  /** Shown when the field is empty. */
  missing: string;
  /** Shown when the field has a value the browser's own rules (type, length, pattern) reject. */
  invalid: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  inputMode?: "numeric";
}>;

/** One required text field with its label, optional help line and its own message. */
export function AuthTextField({
  id,
  label,
  description,
  missing,
  invalid,
  ...input
}: AuthTextFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { error, revalidate } = useFieldCheck(
    () => {
      const validity = inputRef.current?.validity;
      return validity === undefined || validity.valid
        ? undefined
        : validity.valueMissing
          ? missing
          : invalid;
    },
    () => inputRef.current?.focus(),
  );
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [
    description === undefined ? "" : descriptionId,
    error === undefined ? "" : errorId,
  ]
    .filter((part) => part !== "")
    .join(" ");
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <Label htmlFor={id}>{label}</Label>
      {description === undefined ? null : (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      )}
      <Input
        {...input}
        id={id}
        ref={inputRef}
        required
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === "" ? undefined : describedBy}
        onChange={revalidate}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

/** One required acknowledgement checkbox with its label and its own message. */
export function AuthCheckbox({
  id,
  name,
  label,
  missing,
}: Readonly<{ id: string; name: string; label: string; missing: string }>) {
  const boxRef = useRef<HTMLElement>(null);
  const checked = useRef(false);
  const { error, revalidate } = useFieldCheck(
    () => (checked.current ? undefined : missing),
    () => boxRef.current?.focus(),
  );
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          name={name}
          required
          ref={boxRef}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
          onCheckedChange={(value) => {
            checked.current = value;
            revalidate();
          }}
        />
        <Label htmlFor={id}>{label}</Label>
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}
