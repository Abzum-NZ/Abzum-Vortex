"use client";
import { useState } from "react";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@vortex/ui/components/item";
import {
  deleteInlineModuleField, inlineRecordTypeLinks, type ApplicationSourceDocument, type InlineRecordTypeLink,
  type InlineRecordTypeReference, type ModuleFieldPublication,
} from "@vortex/platform/schema";
import { StudioReferencesAlert } from "./studio-references-alert";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

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
  onAdd, onEdit, edit, onShow }: Readonly<{
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
  edit: StudioDataEdit;
  onShow: (reference: InlineRecordTypeReference) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const [refused, setRefused] = useState<Readonly<{ label: string; references: readonly InlineRecordTypeReference[] }> | null>(null);
  const [refusals, setRefusals] = useState(0);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const record = source.body.modules.find((module) => module.key === moduleKey)?.record_types.find((item) => item.key === recordKey);
  if (record === undefined) return null;
  const { outgoing, incoming } = inlineRecordTypeLinks(source, moduleKey, recordKey);

  const remove = async (link: InlineRecordTypeLink) => {
    setIssues([]); setRefused(null);
    const result = deleteInlineModuleField(source, moduleKey, recordKey, link.fieldKey, publication);
    if (result.kind === "referenced") { setRefused({ label: link.label, references: result.references }); setRefusals((value) => value + 1); return; }
    if (result.kind === "invalid") { setIssues(result.issues); return; }
    if (!await confirm({
      title: `Delete the relationship ${link.label}?`,
      description: `${record.plural_name} stop linking to ${link.targets.map(targetLabel).join(" or ")}, and the link field ${link.label} ` +
        "leaves the draft. It was never published, so no stored link is lost.",
      confirmLabel: "Delete relationship",
    })) return;
    const deleted = edit((current) => deleteInlineModuleField(current, moduleKey, recordKey, link.fieldKey, publication));
    if (deleted.kind === "referenced") { setRefused({ label: link.label, references: deleted.references }); setRefusals((value) => value + 1); }
    else { const problem = studioEditProblem(deleted); if (problem !== undefined) setIssues([problem]); }
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
    {outgoing.length === 0 ? null : <ItemGroup className="gap-2" aria-label={`Links from ${record.plural_name}`}>
      {outgoing.map((link) => <Item key={link.fieldKey} role="listitem" variant="outline" size="sm">
        <ItemContent>
          <ItemTitle className="flex-wrap">
            {link.label}
            <Badge variant="secondary">{cardinalityWords(link, record.plural_name)}</Badge>
            {publication.fields.has(`${moduleKey}:${recordKey}.${link.fieldKey}`) && <Badge variant="outline">Published</Badge>}
          </ItemTitle>
          <ItemDescription>{record.name} links to {link.targets.map(targetLabel).join(" or ")}
            {link.reverseKey === undefined ? "" : `; back from it as "${link.reverseKey.replaceAll("_", " ")}"`}.
            When a linked record is deleted: {deleteWords[link.onParentDelete]}.</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button type="button" size="xs" variant="outline" disabled={disabled}
            onClick={() => onEdit(moduleKey, recordKey, link.fieldKey)}>Edit</Button>
          <Button type="button" size="xs" variant="destructive" disabled={disabled}
            onClick={() => { void remove(link); }}>Delete</Button>
        </ItemActions>
      </Item>)}
    </ItemGroup>}
    {incoming.length === 0 ? null : <ItemGroup className="gap-2" aria-label={`Links to ${record.plural_name}`}>
      {incoming.map((link) => <Item key={`${link.moduleKey}:${link.recordKey}.${link.fieldKey}`} role="listitem"
        variant="outline" size="sm">
        <ItemContent>
          <ItemTitle className="flex-wrap">
            {link.recordPluralName}: {link.label}
            <Badge variant="secondary">{cardinalityWords(link, link.recordPluralName)}</Badge>
          </ItemTitle>
          <ItemDescription>Each {link.recordName.toLowerCase()} links to a {record.name.toLowerCase()}
            {link.reverseKey === undefined ? "" : `; from ${record.name} it reads as "${link.reverseKey.replaceAll("_", " ")}"`}.
            It is changed on {link.recordName}.</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button type="button" size="xs" variant="outline" disabled={disabled}
            onClick={() => onEdit(link.moduleKey, link.recordKey, link.fieldKey)}>Open on {link.recordName}</Button>
        </ItemActions>
      </Item>)}
    </ItemGroup>}
    {refused === null ? null : <StudioReferencesAlert key={refusals} name={`The relationship ${refused.label}`}
      action="deleted" references={refused.references} onShow={onShow} />}
    {issues.length === 0 ? null : <ul role="alert" className="space-y-1 text-sm text-destructive">
      {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}</ul>}
    {confirmDialog}
  </section>;
}
