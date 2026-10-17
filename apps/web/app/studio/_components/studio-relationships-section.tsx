"use client";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import {
  deleteInlineModuleField, inlineRecordTypeLinks, type ApplicationSourceDocument, type InlineRecordTypeLink,
  type InlineRecordTypeReference, type ModuleFieldPublication,
} from "@vortex/platform/schema";

const deleteWords: Readonly<Record<InlineRecordTypeLink["onParentDelete"], string>> = {
  refuse: "deleting a linked record is refused",
  empty_optional: "deleting a linked record clears the link",
  soft_delete_dependent: "deleting a linked record deletes these records too",
};

const cardinalityWords = (link: InlineRecordTypeLink, plural: string): string =>
  link.cardinality === "one_to_one" ? "one to one" : link.cardinality === "many_to_one"
    ? `many ${plural.toLowerCase()} to one` : "many to many";

/**
 * The record type's relationships: the links its own fields make, each declared by its link field,
 * and the links other record types of the application make to it. A relationship is added,
 * changed and deleted through its link field; deleting one that is in use is refused with where.
 */
export function StudioRelationshipsSection({ source, moduleKey, recordKey, publication, disabled, targetLabel, adding,
  onAdd, onEdit, onApply, onShow }: Readonly<{
  source: ApplicationSourceDocument;
  moduleKey: string;
  recordKey: string;
  publication: ModuleFieldPublication;
  disabled: boolean;
  /** The name of a qualified record type a link points at. */
  targetLabel: (key: string) => string;
  /** Whether a new relationship is being added below. */
  adding: boolean;
  onAdd: () => void;
  /** Opens the link field that declares a relationship. */
  onEdit: (moduleKey: string, recordKey: string, fieldKey: string) => void;
  /** Applies the source without a relationship; false when the draft moved on meanwhile. */
  onApply: (expected: ApplicationSourceDocument, next: ApplicationSourceDocument, message: string) => boolean;
  onShow: (reference: InlineRecordTypeReference) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const [refused, setRefused] = useState<Readonly<{ label: string; references: readonly InlineRecordTypeReference[] }> | null>(null);
  const [showing, setShowing] = useState(false);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const record = source.body.modules.find((module) => module.key === moduleKey)?.record_types.find((item) => item.key === recordKey);
  if (record === undefined) return null;
  const { outgoing, incoming } = inlineRecordTypeLinks(source, moduleKey, recordKey);

  const remove = async (link: InlineRecordTypeLink) => {
    setIssues([]); setRefused(null);
    const result = deleteInlineModuleField(source, moduleKey, recordKey, link.fieldKey, publication);
    if (result.kind === "referenced") { setRefused({ label: link.label, references: result.references }); setShowing(false); return; }
    if (result.kind === "invalid") { setIssues(result.issues); return; }
    if (!await confirm({
      title: `Delete the relationship ${link.label}?`,
      description: `${record.plural_name} stop linking to ${link.targets.map(targetLabel).join(" or ")}, and the link field ${link.label} ` +
        "leaves the draft. It was never published, so no stored link is lost.",
      confirmLabel: "Delete relationship",
    })) return;
    if (!onApply(source, result.source, `The relationship ${link.label} was deleted from the draft. Save to keep it.`))
      setIssues(["The draft changed or is busy, so nothing was deleted. Try again in a moment."]);
  };

  return <section className="space-y-3 border-t border-border pt-3" aria-label="Relationships">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">Relationships</h3>
      <Button type="button" size="sm" variant="outline" disabled={disabled} aria-expanded={adding} onClick={onAdd}>
        Add a relationship</Button>
    </div>
    {outgoing.length === 0 && incoming.length === 0
      ? <p className="text-sm text-muted-foreground">{record.plural_name} have no relationships yet. A relationship links each
        {` ${record.name.toLowerCase()} `}to a record of another record type, or to a person.</p>
      : null}
    {outgoing.length === 0 ? null : <ul className="space-y-2" aria-label={`Links from ${record.plural_name}`}>
      {outgoing.map((link) => <li key={link.fieldKey} className="space-y-1 rounded-md border border-border p-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{link.label}</span>
          <Badge variant="secondary">{cardinalityWords(link, record.plural_name)}</Badge>
          {publication.fields.has(`${moduleKey}:${recordKey}.${link.fieldKey}`) && <Badge variant="outline">Published</Badge>}
        </div>
        <p>{record.name} links to {link.targets.map(targetLabel).join(" or ")}
          {link.reverseKey === undefined ? "" : `; back from it as "${link.reverseKey.replaceAll("_", " ")}"`}.</p>
        <p className="text-muted-foreground">When a linked record is deleted: {deleteWords[link.onParentDelete]}.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="xs" variant="outline" disabled={disabled}
            onClick={() => onEdit(moduleKey, recordKey, link.fieldKey)}>Edit</Button>
          <Button type="button" size="xs" variant="destructive" disabled={disabled}
            onClick={() => { void remove(link); }}>Delete</Button>
        </div>
      </li>)}
    </ul>}
    {incoming.length === 0 ? null : <ul className="space-y-2" aria-label={`Links to ${record.plural_name}`}>
      {incoming.map((link) => <li key={`${link.moduleKey}:${link.recordKey}.${link.fieldKey}`}
        className="space-y-1 rounded-md border border-border p-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{link.recordPluralName}: {link.label}</span>
          <Badge variant="secondary">{cardinalityWords(link, link.recordPluralName)}</Badge>
        </div>
        <p>Each {link.recordName.toLowerCase()} links to a {record.name.toLowerCase()}
          {link.reverseKey === undefined ? "" : `; from ${record.name} it reads as "${link.reverseKey.replaceAll("_", " ")}"`}.
          It is changed on {link.recordName}.</p>
        <Button type="button" size="xs" variant="outline" disabled={disabled}
          onClick={() => onEdit(link.moduleKey, link.recordKey, link.fieldKey)}>Open on {link.recordName}</Button>
      </li>)}
    </ul>}
    {refused === null ? null : <Alert variant="destructive" role="alert">
      <AlertTitle>The relationship {refused.label} cannot be deleted</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>It is used in {refused.references.length} {refused.references.length === 1 ? "place" : "places"}. Remove those uses first.</p>
        <Button type="button" size="xs" variant="outline" aria-expanded={showing} onClick={() => setShowing(!showing)}>
          {showing ? "Hide where" : "Show me where"}</Button>
        {showing && <ul className="list-disc space-y-1 pl-5" aria-label={`Where ${refused.label} is used`}>
          {refused.references.map((reference) => <li key={reference.label} className="break-words">
            {reference.open.kind === "none" ? reference.label
              : <Button type="button" variant="link" size="sm" className="h-auto whitespace-normal p-0 text-left"
                onClick={() => onShow(reference)}>{reference.label}</Button>}
          </li>)}
        </ul>}
      </AlertDescription>
    </Alert>}
    {issues.length === 0 ? null : <ul role="alert" className="space-y-1 text-sm text-destructive">
      {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}</ul>}
    {confirmDialog}
  </section>;
}
