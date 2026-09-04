-- Private Definition-service storage for permanent organisation-owned roots
-- and their single editable authored-source drafts. Publication and contained
-- component identity storage are deliberately added by later migrations.
create schema if not exists vortex_definition authorization postgres;

revoke all on schema vortex_definition
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

alter default privileges for role postgres in schema vortex_definition
  revoke all on tables
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_definition
  revoke all on sequences
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_definition
  revoke execute on functions
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create table vortex_definition.roots (
  root_id uuid not null,
  organization_id uuid not null,
  kind text not null,
  key text not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  created_by uuid not null,
  constraint roots_pk primary key (root_id),
  constraint roots_id_non_nil check (
    root_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint roots_organization_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint roots_kind_valid check (kind in ('module', 'application')),
  constraint roots_key_format check (
    pg_catalog.char_length(key) between 3 and 120
    and key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    and key !~ '(^|\.)[^.]{41,}(\.|$)'
  ),
  constraint roots_created_by_non_nil check (
    created_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint roots_created_at_finite check (
    created_at <> '-infinity'::timestamptz
    and created_at <> 'infinity'::timestamptz
  ),
  constraint roots_organization_kind_key_unique unique (organization_id, kind, key),
  constraint roots_organization_fk foreign key (organization_id)
    references vortex_identity.organizations (organization_id)
);

create table vortex_definition.drafts (
  root_id uuid not null,
  draft_revision bigint not null,
  draft_source jsonb not null,
  identity_requirements jsonb not null default '[]'::jsonb,
  source_contract_version text not null,
  source_fingerprint text not null,
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  updated_by uuid not null,
  constraint drafts_pk primary key (root_id),
  constraint drafts_revision_range check (draft_revision between 1 and 9007199254740991),
  constraint drafts_source_object check (pg_catalog.jsonb_typeof(draft_source) = 'object'),
  constraint drafts_identity_requirements_array check (
    pg_catalog.jsonb_typeof(identity_requirements) = 'array'
  ),
  constraint drafts_source_contract_version_format check (
    pg_catalog.char_length(source_contract_version) between 1 and 120
    and source_contract_version ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
  ),
  constraint drafts_source_fingerprint_format check (
    source_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint drafts_updated_by_non_nil check (
    updated_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint drafts_updated_at_finite check (
    updated_at <> '-infinity'::timestamptz
    and updated_at <> 'infinity'::timestamptz
  ),
  constraint drafts_root_fk foreign key (root_id)
    references vortex_definition.roots (root_id)
);

alter table vortex_definition.roots enable row level security;
alter table vortex_definition.roots force row level security;
alter table vortex_definition.drafts enable row level security;
alter table vortex_definition.drafts force row level security;

create function vortex_definition.protect_root_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.root_id is distinct from old.root_id
    or new.organization_id is distinct from old.organization_id
    or new.kind is distinct from old.kind
    or new.key is distinct from old.key
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by then
    raise exception using
      errcode = '23514',
      message = 'Definition root identity, ownership, kind, key and creation evidence are permanent';
  end if;

  return new;
end
$function$;

create function vortex_definition.validate_draft_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  root_kind text;
  root_key text;
  root_created_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    if new.root_id is distinct from old.root_id then
      raise exception using
        errcode = '23514',
        message = 'A definition draft cannot move to another root';
    end if;

    if new.draft_revision is distinct from old.draft_revision + 1 then
      raise exception using
        errcode = '23514',
        message = 'A definition draft revision must increment exactly once';
    end if;

    if new.updated_at < old.updated_at then
      raise exception using
        errcode = '23514',
        message = 'Definition draft update time cannot move backwards';
    end if;
  end if;

  select root.kind, root.key, root.created_at
  into root_kind, root_key, root_created_at
  from vortex_definition.roots as root
  where root.root_id = new.root_id;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'A definition draft requires an existing root';
  end if;

  if pg_catalog.jsonb_typeof(new.draft_source) is distinct from 'object'
    or new.draft_source ->> 'kind' is distinct from root_kind
    or new.draft_source ->> 'key' is distinct from root_key
    or new.draft_source ->> 'source_contract_version'
      is distinct from new.source_contract_version then
    raise exception using
      errcode = '23514',
      message = 'Definition draft metadata must match its permanent root and source contract';
  end if;

  if new.updated_at < root_created_at then
    raise exception using
      errcode = '23514',
      message = 'Definition draft update time cannot precede root creation';
  end if;

  return new;
end
$function$;

create function vortex_definition.validated_system_context()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_context.current_context();

  if checked ->> 'callerKind' is distinct from 'system' then
    raise exception using
      errcode = '42501',
      message = 'Definition root and draft operations require system context';
  end if;

  if not exists (
    select 1
    from vortex_identity.organizations as organization
    where organization.organization_id = (checked ->> 'organizationId')::uuid
      and organization.tenant_id = (checked ->> 'tenantId')::uuid
  ) then
    raise exception using
      errcode = '23503',
      message = 'Vortex context organization does not exist in its tenant';
  end if;

  return checked;
end
$function$;

create function vortex_definition.create_root(
  p_kind text,
  p_key text,
  p_draft_source jsonb,
  p_source_fingerprint text
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

  insert into vortex_definition.drafts (
    root_id,
    draft_revision,
    draft_source,
    source_contract_version,
    source_fingerprint,
    updated_at,
    updated_by
  ) values (
    new_root_id,
    1,
    p_draft_source,
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
  p_source_fingerprint text
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
    source_contract_version = p_draft_source ->> 'source_contract_version',
    source_fingerprint = p_source_fingerprint,
    updated_at = pg_catalog.statement_timestamp(),
    updated_by = (checked_context ->> 'systemActorId')::uuid
  where draft.root_id = p_root_id
    and draft.draft_revision = p_expected_revision
  returning draft.draft_revision into saved_revision;

  if saved_revision is null then
    return;
  end if;

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

create trigger roots_protect_identity
before update of root_id, organization_id, kind, key, created_at, created_by
on vortex_definition.roots
for each row execute function vortex_definition.protect_root_identity();

create trigger drafts_validate_write
before insert or update on vortex_definition.drafts
for each row execute function vortex_definition.validate_draft_write();

revoke all on all tables in schema vortex_definition
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on all sequences in schema vortex_definition
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on all functions in schema vortex_definition
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant usage on schema vortex_definition to vortex_request;
grant execute on function vortex_definition.create_root(text, text, jsonb, text)
  to vortex_request;
grant execute on function vortex_definition.save_draft(uuid, bigint, jsonb, text)
  to vortex_request;

comment on schema vortex_definition is
  'Private Definition-service storage and narrow system-context operations; never exposed through the Supabase Data API.';
comment on table vortex_definition.roots is
  'Permanent organisation-owned Module and Application root identities.';
comment on table vortex_definition.drafts is
  'One current editable authored-source draft for each Definition root.';
comment on function vortex_definition.create_root(text, text, jsonb, text) is
  'Creates a Definition root and initial draft under the validated system context organization.';
comment on function vortex_definition.save_draft(uuid, bigint, jsonb, text) is
  'Conditionally saves and returns a Definition draft, or no row when the expected revision is stale.';
