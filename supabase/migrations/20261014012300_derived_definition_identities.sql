-- Draft compile uses the draft's own modules (#2733).
-- A new source identity and a new owned Module root get a derived permanent identity instead of a
-- random one: a version-8 UUID from their owner and position. Studio compiles a draft's inline
-- Modules in memory with the publication's own steps and derives the identities a publication
-- has not yet recorded exactly as these functions will record them. Recorded identities keep
-- their values.
set local role vortex_owner;

create or replace function vortex_definition.derived_definition_id(p_parts text[])
returns uuid
language sql
immutable
strict
set search_path = ''
as $function$
  -- A version-8 UUID from the MD5 of the parts joined by the unit separator, with the RFC 9562
  -- variant bits. Studio's in-memory draft compile derives exactly the same value.
  select (
    pg_catalog.substr(source.digest_hex, 1, 12)
    || '8'
    || pg_catalog.substr(source.digest_hex, 14, 3)
    || pg_catalog.substr(
      '89ab',
      (pg_catalog.strpos(
        '0123456789abcdef', pg_catalog.substr(source.digest_hex, 17, 1)
      ) - 1) % 4 + 1,
      1
    )
    || pg_catalog.substr(source.digest_hex, 18, 15)
  )::uuid
  from (
    select pg_catalog.md5(
      pg_catalog.convert_to(pg_catalog.array_to_string(p_parts, pg_catalog.chr(31)), 'UTF8')
    ) as digest_hex
  ) as source
$function$;

alter function vortex_definition.derived_definition_id(text[]) owner to vortex_owner;

revoke all on function vortex_definition.derived_definition_id(text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_definition.derived_definition_id(text[]) is
  'The permanent identity a new Definition component or owned Module root is given: derived from its owner and position, so a draft compiled in memory names it exactly as its publication will.';

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
    -- A new identity is derived from its root and owner, so a draft compiled in memory names
    -- it exactly as this record does.
    case when requirement.kind = 'root' then p_root_id
      else vortex_definition.derived_definition_id(array[
        'source_identity', pg_catalog.lower(p_root_id::text), requirement.owner_scope,
        requirement.kind, requirement.component_owner
      ]) end,
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

  -- An owned Module's root is derived from its Application and key, so a draft compiled in
  -- memory names a Module that is not yet created exactly as its creation will.
  if p_kind = 'module' then
    new_root_id := vortex_definition.derived_definition_id(array[
      'owned_module_root', pg_catalog.lower(p_owner_application_root_id::text), p_key
    ]);
  else
    loop
      new_root_id := pg_catalog.gen_random_uuid();
      exit when new_root_id <> '00000000-0000-0000-0000-000000000000'::uuid;
    end loop;
  end if;

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

reset role;
