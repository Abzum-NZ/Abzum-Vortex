set local role vortex_owner;

create or replace function vortex_definition.record_source_identities(p_root_id uuid, p_requirements jsonb, p_actor_id uuid, p_operation_at timestamp with time zone) returns void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  root_key text;
begin
  if pg_catalog.jsonb_typeof(p_requirements) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_requirements) < 1 then
    raise exception using
      errcode = '22023',
      message = 'Source identity requirements must be a non-empty array';
  end if;

  select root.key
  into root_key
  from vortex_definition.roots as root
  where root.root_id = p_root_id;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'Source identities require an existing Definition root';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_requirements) as requirement(value)
    where pg_catalog.jsonb_typeof(requirement.value) is distinct from 'object'
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(requirement.value) as supplied(key)
        where supplied.key not in (
          'definitionKey', 'ownerScope', 'scope', 'kind', 'componentOwner', 'aliases'
        )
      )
  ) then
    raise exception using errcode = '22023',
      message = 'A source identity requirement has an invalid shape';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_requirements) as requirement(
      "definitionKey" text, "ownerScope" text, scope text, kind text,
      "componentOwner" text, aliases jsonb
    )
    where requirement."definitionKey" is distinct from root_key
      or requirement."ownerScope" is null
      or pg_catalog.char_length(requirement."ownerScope") not between 1 and 500
      or requirement.scope is null
      or pg_catalog.char_length(requirement.scope) not between 1 and 500
      or requirement.kind is null
      or requirement."componentOwner" is null
      or pg_catalog.char_length(requirement."componentOwner") not between 1 and 240
      or pg_catalog.jsonb_typeof(requirement.aliases) is distinct from 'array'
      or pg_catalog.jsonb_array_length(requirement.aliases) < 1
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(requirement.aliases) as item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or pg_catalog.char_length(item.value #>> '{}') not between 1 and 500
      )
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements_text(requirement.aliases) as item(value)
      ) is distinct from (
        select pg_catalog.count(distinct item.value)
        from pg_catalog.jsonb_array_elements_text(requirement.aliases) as item(value)
      )
  ) then
    raise exception using errcode = '22023',
      message = 'A source identity requirement is invalid';
  end if;

  insert into vortex_definition.source_identities (
    identity_id, root_id, owner_scope, kind, component_owner, created_at, created_by
  )
  select
    case when requirement.kind = 'root' then p_root_id else pg_catalog.gen_random_uuid() end,
    p_root_id, requirement.owner_scope, requirement.kind, requirement.component_owner,
    p_operation_at, p_actor_id
  from (
    select distinct "ownerScope" as owner_scope, kind, "componentOwner" as component_owner
    from pg_catalog.jsonb_to_recordset(p_requirements) as item(
      "ownerScope" text, kind text, "componentOwner" text
    )
  ) as requirement
  left join vortex_definition.source_identities as existing
    on existing.root_id = p_root_id
    and existing.owner_scope = requirement.owner_scope
    and existing.kind = requirement.kind
    and existing.component_owner = requirement.component_owner
  where existing.identity_id is null
  on conflict on constraint source_identities_owner_unique do nothing;

  insert into vortex_definition.source_identity_aliases (
    root_id, owner_scope, scope, kind, alias, component_owner, identity_id,
    created_at, created_by
  )
  select distinct on (requirement.scope, requirement.kind, item.value)
    p_root_id, requirement."ownerScope", requirement.scope, requirement.kind, item.value,
    requirement."componentOwner", identity.identity_id, p_operation_at, p_actor_id
  from pg_catalog.jsonb_to_recordset(p_requirements) as requirement(
    "ownerScope" text, scope text, kind text, "componentOwner" text, aliases jsonb
  )
  cross join lateral pg_catalog.jsonb_array_elements_text(requirement.aliases) as item(value)
  join vortex_definition.source_identities as identity
    on identity.root_id = p_root_id
    and identity.owner_scope = requirement."ownerScope"
    and identity.kind = requirement.kind
    and identity.component_owner = requirement."componentOwner"
  left join vortex_definition.source_identity_aliases as existing
    on existing.root_id = p_root_id
    and existing.scope = requirement.scope
    and existing.kind = requirement.kind
    and existing.alias = item.value
  where existing.root_id is null
  order by requirement.scope, requirement.kind, item.value,
    requirement."ownerScope", requirement."componentOwner"
  on conflict on constraint source_identity_aliases_pk do nothing;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_requirements) as requirement(
      "ownerScope" text, scope text, kind text, "componentOwner" text, aliases jsonb
    )
    cross join lateral pg_catalog.jsonb_array_elements_text(requirement.aliases) as item(value)
    join vortex_definition.source_identities as identity
      on identity.root_id = p_root_id
      and identity.owner_scope = requirement."ownerScope"
      and identity.kind = requirement.kind
      and identity.component_owner = requirement."componentOwner"
    left join vortex_definition.source_identity_aliases as alias
      on alias.root_id = p_root_id
      and alias.scope = requirement.scope
      and alias.kind = requirement.kind
      and alias.alias = item.value
    where alias.component_owner is distinct from requirement."componentOwner"
      or alias.identity_id is distinct from identity.identity_id
  ) then
    raise exception using errcode = '23505',
      message = 'A historical source identity alias cannot be reassigned';
  end if;

  if not exists (
    select 1
    from vortex_definition.source_identities as identity
    where identity.root_id = p_root_id
      and identity.identity_id = p_root_id
      and identity.owner_scope = 'document'
      and identity.kind = 'root'
      and identity.component_owner = 'root'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Every Definition root requires its permanent source root identity';
  end if;
end
$$;

alter function vortex_definition.record_source_identities(p_root_id uuid, p_requirements jsonb, p_actor_id uuid, p_operation_at timestamp with time zone) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_definition.record_source_identities(p_root_id uuid, p_requirements jsonb, p_actor_id uuid, p_operation_at timestamp with time zone) FROM PUBLIC;

grant execute on function vortex_definition.record_source_identities(p_root_id uuid, p_requirements jsonb, p_actor_id uuid, p_operation_at timestamp with time zone) to postgres;

create or replace function vortex_definition.save_draft(
  p_root_id uuid,
  p_expected_revision bigint,
  p_draft_source jsonb,
  p_source_fingerprint text,
  p_identity_requirements jsonb
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
  expected_organization_id uuid;
  root_organization_id uuid;
  saved_revision bigint;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  actor_id uuid;
  human_write boolean;
  root_key text;
  root_kind text;
begin
  human_write := vortex_platform.current_context() ->> 'callerKind' = 'human';
  if human_write then
    checked_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    actor_id := (checked_context ->> 'organizationAccountId')::uuid;
  else
    checked_context := vortex_definition.validated_system_context();
    actor_id := (checked_context ->> 'systemActorId')::uuid;
  end if;
  expected_organization_id := (checked_context ->> 'organizationId')::uuid;

  if p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Definition draft save has an invalid root or expected revision';
  end if;

  select root.organization_id
  into root_organization_id
  from vortex_definition.roots as root
  where root.root_id = p_root_id;

  if not found then
    return;
  end if;

  if root_organization_id <> expected_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  if human_write then
    select root.key, root.kind into strict root_key, root_kind
    from vortex_definition.roots as root
    where root.root_id = p_root_id;
    if root_kind is null or root_kind not in ('application', 'module')
      or p_draft_source ->> 'kind' is distinct from root_kind
      or p_draft_source ->> 'key' is distinct from root_key then
      raise exception using errcode = '22023',
        message = 'Definition draft write source is invalid';
    end if;
  end if;

  update vortex_definition.drafts as draft
  set
    draft_revision = draft.draft_revision + 1,
    draft_source = p_draft_source,
    identity_requirements = p_identity_requirements,
    source_contract_version = p_draft_source ->> 'source_contract_version',
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
    p_root_id,
    p_identity_requirements,
    actor_id,
    operation_at
  );

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
  where root.root_id = p_root_id;
end
$function$;

grant execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) to vortex_request;

revoke execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) to vortex_request;

comment on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) is
  'Conditionally saves a draft and records new permanent identities and aliases atomically.';

alter function vortex_definition.save_draft(p_root_id uuid, p_expected_revision bigint, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb) owner to vortex_owner;

grant execute on function vortex_definition.save_draft(p_root_id uuid, p_expected_revision bigint, p_draft_source jsonb, p_source_fingerprint text, p_identity_requirements jsonb) to postgres;

reset role;
