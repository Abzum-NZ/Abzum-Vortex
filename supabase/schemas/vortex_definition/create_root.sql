create or replace function vortex_definition.create_root(
  p_kind text,
  p_key text,
  p_draft_source jsonb,
  p_source_fingerprint text,
  p_identity_requirements jsonb,
  p_application_origin_kind text,
  p_owner_application_root_id uuid
)
returns table (
  root_id uuid,
  organization_id uuid,
  kind text,
  definition_key text,
  draft_revision bigint,
  published_revision bigint,
  authored_source jsonb,
  source_contract_version text,
  source_fingerprint text,
  created_at timestamptz,
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  new_root_id uuid;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  actor_id uuid;
  human_write boolean;
  system_projection_value boolean;
  owner_origin_kind text;
begin
  human_write := vortex_platform.current_context() ->> 'callerKind' = 'human';
  if human_write then
    -- A person creates an Application root, or an internal Module root owned by an ordinary
    -- Application they may draft: only that Application's publication creates one.
    checked_context := vortex_definition.validated_builder_draft_write_context_internal(
      case when p_kind = 'module' then p_owner_application_root_id end
    );
    if (p_kind = 'application' and p_application_origin_kind is distinct from 'ordinary')
      or (p_kind = 'module' and p_owner_application_root_id is null)
      or p_draft_source ->> 'kind' is distinct from p_kind
      or p_draft_source ->> 'key' is distinct from p_key then
      raise exception using errcode = '22023',
        message = 'Definition draft write source is invalid';
    end if;
    actor_id := (checked_context ->> 'organizationAccountId')::uuid;
  else
    checked_context := vortex_definition.validated_system_context();
    actor_id := (checked_context ->> 'systemActorId')::uuid;
  end if;

  if p_draft_source ->> 'kind' is distinct from p_kind
    or p_draft_source ->> 'key' is distinct from p_key
    or p_kind is null
    or p_kind not in ('application', 'module')
    or (p_kind = 'application' and (
      p_application_origin_kind is null
      or p_application_origin_kind not in ('ordinary', 'platform_system_application')
      or p_owner_application_root_id is not null
    ))
    or (p_kind = 'module' and (
      p_application_origin_kind is not null
      or p_owner_application_root_id is null
    )) then
    raise exception using errcode = '22023',
      message = 'Definition root source or provenance is invalid';
  end if;

  if p_kind = 'module' then
    select owner_root.application_origin_kind into owner_origin_kind
    from vortex_definition.roots as owner_root
    where owner_root.root_id = p_owner_application_root_id
      and owner_root.organization_id = (checked_context ->> 'organizationId')::uuid
      and owner_root.kind = 'application';
    if not found
      or (human_write and owner_origin_kind is distinct from 'ordinary')
      or not vortex_definition.is_owned_module_source_internal(
        p_owner_application_root_id,
        (checked_context ->> 'organizationId')::uuid,
        p_draft_source
      ) then
      raise exception using errcode = '22023',
        message = 'A Module root must be an inline Module of its owning Application';
    end if;
  end if;

  loop
    new_root_id := pg_catalog.gen_random_uuid();
    exit when new_root_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end loop;

  system_projection_value := p_kind = 'module' and exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(p_draft_source #> '{body,record_types}', '[]'::jsonb)
    ) as record_type(value)
    where record_type.value ? 'system_projection'
  );

  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by,
    application_origin_kind, system_projection, owner_application_root_id
  ) values (
    new_root_id,
    (checked_context ->> 'organizationId')::uuid,
    p_kind,
    p_key,
    operation_at,
    actor_id,
    p_application_origin_kind,
    system_projection_value,
    p_owner_application_root_id
  );

  perform vortex_definition.record_source_identities(
    new_root_id, p_identity_requirements, actor_id, operation_at
  );

  insert into vortex_definition.drafts (
    root_id, draft_revision, draft_source, source_contract_version,
    identity_requirements, source_fingerprint, updated_at, updated_by
  ) values (
    new_root_id,
    1,
    p_draft_source,
    p_draft_source ->> 'source_contract_version',
    p_identity_requirements,
    p_source_fingerprint,
    operation_at,
    actor_id
  );

  if human_write and p_kind = 'application' then
    perform vortex_definition.validated_builder_draft_write_context_internal(new_root_id);
  end if;

  return query
  select
    root.root_id,
    root.organization_id,
    root.kind,
    root.key,
    draft.draft_revision,
    root.current_release_revision,
    draft.draft_source,
    draft.source_contract_version,
    draft.source_fingerprint,
    root.created_at,
    root.created_by,
    draft.updated_at,
    draft.updated_by
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = new_root_id;
end
$function$;

revoke execute on function vortex_definition.create_root(text, text, jsonb, text, jsonb, text, uuid) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.create_root(text, text, jsonb, text, jsonb, text, uuid) to vortex_request;

comment on function vortex_definition.create_root(text, text, jsonb, text, jsonb, text, uuid) is
  'Creates a Definition root with permanent component identities and initial draft atomically: an Application with explicit provenance, or an internal Module owned by the Application whose inline Module it is.';

alter function vortex_definition.create_root(p_kind text, p_key text, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb, p_application_origin_kind text, p_owner_application_root_id uuid) owner to vortex_owner;

grant execute on function vortex_definition.create_root(p_kind text, p_key text, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb, p_application_origin_kind text, p_owner_application_root_id uuid) to postgres;
