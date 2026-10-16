create or replace function vortex_definition.stage_owned_module_source(
  p_root_id uuid,
  p_expected_revision bigint,
  p_source jsonb,
  p_source_fingerprint text,
  p_identity_requirements jsonb
)
returns table (
  root_id uuid,
  definition_key text,
  draft_revision bigint,
  current_release_revision bigint,
  source_fingerprint text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  human_write boolean;
  actor_id uuid;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  module_row vortex_definition.roots%rowtype;
  owner_origin_kind text;
  saved_revision bigint;
begin
  -- A Module is never drafted on its own: its owning Application's publication stages the
  -- current lowering of the Application's inline Module here, then compiles and releases it.
  if p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Module source staging has an invalid root or expected revision';
  end if;

  select root.* into module_row
  from vortex_definition.roots as root
  where root.root_id = p_root_id
    and root.kind = 'module';
  if not found then
    return;
  end if;

  human_write := vortex_platform.current_context() ->> 'callerKind' = 'human';
  if human_write then
    -- The person needs draft authority over the owning Application.
    checked_context := vortex_definition.validated_builder_draft_write_context_internal(
      module_row.owner_application_root_id
    );
    actor_id := (checked_context ->> 'organizationAccountId')::uuid;
  else
    checked_context := vortex_definition.validated_system_context();
    actor_id := (checked_context ->> 'systemActorId')::uuid;
  end if;

  if module_row.organization_id <> (checked_context ->> 'organizationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  select owner_root.application_origin_kind into owner_origin_kind
  from vortex_definition.roots as owner_root
  where owner_root.root_id = module_row.owner_application_root_id
    and owner_root.organization_id = module_row.organization_id
    and owner_root.kind = 'application';
  if not found
    or (human_write and owner_origin_kind is distinct from 'ordinary')
    or p_source ->> 'kind' is distinct from 'module'
    or p_source ->> 'key' is distinct from module_row.key
    or not vortex_definition.is_owned_module_source_internal(
      module_row.owner_application_root_id, module_row.organization_id, p_source
    ) then
    raise exception using errcode = '22023',
      message = 'A Module source must be an inline Module of its owning Application';
  end if;

  update vortex_definition.drafts as draft
  set
    draft_revision = draft.draft_revision + 1,
    draft_source = p_source,
    identity_requirements = p_identity_requirements,
    source_contract_version = p_source ->> 'source_contract_version',
    source_fingerprint = p_source_fingerprint,
    restored_from_release_revision = null,
    restored_from_source_fingerprint = null,
    restored_by = null,
    restored_at = null,
    restore_correlation_id = null,
    updated_at = operation_at,
    updated_by = actor_id
  where draft.root_id = p_root_id
    and draft.draft_revision = p_expected_revision
  returning draft.draft_revision into saved_revision;

  if saved_revision is null then
    return;
  end if;

  perform vortex_definition.record_source_identities(
    p_root_id, p_identity_requirements, actor_id, operation_at
  );

  if human_write and (
    checked_context ->> 'draftWriteDeadline' is null
    or (checked_context ->> 'draftWriteDeadline')::timestamptz <= pg_catalog.clock_timestamp()
  ) then
    raise exception using errcode = '42501',
      message = 'Definition draft write authority is unavailable';
  end if;

  return query
  select root.root_id, root.key, draft.draft_revision, root.current_release_revision,
    draft.source_fingerprint
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_root_id;
end
$function$;

revoke all on function vortex_definition.stage_owned_module_source(uuid, bigint, jsonb, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.stage_owned_module_source(uuid, bigint, jsonb, text, jsonb)
  to vortex_request;

comment on function vortex_definition.stage_owned_module_source(uuid, bigint, jsonb, text, jsonb) is
  'Stages the current lowering of an inline Module into its internal Module root for the owning Application''s publication, recording its permanent identities.';

alter function vortex_definition.stage_owned_module_source(uuid, bigint, jsonb, text, jsonb)
  owner to vortex_owner;
