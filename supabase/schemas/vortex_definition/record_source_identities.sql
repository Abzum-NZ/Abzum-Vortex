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
