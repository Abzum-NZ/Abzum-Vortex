-- #587: Page-owned private revisioned form drafts.
--
-- One unfinished form belonging to one person, one exact installed application
-- release and one exact form/flow/node, with an optional record subject. A draft
-- is deliberately not a business record: it creates no Record, Activity or
-- event. The organisation, organisation account, identity and active
-- installation always come from the validated request context, never from a
-- caller, so one person can never read or update another person's draft. Each
-- save carries the exact current revision, so a stale update is refused instead
-- of overwriting newer input. A row exists only while its draft is live: an
-- abandoned draft is deleted at once, and a draft untouched for thirty days is
-- never returned again and is deleted by the bounded purges below.

begin;

create schema if not exists vortex_page authorization postgres;

revoke all on schema vortex_page from public, anon, authenticated, service_role;
grant usage on schema vortex_page to vortex_request;

alter default privileges for role postgres in schema vortex_page
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_page
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_page
  revoke execute on functions from public, anon, authenticated, service_role;

-- A key is a permanent field identity (lower-case UUID, as the Page contract
-- normalises it) or a declared record-free form input key.
create function vortex_page.private_form_draft_key_is_valid(p_key text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_key is not null
    and (
      p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (
        pg_catalog.length(p_key) <= 40
        and p_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
      )
    )
$function$;

-- Values are a bounded object keyed only by valid draft keys. The Page contract
-- enforces the exact 256 KiB serialised bound; the store keeps a looser text
-- bound as a backstop because canonical jsonb text adds separator whitespace.
create function vortex_page.private_form_draft_values_are_valid(p_values jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_values is null or pg_catalog.jsonb_typeof(p_values) <> 'object' then false
    else pg_catalog.octet_length(p_values::text) <= 524288
      and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_values)) <= 500
      and not exists (
        select 1
        from pg_catalog.jsonb_object_keys(p_values) as supplied(key)
        where not vortex_page.private_form_draft_key_is_valid(supplied.key)
      )
  end
$function$;

-- Validation state holds only a closed state and an optional machine reason
-- code per field, never a rendered message or raw server value.
create function vortex_page.private_form_draft_validation_is_valid(p_validation jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_validation is null or pg_catalog.jsonb_typeof(p_validation) <> 'object' then false
    else (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_validation)) <= 500
      and not exists (
        select 1
        from pg_catalog.jsonb_each(p_validation) as supplied(key, value)
        where not vortex_page.private_form_draft_key_is_valid(supplied.key)
          or case
            when pg_catalog.jsonb_typeof(supplied.value) <> 'object' then true
            else supplied.value ->> 'state' is null
              or supplied.value ->> 'state' not in ('valid', 'invalid', 'incomplete')
              or (supplied.value - array['state', 'reasonCode']) <> '{}'::jsonb
              or (
                supplied.value ? 'reasonCode'
                and case
                  when pg_catalog.jsonb_typeof(supplied.value -> 'reasonCode') <> 'string'
                    then true
                  else pg_catalog.length(supplied.value ->> 'reasonCode') > 120
                    or supplied.value ->> 'reasonCode' !~ '^[a-z][a-z0-9_]*$'
                end
              )
          end
      )
  end
$function$;

create table vortex_page.form_drafts (
  draft_id uuid not null primary key,
  organization_id uuid not null,
  organization_account_id uuid not null,
  identity_id uuid not null,
  application_root_id uuid not null,
  installation_release_revision bigint not null,
  form_id uuid not null,
  flow_id uuid,
  node_id uuid,
  subject_record_id uuid,
  revision bigint not null,
  field_values jsonb not null,
  validation_state jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null,
  correlation_id uuid not null,
  constraint form_drafts_account_same_organization_fk foreign key (
    organization_id,
    organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id,
    organization_account_id
  ),
  constraint form_drafts_identity_same_organization_fk foreign key (
    organization_id,
    identity_id
  ) references vortex_identity.organization_accounts (
    organization_id,
    identity_id
  ),
  constraint form_drafts_ids_non_nil check (
    vortex_context.is_non_nil_uuid(draft_id::text)
    and vortex_context.is_non_nil_uuid(organization_id::text)
    and vortex_context.is_non_nil_uuid(organization_account_id::text)
    and vortex_context.is_non_nil_uuid(identity_id::text)
    and vortex_context.is_non_nil_uuid(application_root_id::text)
    and vortex_context.is_non_nil_uuid(form_id::text)
    and (flow_id is null or vortex_context.is_non_nil_uuid(flow_id::text))
    and (node_id is null or vortex_context.is_non_nil_uuid(node_id::text))
    and (subject_record_id is null or vortex_context.is_non_nil_uuid(subject_record_id::text))
    and vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint form_drafts_revisions_valid check (
    installation_release_revision between 1 and 9007199254740991
    and revision between 1 and 9007199254740991
  ),
  constraint form_drafts_times_valid check (
    created_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and updated_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and updated_at >= created_at
    and expires_at > updated_at
  ),
  constraint form_drafts_values_valid check (
    vortex_page.private_form_draft_values_are_valid(field_values)
  ),
  constraint form_drafts_validation_valid check (
    vortex_page.private_form_draft_validation_is_valid(validation_state)
  )
);

comment on table vortex_page.form_drafts is
  'Private revisioned form drafts. Rows are keyed by person, organisation, exact installed Application release and exact form/flow/node, exist only while the draft is live, are written only by the protected Page operations, and are never business records.';

-- One draft per exact scope for one person and one installed release. The
-- release is part of the identity so an upgraded installation can start a fresh
-- draft beside the one bound to the replaced release, which is never resumed.
-- An expired row for the scope is deleted before a new draft is created.
create unique index form_drafts_scope_unique
  on vortex_page.form_drafts (
    organization_id,
    organization_account_id,
    application_root_id,
    installation_release_revision,
    form_id,
    coalesce(flow_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(node_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(subject_record_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index form_drafts_organization_expiry_idx
  on vortex_page.form_drafts (organization_id, expires_at);

alter table vortex_page.form_drafts enable row level security;
alter table vortex_page.form_drafts force row level security;

revoke all on table vortex_page.form_drafts
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- The only canonical JSON form of a draft; optional scope is added without null
-- keys. The state is supplied because a row exists only while it is active.
create function vortex_page.private_form_draft_to_json_internal(
  d vortex_page.form_drafts,
  p_state text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'draftId', d.draft_id,
    'organizationId', d.organization_id,
    'organizationAccountId', d.organization_account_id,
    'identityId', d.identity_id,
    'applicationRootId', d.application_root_id,
    'installationReleaseRevision', d.installation_release_revision,
    'formId', d.form_id,
    'revision', d.revision,
    'values', d.field_values,
    'validation', d.validation_state,
    'state', p_state,
    'createdAt', pg_catalog.to_char(d.created_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', pg_catalog.to_char(d.updated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'expiresAt', pg_catalog.to_char(d.expires_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )
  || case when d.flow_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('flowId', d.flow_id) end
  || case when d.node_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('nodeId', d.node_id) end
  || case when d.subject_record_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('subjectRecordId', d.subject_record_id) end
$function$;

-- The person, organisation and active installation of the current protected
-- request. A draft can never be established for a caller-supplied scope, and an
-- application installation must be complete and current.
create function vortex_page.private_form_draft_context_internal()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  identity_id uuid,
  application_root_id uuid,
  release_revision bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  installation jsonb;
  selected_application_root_id uuid;
begin
  checked := vortex_access.validated_human_request_context();
  if not (checked ?& array['organizationAccountId', 'identityId', 'applicationRootId'])
    or not vortex_context.is_non_nil_uuid(checked ->> 'applicationRootId')
    or not vortex_context.is_non_nil_uuid(checked ->> 'organizationAccountId')
    or not vortex_context.is_non_nil_uuid(checked ->> 'identityId') then
    raise exception using errcode = '42501',
      message = 'Private form draft scope is unavailable';
  end if;
  selected_application_root_id := (checked ->> 'applicationRootId')::uuid;

  installation := vortex_module.read_current_active_installation();
  if installation is null
    or pg_catalog.jsonb_typeof(installation) <> 'object'
    or (installation ->> 'organizationId')::uuid
      is distinct from (checked ->> 'organizationId')::uuid
    or (installation ->> 'applicationRootId')::uuid is distinct from selected_application_root_id
    or pg_catalog.jsonb_typeof(installation -> 'applicationReleaseRevision')
      is distinct from 'number'
    or not vortex_context.is_non_nil_uuid(checked ->> 'correlationId') then
    raise exception using errcode = '42501',
      message = 'Private form draft scope is unavailable';
  end if;

  return query select
    (checked ->> 'organizationId')::uuid,
    (checked ->> 'organizationAccountId')::uuid,
    (checked ->> 'identityId')::uuid,
    selected_application_root_id,
    (installation ->> 'applicationReleaseRevision')::bigint,
    (checked ->> 'correlationId')::uuid;
end
$function$;

-- The single policy point for how long an untouched draft survives: thirty days
-- after its last revision. A shorter organisation policy narrows this value.
create function vortex_page.private_form_draft_expiry_internal(p_touched_at timestamptz)
returns timestamptz
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_touched_at + interval '30 days'
$function$;

-- Deletes a bounded batch of one organisation's drafts that reached expiry.
-- Expired drafts are already never returned, so this only removes unreachable
-- private input; locked rows are skipped for the next purge.
create function vortex_page.private_form_draft_purge_internal(
  p_organization_id uuid,
  p_limit integer
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  affected integer;
begin
  with expired as (
    select draft.draft_id
    from vortex_page.form_drafts as draft
    where draft.organization_id = p_organization_id
      and draft.expires_at <= pg_catalog.clock_timestamp()
    order by draft.expires_at
    limit p_limit
    for update skip locked
  )
  delete from vortex_page.form_drafts as draft
  using expired
  where draft.draft_id = expired.draft_id;

  get diagnostics affected = row_count;
  return affected;
end
$function$;

-- Reads one exact live draft of the current person, or reports the draft is
-- bound to an installation that is no longer the active one. Expired rows are
-- never returned.
create function vortex_page.read_private_form_draft(
  p_form_id uuid,
  p_flow_id uuid,
  p_node_id uuid,
  p_subject_record_id uuid
)
returns table (outcome text, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  stored vortex_page.form_drafts%rowtype;
begin
  if p_form_id is null or not vortex_context.is_non_nil_uuid(p_form_id::text)
    or (p_flow_id is not null and not vortex_context.is_non_nil_uuid(p_flow_id::text))
    or (p_node_id is not null and not vortex_context.is_non_nil_uuid(p_node_id::text))
    or (p_subject_record_id is not null
      and not vortex_context.is_non_nil_uuid(p_subject_record_id::text)) then
    raise exception using errcode = '22023',
      message = 'Private form draft read command is invalid';
  end if;

  select context.* into strict scope
  from vortex_page.private_form_draft_context_internal() as context;

  -- Only the draft bound to the exact current installed release is resumable.
  select draft.* into stored
  from vortex_page.form_drafts as draft
  where draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.identity_id = scope.identity_id
    and draft.application_root_id = scope.application_root_id
    and draft.installation_release_revision = scope.release_revision
    and draft.form_id = p_form_id
    and draft.flow_id is not distinct from p_flow_id
    and draft.node_id is not distinct from p_node_id
    and draft.subject_record_id is not distinct from p_subject_record_id
    and draft.expires_at > pg_catalog.clock_timestamp();
  if found then
    return query select 'available'::text,
      vortex_page.private_form_draft_to_json_internal(stored, 'active');
    return;
  end if;

  -- A live draft for this scope bound to a replaced installation is stale, not
  -- silently combined with the changed form.
  perform 1
  from vortex_page.form_drafts as draft
  where draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.identity_id = scope.identity_id
    and draft.application_root_id = scope.application_root_id
    and draft.installation_release_revision <> scope.release_revision
    and draft.form_id = p_form_id
    and draft.flow_id is not distinct from p_flow_id
    and draft.node_id is not distinct from p_node_id
    and draft.subject_record_id is not distinct from p_subject_record_id
    and draft.expires_at > pg_catalog.clock_timestamp();
  if found then
    return query select 'stale_installation'::text, null::jsonb;
    return;
  end if;

  return query select 'unavailable'::text, null::jsonb;
end
$function$;

-- Creates revision 1 for the current person, or reports that the exact scope is
-- already held by a live draft. Expired rows for that scope are deleted first.
create function vortex_page.create_private_form_draft(
  p_form_id uuid,
  p_flow_id uuid,
  p_node_id uuid,
  p_subject_record_id uuid,
  p_field_values jsonb,
  p_validation_state jsonb
)
returns table (outcome text, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  created_at timestamptz;
  new_draft_id uuid;
  stored vortex_page.form_drafts%rowtype;
begin
  if p_form_id is null or not vortex_context.is_non_nil_uuid(p_form_id::text)
    or (p_flow_id is not null and not vortex_context.is_non_nil_uuid(p_flow_id::text))
    or (p_node_id is not null and not vortex_context.is_non_nil_uuid(p_node_id::text))
    or (p_subject_record_id is not null
      and not vortex_context.is_non_nil_uuid(p_subject_record_id::text))
    or not vortex_page.private_form_draft_values_are_valid(p_field_values)
    or not vortex_page.private_form_draft_validation_is_valid(p_validation_state) then
    raise exception using errcode = '22023',
      message = 'Private form draft create command is invalid';
  end if;

  select context.* into strict scope
  from vortex_page.private_form_draft_context_internal() as context;

  -- An untouched draft that has reached its expiry no longer holds the scope.
  delete from vortex_page.form_drafts as draft
  where draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.application_root_id = scope.application_root_id
    and draft.form_id = p_form_id
    and draft.flow_id is not distinct from p_flow_id
    and draft.node_id is not distinct from p_node_id
    and draft.subject_record_id is not distinct from p_subject_record_id
    and draft.expires_at <= pg_catalog.clock_timestamp();

  perform vortex_page.private_form_draft_purge_internal(scope.organization_id, 100);

  perform 1
  from vortex_page.form_drafts as draft
  where draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.application_root_id = scope.application_root_id
    and draft.installation_release_revision = scope.release_revision
    and draft.form_id = p_form_id
    and draft.flow_id is not distinct from p_flow_id
    and draft.node_id is not distinct from p_node_id
    and draft.subject_record_id is not distinct from p_subject_record_id
  for update;
  if found then
    return query select 'exists'::text, null::jsonb;
    return;
  end if;

  created_at := pg_catalog.clock_timestamp();
  new_draft_id := pg_catalog.gen_random_uuid();
  begin
    insert into vortex_page.form_drafts (
      draft_id, organization_id, organization_account_id, identity_id,
      application_root_id, installation_release_revision,
      form_id, flow_id, node_id, subject_record_id,
      revision, field_values, validation_state,
      created_at, updated_at, expires_at, correlation_id
    ) values (
      new_draft_id, scope.organization_id, scope.organization_account_id, scope.identity_id,
      scope.application_root_id, scope.release_revision,
      p_form_id, p_flow_id, p_node_id, p_subject_record_id,
      1, p_field_values, p_validation_state,
      created_at, created_at,
      vortex_page.private_form_draft_expiry_internal(created_at), scope.correlation_id
    )
    returning * into stored;
  exception
    when unique_violation then
      return query select 'exists'::text, null::jsonb;
      return;
  end;

  return query select 'created'::text,
    vortex_page.private_form_draft_to_json_internal(stored, 'active');
end
$function$;

-- Compare-and-update one exact owned live draft. A stale expected revision is
-- refused instead of overwriting newer input; a draft bound to a replaced
-- installation also stops being resumable. Each revision restarts the thirty
-- day expiry, so only an untouched draft expires.
create function vortex_page.update_private_form_draft(
  p_draft_id uuid,
  p_expected_revision bigint,
  p_form_id uuid,
  p_flow_id uuid,
  p_node_id uuid,
  p_subject_record_id uuid,
  p_field_values jsonb,
  p_validation_state jsonb
)
returns table (outcome text, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  stored vortex_page.form_drafts%rowtype;
  touched_at timestamptz;
begin
  if p_draft_id is null or not vortex_context.is_non_nil_uuid(p_draft_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_form_id is null or not vortex_context.is_non_nil_uuid(p_form_id::text)
    or (p_flow_id is not null and not vortex_context.is_non_nil_uuid(p_flow_id::text))
    or (p_node_id is not null and not vortex_context.is_non_nil_uuid(p_node_id::text))
    or (p_subject_record_id is not null
      and not vortex_context.is_non_nil_uuid(p_subject_record_id::text))
    or not vortex_page.private_form_draft_values_are_valid(p_field_values)
    or not vortex_page.private_form_draft_validation_is_valid(p_validation_state) then
    raise exception using errcode = '22023',
      message = 'Private form draft update command is invalid';
  end if;

  select context.* into strict scope
  from vortex_page.private_form_draft_context_internal() as context;

  -- Another person's draft is never locked and is indistinguishable from a
  -- missing one.
  select draft.* into stored
  from vortex_page.form_drafts as draft
  where draft.draft_id = p_draft_id
    and draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.identity_id = scope.identity_id
    and draft.application_root_id = scope.application_root_id
  for update;
  if not found
    or stored.expires_at <= pg_catalog.clock_timestamp()
    or stored.form_id <> p_form_id
    or stored.flow_id is distinct from p_flow_id
    or stored.node_id is distinct from p_node_id
    or stored.subject_record_id is distinct from p_subject_record_id then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if stored.installation_release_revision <> scope.release_revision then
    return query select 'stale_installation'::text, null::jsonb;
    return;
  end if;

  if stored.revision <> p_expected_revision then
    return query select 'stale_revision'::text, null::jsonb;
    return;
  end if;

  touched_at := pg_catalog.clock_timestamp();
  update vortex_page.form_drafts as draft
  set field_values = p_field_values,
      validation_state = p_validation_state,
      revision = draft.revision + 1,
      updated_at = touched_at,
      expires_at = vortex_page.private_form_draft_expiry_internal(touched_at)
  where draft.draft_id = p_draft_id
  returning * into stored;

  perform vortex_page.private_form_draft_purge_internal(scope.organization_id, 100);

  return query select 'updated'::text,
    vortex_page.private_form_draft_to_json_internal(stored, 'active');
end
$function$;

-- Abandons one exact owned live draft at its expected revision and deletes it,
-- so no private input outlives the draft. Abandoning does not compare the
-- installation release, so a person can always close a draft that the active
-- installation has moved beyond. The result carries no values.
create function vortex_page.abandon_private_form_draft(
  p_draft_id uuid,
  p_expected_revision bigint
)
returns table (outcome text, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  stored vortex_page.form_drafts%rowtype;
begin
  if p_draft_id is null or not vortex_context.is_non_nil_uuid(p_draft_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Private form draft abandon command is invalid';
  end if;

  select context.* into strict scope
  from vortex_page.private_form_draft_context_internal() as context;

  select draft.* into stored
  from vortex_page.form_drafts as draft
  where draft.draft_id = p_draft_id
    and draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.identity_id = scope.identity_id
    and draft.application_root_id = scope.application_root_id
  for update;
  if not found or stored.expires_at <= pg_catalog.clock_timestamp() then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if stored.revision <> p_expected_revision then
    return query select 'stale_revision'::text, null::jsonb;
    return;
  end if;

  delete from vortex_page.form_drafts as draft
  where draft.draft_id = p_draft_id;

  stored.revision := stored.revision + 1;
  stored.updated_at := pg_catalog.clock_timestamp();
  stored.field_values := '{}'::jsonb;
  stored.validation_state := '{}'::jsonb;

  return query select 'abandoned'::text,
    vortex_page.private_form_draft_to_json_internal(stored, 'abandoned');
end
$function$;

-- Deletes a bounded batch of the current organisation's drafts that reached
-- expiry, for a caller that wants to purge beyond the bounded purge each save
-- already performs. It returns only a count.
create function vortex_page.expire_private_form_drafts(p_limit integer default 500)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception using errcode = '22023',
      message = 'Private form draft expiry command is invalid';
  end if;

  checked := vortex_access.validated_human_request_context();
  if not vortex_context.is_non_nil_uuid(checked ->> 'organizationId') then
    raise exception using errcode = '42501',
      message = 'Private form draft scope is unavailable';
  end if;

  return vortex_page.private_form_draft_purge_internal(
    (checked ->> 'organizationId')::uuid,
    p_limit
  );
end
$function$;

revoke all on function vortex_page.private_form_draft_key_is_valid(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_page.private_form_draft_values_are_valid(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_page.private_form_draft_validation_is_valid(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_page.private_form_draft_to_json_internal(
  vortex_page.form_drafts, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_page.private_form_draft_context_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_page.private_form_draft_expiry_internal(timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_page.private_form_draft_purge_internal(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

revoke all on function vortex_page.read_private_form_draft(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_page.create_private_form_draft(
  uuid, uuid, uuid, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_page.update_private_form_draft(
  uuid, bigint, uuid, uuid, uuid, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_page.abandon_private_form_draft(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_page.expire_private_form_drafts(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_page.read_private_form_draft(uuid, uuid, uuid, uuid)
  to vortex_request;
grant execute on function vortex_page.create_private_form_draft(
  uuid, uuid, uuid, uuid, jsonb, jsonb
) to vortex_request;
grant execute on function vortex_page.update_private_form_draft(
  uuid, bigint, uuid, uuid, uuid, uuid, jsonb, jsonb
) to vortex_request;
grant execute on function vortex_page.abandon_private_form_draft(uuid, bigint)
  to vortex_request;
grant execute on function vortex_page.expire_private_form_drafts(integer)
  to vortex_request;

comment on function vortex_page.read_private_form_draft(uuid, uuid, uuid, uuid) is
  'Reads one exact live private form draft of the current person, rechecking the exact active installation before returning any value.';
comment on function vortex_page.create_private_form_draft(uuid, uuid, uuid, uuid, jsonb, jsonb) is
  'Creates revision 1 of a private form draft for the current person and exact active installation, or reports the scope is already held.';
comment on function vortex_page.update_private_form_draft(uuid, bigint, uuid, uuid, uuid, uuid, jsonb, jsonb) is
  'Compare-and-updates one exact owned live private form draft at its current revision, refusing a stale revision or replaced installation.';
comment on function vortex_page.abandon_private_form_draft(uuid, bigint) is
  'Abandons and deletes one exact owned live private form draft at its expected revision.';
comment on function vortex_page.expire_private_form_drafts(integer) is
  'Deletes a bounded batch of the current organisation''s private form drafts untouched for thirty days.';

commit;
