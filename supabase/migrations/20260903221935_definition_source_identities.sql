-- Permanent source-component identities and append-only alias history.
-- A source component's authored `id` is its permanent owner; keys and paths
-- are aliases that may be added but can never be reassigned.

create table vortex_definition.source_identities (
  identity_id uuid not null,
  root_id uuid not null,
  owner_scope text not null,
  kind text not null,
  component_owner text not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  created_by uuid not null,
  constraint source_identities_pk primary key (identity_id),
  constraint source_identities_id_non_nil check (
    identity_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint source_identities_owner_scope_length check (
    pg_catalog.char_length(owner_scope) between 1 and 500
  ),
  constraint source_identities_kind_valid check (
    kind in (
      'root',
      'storage_contract',
      'record_type',
      'field',
      'relationship',
      'permission',
      'action',
      'rule',
      'event',
      'extension_point',
      'sharing_condition',
      'role',
      'navigation_item',
      'query',
      'block',
      'block_placement',
      'page',
      'guided_step',
      'workflow',
      'workflow_node',
      'pipeline',
      'connection_binding',
      'interface',
      'interface_operation',
      'public_address'
    )
  ),
  constraint source_identities_owner_length check (
    pg_catalog.char_length(component_owner) between 1 and 240
  ),
  constraint source_identities_root_shape check (
    (
      kind = 'root'
      and owner_scope = 'document'
      and component_owner = 'root'
      and identity_id = root_id
    )
    or (
      kind <> 'root'
      and identity_id <> root_id
    )
  ),
  constraint source_identities_created_at_finite check (
    created_at <> '-infinity'::timestamptz
    and created_at <> 'infinity'::timestamptz
  ),
  constraint source_identities_created_by_non_nil check (
    created_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint source_identities_owner_unique unique (
    root_id,
    owner_scope,
    kind,
    component_owner
  ),
  constraint source_identities_owner_identity_unique unique (
    root_id,
    owner_scope,
    kind,
    component_owner,
    identity_id
  ),
  constraint source_identities_root_fk foreign key (root_id)
    references vortex_definition.roots (root_id)
);

create table vortex_definition.source_identity_aliases (
  root_id uuid not null,
  owner_scope text not null,
  scope text not null,
  kind text not null,
  alias text not null,
  component_owner text not null,
  identity_id uuid not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  created_by uuid not null,
  constraint source_identity_aliases_pk primary key (root_id, scope, kind, alias),
  constraint source_identity_aliases_owner_scope_length check (
    pg_catalog.char_length(owner_scope) between 1 and 500
  ),
  constraint source_identity_aliases_scope_length check (
    pg_catalog.char_length(scope) between 1 and 500
  ),
  constraint source_identity_aliases_alias_length check (
    pg_catalog.char_length(alias) between 1 and 500
  ),
  constraint source_identity_aliases_owner_length check (
    pg_catalog.char_length(component_owner) between 1 and 240
  ),
  constraint source_identity_aliases_created_at_finite check (
    created_at <> '-infinity'::timestamptz
    and created_at <> 'infinity'::timestamptz
  ),
  constraint source_identity_aliases_created_by_non_nil check (
    created_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint source_identity_aliases_owner_fk foreign key (
    root_id,
    owner_scope,
    kind,
    component_owner,
    identity_id
  ) references vortex_definition.source_identities (
    root_id,
    owner_scope,
    kind,
    component_owner,
    identity_id
  )
);

alter table vortex_definition.source_identities enable row level security;
alter table vortex_definition.source_identities force row level security;
alter table vortex_definition.source_identity_aliases enable row level security;
alter table vortex_definition.source_identity_aliases force row level security;

create function vortex_definition.refuse_source_identity_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '23514',
    message = 'Definition source identities and aliases are append-only';
end
$function$;

create trigger source_identities_append_only
before update or delete on vortex_definition.source_identities
for each row execute function vortex_definition.refuse_source_identity_mutation();

create trigger source_identity_aliases_append_only
before update or delete on vortex_definition.source_identity_aliases
for each row execute function vortex_definition.refuse_source_identity_mutation();

create function vortex_definition.record_source_identities(
  p_root_id uuid,
  p_requirements jsonb,
  p_actor_id uuid,
  p_operation_at timestamptz
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
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
$function$;

revoke execute on function vortex_definition.create_root(text, text, jsonb, text)
  from vortex_request;
revoke execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text)
  from vortex_request;
drop function vortex_definition.create_root(text, text, jsonb, text);
drop function vortex_definition.save_draft(uuid, bigint, jsonb, text);

create function vortex_definition.create_root(
  p_kind text,
  p_key text,
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
  new_root_id uuid;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  actor_id uuid;
begin
  checked_context := vortex_definition.validated_system_context();
  actor_id := (checked_context ->> 'systemActorId')::uuid;

  loop
    new_root_id := pg_catalog.gen_random_uuid();
    exit when new_root_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end loop;

  insert into vortex_definition.roots (
    root_id,
    organization_id,
    kind,
    key,
    created_at,
    created_by
  ) values (
    new_root_id,
    (checked_context ->> 'organizationId')::uuid,
    p_kind,
    p_key,
    operation_at,
    actor_id
  );

  perform vortex_definition.record_source_identities(
    new_root_id,
    p_identity_requirements,
    actor_id,
    operation_at
  );

  insert into vortex_definition.drafts (
    root_id,
    draft_revision,
    draft_source,
    identity_requirements,
    source_contract_version,
    source_fingerprint,
    updated_at,
    updated_by
  ) values (
    new_root_id,
    1,
    p_draft_source,
    p_identity_requirements,
    p_draft_source ->> 'source_contract_version',
    p_source_fingerprint,
    operation_at,
    actor_id
  );

  return query
  select
    root.root_id,
    root.organization_id,
    root.kind,
    root.key,
    draft.draft_revision,
    null::bigint,
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

create function vortex_definition.save_draft(
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
begin
  checked_context := vortex_definition.validated_system_context();
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

  update vortex_definition.drafts as draft
  set
    draft_revision = draft.draft_revision + 1,
    draft_source = p_draft_source,
    identity_requirements = p_identity_requirements,
    source_contract_version = p_draft_source ->> 'source_contract_version',
    source_fingerprint = p_source_fingerprint,
    updated_at = operation_at,
    updated_by = (checked_context ->> 'systemActorId')::uuid
  where draft.root_id = p_root_id
    and draft.draft_revision = p_expected_revision
  returning draft.draft_revision into saved_revision;

  if saved_revision is null then
    return;
  end if;

  perform vortex_definition.record_source_identities(
    p_root_id,
    p_identity_requirements,
    (checked_context ->> 'systemActorId')::uuid,
    operation_at
  );

  return query
  select
    root.root_id,
    root.organization_id,
    root.kind,
    root.key,
    draft.draft_revision,
    null::bigint,
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

revoke all on table vortex_definition.source_identities
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on table vortex_definition.source_identity_aliases
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on all functions in schema vortex_definition
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.create_root(text, text, jsonb, text, jsonb)
  to vortex_request;
grant execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb)
  to vortex_request;

comment on table vortex_definition.source_identities is
  'Permanent identifiers for authored Definition components; owner rows are append-only.';
comment on table vortex_definition.source_identity_aliases is
  'Historical source aliases that remain bound to one permanent component identity.';
comment on function vortex_definition.create_root(text, text, jsonb, text, jsonb) is
  'Creates a Definition root, permanent component identities and initial draft atomically.';
comment on function vortex_definition.save_draft(uuid, bigint, jsonb, text, jsonb) is
  'Conditionally saves a draft and records new permanent identities and aliases atomically.';
