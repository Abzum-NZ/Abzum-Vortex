-- Explain retired identity names and expose their reservations to Studio.
set local role vortex_owner;

create or replace function vortex_definition.record_source_identities(p_root_id uuid, p_requirements jsonb, p_actor_id uuid, p_operation_at timestamp with time zone) returns void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  root_key text;
  retired_identity jsonb;
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

  select pg_catalog.jsonb_build_object(
    'kind', requirement.kind, 'componentOwner', requirement."componentOwner", 'alias', item.value
  ) into retired_identity
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
    order by requirement.scope, requirement.kind, item.value
    limit 1;
  if retired_identity is not null then
    raise exception using errcode = '23505',
      message = 'A historical source identity alias cannot be reassigned',
      constraint = 'source_identity_alias_retired',
      detail = retired_identity::text;
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

create or replace function vortex_definition.read_source_identity_reservations(p_root_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  select root.* into root_row from vortex_definition.roots as root where root.root_id = p_root_id;
  if not found then
    raise exception using errcode = '23503', message = 'Definition root is missing';
  end if;
  if root_row.organization_id <> (checked_context ->> 'organizationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'definitionKey', root.key, 'scope', alias.scope, 'kind', alias.kind,
      'componentOwner', alias.component_owner, 'alias', alias.alias
    ) order by root.key, alias.scope, alias.kind, alias.alias)
    from vortex_definition.roots as root
    join vortex_definition.source_identity_aliases as alias on alias.root_id = root.root_id
    where root.organization_id = root_row.organization_id
      and (root.root_id = p_root_id or root.owner_application_root_id = p_root_id)
  ), '[]'::jsonb);
end
$function$;

alter function vortex_definition.read_source_identity_reservations(uuid) owner to vortex_owner;
revoke all on function vortex_definition.read_source_identity_reservations(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_source_identity_reservations(uuid) to vortex_request, postgres;

reset role;
