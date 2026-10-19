create or replace function vortex_definition.read_application_draft_consistency(
  p_root_id uuid,
  p_expected_draft_revision bigint,
  p_expected_source_fingerprint text,
  p_expected_published_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  consistency jsonb;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  if p_root_id is null or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_source_fingerprint is null then
    raise exception using errcode = '22023', message = 'Draft consistency requires a root, revision and source fingerprint';
  end if;
  if exists (select 1 from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.organization_id <> (checked_context ->> 'organizationId')::uuid
  ) then
    raise exception using errcode = '42501', message = 'Definition root does not belong to the context organization';
  end if;
  select pg_catalog.jsonb_build_object(
    'draftRevision', draft.draft_revision,
    'sourceFingerprint', draft.source_fingerprint,
    'publishedRevision', root.current_release_revision
  ) into consistency
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_root_id and root.kind = 'application'
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and draft.draft_revision = p_expected_draft_revision
    and draft.source_fingerprint = p_expected_source_fingerprint
    and root.current_release_revision is not distinct from p_expected_published_revision;
  return consistency;
end
$function$;

revoke all on function vortex_definition.read_application_draft_consistency(uuid, bigint, text, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_application_draft_consistency(uuid, bigint, text, bigint) to vortex_request;
alter function vortex_definition.read_application_draft_consistency(uuid, bigint, text, bigint) owner to vortex_owner;
