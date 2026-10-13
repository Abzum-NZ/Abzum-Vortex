CREATE FUNCTION vortex_definition.record_source_identities(p_root_id uuid, p_requirements jsonb, p_actor_id uuid, p_operation_at timestamp with time zone) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  requirement jsonb;
  requirement_owner_scope text;
  requirement_scope text;
  requirement_kind text;
  requirement_owner text;
  requirement_definition_key text;
  requirement_aliases jsonb;
  requirement_alias text;
  root_key text;
  resolved_identity_id uuid;
  existing_alias_owner text;
  existing_alias_identity_id uuid;
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

  for requirement in
    select value
    from pg_catalog.jsonb_array_elements(p_requirements)
  loop
    if pg_catalog.jsonb_typeof(requirement) is distinct from 'object'
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(requirement) as supplied(key)
        where supplied.key not in (
          'definitionKey',
          'ownerScope',
          'scope',
          'kind',
          'componentOwner',
          'aliases'
        )
      ) then
      raise exception using
        errcode = '22023',
        message = 'A source identity requirement has an invalid shape';
    end if;

    requirement_definition_key := requirement ->> 'definitionKey';
    requirement_owner_scope := requirement ->> 'ownerScope';
    requirement_scope := requirement ->> 'scope';
    requirement_kind := requirement ->> 'kind';
    requirement_owner := requirement ->> 'componentOwner';
    requirement_aliases := requirement -> 'aliases';

    if requirement_definition_key is distinct from root_key
      or requirement_owner_scope is null
      or pg_catalog.char_length(requirement_owner_scope) not between 1 and 500
      or requirement_scope is null
      or pg_catalog.char_length(requirement_scope) not between 1 and 500
      or requirement_kind is null
      or requirement_owner is null
      or pg_catalog.char_length(requirement_owner) not between 1 and 240
      or pg_catalog.jsonb_typeof(requirement_aliases) is distinct from 'array'
      or pg_catalog.jsonb_array_length(requirement_aliases) < 1
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(requirement_aliases) as item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or pg_catalog.char_length(item.value #>> '{}') not between 1 and 500
      )
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements_text(requirement_aliases) as item(value)
      ) is distinct from (
        select pg_catalog.count(distinct item.value)
        from pg_catalog.jsonb_array_elements_text(requirement_aliases) as item(value)
      ) then
      raise exception using
        errcode = '22023',
        message = 'A source identity requirement is invalid';
    end if;

    select identity.identity_id
    into resolved_identity_id
    from vortex_definition.source_identities as identity
    where identity.root_id = p_root_id
      and identity.owner_scope = requirement_owner_scope
      and identity.kind = requirement_kind
      and identity.component_owner = requirement_owner;

    if not found then
      if requirement_kind = 'root' then
        resolved_identity_id := p_root_id;
      else
        loop
          resolved_identity_id := pg_catalog.gen_random_uuid();
          exit when resolved_identity_id <> '00000000-0000-0000-0000-000000000000'::uuid;
        end loop;
      end if;

      insert into vortex_definition.source_identities (
        identity_id,
        root_id,
        owner_scope,
        kind,
        component_owner,
        created_at,
        created_by
      ) values (
        resolved_identity_id,
        p_root_id,
        requirement_owner_scope,
        requirement_kind,
        requirement_owner,
        p_operation_at,
        p_actor_id
      );
    end if;

    for requirement_alias in
      select value
      from pg_catalog.jsonb_array_elements_text(requirement_aliases)
    loop
      select alias.component_owner, alias.identity_id
      into existing_alias_owner, existing_alias_identity_id
      from vortex_definition.source_identity_aliases as alias
      where alias.root_id = p_root_id
        and alias.scope = requirement_scope
        and alias.kind = requirement_kind
        and alias.alias = requirement_alias;

      if found then
        if existing_alias_owner is distinct from requirement_owner
          or existing_alias_identity_id is distinct from resolved_identity_id then
          raise exception using
            errcode = '23505',
            message = 'A historical source identity alias cannot be reassigned';
        end if;
      else
        insert into vortex_definition.source_identity_aliases (
          root_id,
          owner_scope,
          scope,
          kind,
          alias,
          component_owner,
          identity_id,
          created_at,
          created_by
        ) values (
          p_root_id,
          requirement_owner_scope,
          requirement_scope,
          requirement_kind,
          requirement_alias,
          requirement_owner,
          resolved_identity_id,
          p_operation_at,
          p_actor_id
        );
      end if;
    end loop;
  end loop;

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
