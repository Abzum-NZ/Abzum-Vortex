begin;

create or replace function vortex_context.is_non_nil_uuid(candidate text)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $function$
  select
    coalesce(
      candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and candidate <> '00000000-0000-0000-0000-000000000000',
      false
    )
$function$;

revoke execute on function vortex_context.is_non_nil_uuid(text)
  from public, anon, authenticated, service_role;
grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter,
    vortex_module_owner, vortex_access_owner, vortex_workflow_owner;
grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_file_owner;
grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_page_owner;

grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_operations_owner, vortex_search_owner;

comment on function vortex_context.is_non_nil_uuid(text) is
  'Accepts only a non-nil RFC UUID with a version nibble from 1 through 8 and an RFC variant nibble.';
create or replace function vortex_context.current_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  stored jsonb;
begin
  select established.context into stored
  from vortex_context.request_contexts as established
  where established.backend_pid = pg_catalog.pg_backend_pid()
    and established.transaction_id = pg_catalog.pg_current_xact_id_if_assigned();

  if stored is null then
    raise exception using errcode = '55000', message = 'Vortex request context is not established';
  end if;

  return vortex_context.validated(stored);
end
$function$;
revoke execute on function vortex_context.current_context()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_context.current_context()
  to vortex_request, vortex_record_adapter, vortex_search_owner,
    vortex_record_inventory_owner, vortex_connection_owner,
    vortex_identity_owner;

comment on function vortex_context.current_context() is
  'Returns the validated request context established in this transaction or fails closed when it is absent, expired or stale.';

alter function vortex_context.current_context() owner to postgres;
create or replace function vortex_context.organization_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select (vortex_context.current_context() ->> 'organizationId')::uuid
$function$;
revoke execute on function vortex_context.organization_id()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_context.organization_id()
  to vortex_request, vortex_record_adapter, vortex_search_owner,
    vortex_record_inventory_owner, vortex_connection_owner;

comment on function vortex_context.organization_id() is
  'Returns the organisation identifier from the validated request context.';

alter function vortex_context.organization_id() owner to postgres;
create or replace function vortex_operations.alert_signal_builder_key_is_valid(p_key text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_key is not null
    and pg_catalog.length(p_key) between 1 and 40
    and p_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
$function$;
revoke all on function vortex_operations.alert_signal_builder_key_is_valid(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_operations.alert_signal_builder_key_is_valid(text)
  to vortex_operations_owner;

comment on function vortex_operations.alert_signal_builder_key_is_valid(text) is
  'Private check for the contract builder-key shape used by alert service and owning-role fields.';

alter function vortex_operations.alert_signal_builder_key_is_valid(text)
  owner to postgres;
create or replace function vortex_operations.alert_signal_namespaced_key_is_valid(p_key text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_key is not null
    and pg_catalog.length(p_key) between 3 and 120
    and p_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$'
    and not exists (
      select 1
      from pg_catalog.unnest(pg_catalog.string_to_array(p_key, '.')) as part(value)
      where pg_catalog.length(part.value) > 40
    )
$function$;
revoke all on function vortex_operations.alert_signal_namespaced_key_is_valid(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_operations.alert_signal_namespaced_key_is_valid(text)
  to vortex_operations_owner;

comment on function vortex_operations.alert_signal_namespaced_key_is_valid(text) is
  'Private check for the contract namespaced-key shape used by alert code and runbook-reference fields.';

alter function vortex_operations.alert_signal_namespaced_key_is_valid(text)
  owner to postgres;
create or replace function vortex_operations.read_open_alert_signals(
  p_limit integer default 100
)
returns table (
  signal_id uuid,
  code text,
  severity text,
  affected_service text,
  deduplication_key text,
  owning_role text,
  runbook_reference text,
  occurrence_count bigint,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  state text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023',
      message = 'Operations alert signal read is invalid';
  end if;

  return query
    select signal.signal_id, signal.code, signal.severity, signal.affected_service,
      signal.deduplication_key, signal.owning_role, signal.runbook_reference,
      signal.occurrence_count, signal.first_seen_at, signal.last_seen_at, signal.state
    from vortex_operations.alert_signals as signal
    where signal.state = 'open'
    order by signal.last_seen_at desc, signal.signal_id
    limit p_limit;
end
$function$;
revoke all on function vortex_operations.read_open_alert_signals(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_operations.read_open_alert_signals(integer)
  to vortex_runtime;

comment on function vortex_operations.read_open_alert_signals(integer) is
  'Returns one bounded page of open Operations alert signals, most recently seen first.';

alter function vortex_operations.read_open_alert_signals(integer)
  owner to vortex_operations_owner;
create or replace function vortex_operations.record_alert_signal(
  p_code text,
  p_severity text,
  p_affected_service text,
  p_deduplication_key text,
  p_owning_role text,
  p_runbook_reference text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  observed_at timestamptz := pg_catalog.clock_timestamp();
  stored vortex_operations.alert_signals%rowtype;
begin
  if p_code is null or not vortex_operations.alert_signal_namespaced_key_is_valid(p_code)
    or p_severity is null
    or p_severity not in ('warning', 'error', 'critical')
    or p_affected_service is null
    or not vortex_operations.alert_signal_builder_key_is_valid(p_affected_service)
    or p_deduplication_key is null
    or pg_catalog.length(p_deduplication_key) not between 16 and 200
    or p_deduplication_key !~ '^[a-z0-9][a-z0-9._:-]*$'
    or p_owning_role is null
    or not vortex_operations.alert_signal_builder_key_is_valid(p_owning_role)
    or p_runbook_reference is null
    or not vortex_operations.alert_signal_namespaced_key_is_valid(p_runbook_reference) then
    raise exception using errcode = '22023',
      message = 'Operations alert signal is invalid';
  end if;

  insert into vortex_operations.alert_signals (
    signal_id, code, severity, affected_service, deduplication_key,
    owning_role, runbook_reference, occurrence_count, first_seen_at, last_seen_at, state
  ) values (
    pg_catalog.gen_random_uuid(), p_code, p_severity, p_affected_service,
    p_deduplication_key, p_owning_role, p_runbook_reference, 1, observed_at, observed_at,
    'open'
  )
  on conflict (deduplication_key) do update set
    code = excluded.code,
    severity = excluded.severity,
    affected_service = excluded.affected_service,
    owning_role = excluded.owning_role,
    runbook_reference = excluded.runbook_reference,
    occurrence_count = least(
      vortex_operations.alert_signals.occurrence_count + 1, 9007199254740991
    ),
    last_seen_at = greatest(
      vortex_operations.alert_signals.last_seen_at, excluded.last_seen_at
    ),
    state = 'open'
  returning * into stored;

  return pg_catalog.jsonb_build_object(
    'signalId', stored.signal_id,
    'code', stored.code,
    'severity', stored.severity,
    'affectedService', stored.affected_service,
    'deduplicationKey', stored.deduplication_key,
    'owningRole', stored.owning_role,
    'runbookReference', stored.runbook_reference,
    'occurrenceCount', stored.occurrence_count,
    'firstSeenAt', pg_catalog.to_char(stored.first_seen_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'lastSeenAt', pg_catalog.to_char(stored.last_seen_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'state', stored.state
  );
end
$function$;
revoke all on function vortex_operations.record_alert_signal(
  text, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_operations.record_alert_signal(
  text, text, text, text, text, text
) to vortex_runtime;

comment on function vortex_operations.record_alert_signal(
  text, text, text, text, text, text
) is
  'Validates one contract alert record and upserts it by deduplication key, incrementing the occurrence count, refreshing last-seen and reopening a resolved signal.';

alter function vortex_operations.record_alert_signal(text, text, text, text, text, text)
  owner to vortex_operations_owner;
create or replace function vortex_search.document_entries_are_valid(p_entries jsonb)
returns boolean
language sql immutable strict parallel safe security invoker set search_path = ''
as $function$
  select case
    when pg_catalog.jsonb_typeof(p_entries) <> 'array' then false
    else pg_catalog.jsonb_array_length(p_entries) <= 100
      and pg_catalog.pg_column_size(p_entries) <= 262144
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_entries) as entry(value)
        where pg_catalog.jsonb_typeof(entry.value) <> 'object'
          or not (entry.value ?& array['fieldId', 'priority', 'weight', 'text'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(entry.value)) <> 4
          or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') <> 'string'
          or (entry.value ->> 'fieldId') !~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          or pg_catalog.jsonb_typeof(entry.value -> 'priority') <> 'string'
          or pg_catalog.jsonb_typeof(entry.value -> 'weight') <> 'number'
          or pg_catalog.jsonb_typeof(entry.value -> 'text') <> 'string'
          or pg_catalog.length(entry.value ->> 'text') not between 1 and 4000
      )
      and (
        select pg_catalog.count(distinct entry.value ->> 'fieldId') = pg_catalog.count(*)
          and coalesce(pg_catalog.sum(pg_catalog.length(entry.value ->> 'text')), 0) <= 20000
        from pg_catalog.jsonb_array_elements(p_entries) as entry(value)
      )
  end;
$function$;

revoke all on function vortex_search.document_entries_are_valid(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_search.document_entries_are_valid(jsonb)
  to vortex_search_owner;

comment on function vortex_search.document_entries_are_valid(jsonb) is
  'Storage check for search document entries: bounded array of unique field entries with the exact entry shape, types and text sizes; ranking weights are derived by the runtime producer.';
create or replace function vortex_search.enforce_document_application_root()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application_root record;
begin
  if new.application_root_id is null then
    return new;
  end if;

  select root.organization_id, root.kind into application_root
  from vortex_definition.roots as root
  where root.root_id = new.application_root_id;

  if not found or application_root.kind <> 'application'
    or application_root.organization_id <> new.organization_id then
    raise exception using errcode = '23514',
      message = 'Search document application does not belong to the organisation';
  end if;

  return new;
end
$function$;
revoke execute on function vortex_search.enforce_document_application_root()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_search.enforce_document_application_root() is
  'Checks that a search document application root is an Application root belonging to the same organisation.';

alter function vortex_search.enforce_document_application_root()
  owner to postgres;
create or replace function vortex_search.put_document(
  p_organization_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_application_root_id uuid,
  p_source_record_version bigint,
  p_deleted boolean,
  p_entries jsonb,
  p_content_fingerprint text
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored vortex_search.documents%rowtype;
  next_entries jsonb := case when p_deleted then '[]'::jsonb else p_entries end;
  next_fingerprint text := case when p_deleted then null else p_content_fingerprint end;
begin
  if p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_record_type_id is null or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or p_record_id is null or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or (p_application_root_id is not null
      and not vortex_context.is_non_nil_uuid(p_application_root_id::text))
    or p_source_record_version is null
    or p_source_record_version not between 1 and 9007199254740991
    or p_deleted is null or p_entries is null then
    raise exception using errcode = '22023', message = 'Search document command is invalid';
  end if;

  -- The established request supplies the organisation; the caller only
  -- cross-checks it and cannot write into another organisation's index.
  if vortex_context.organization_id() is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Search document scope is unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', 'search_document',
      p_organization_id::text, p_record_type_id::text, p_record_id::text), 643)
  );

  select existing.* into stored
  from vortex_search.documents as existing
  where existing.organization_id = p_organization_id
    and existing.record_type_id = p_record_type_id
    and existing.record_id = p_record_id;

  if found then
    if stored.source_record_version > p_source_record_version then
      return query select 'ignored_older'::text;
      return;
    end if;
    if stored.source_record_version = p_source_record_version then
      if stored.deleted then
        return query select
          case when p_deleted then 'replayed' else 'ignored_deleted' end::text;
        return;
      end if;
      if stored.deleted = p_deleted
        and stored.entries = next_entries
        and stored.content_fingerprint is not distinct from next_fingerprint
        and stored.application_root_id is not distinct from p_application_root_id then
        return query select 'replayed'::text;
        return;
      end if;
    end if;
    update vortex_search.documents as existing
    set application_root_id = p_application_root_id,
        source_record_version = p_source_record_version,
        deleted = p_deleted,
        entries = next_entries,
        content_fingerprint = next_fingerprint,
        updated_at = pg_catalog.statement_timestamp()
    where existing.organization_id = p_organization_id
      and existing.record_type_id = p_record_type_id
      and existing.record_id = p_record_id;
    return query select case
      when stored.source_record_version = p_source_record_version then 'rebuilt'
      else 'replaced'
    end::text;
    return;
  end if;

  insert into vortex_search.documents (
    organization_id, record_type_id, record_id, application_root_id,
    source_record_version, document_schema_version, deleted, entries,
    content_fingerprint
  ) values (
    p_organization_id, p_record_type_id, p_record_id, p_application_root_id,
    p_source_record_version, 1, p_deleted, next_entries, next_fingerprint
  );
  return query select 'stored'::text;
end
$function$;
revoke execute on function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) to vortex_request;

comment on function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) is
  'Stores one built search document or deletion marker for the request organisation; an older source version never overwrites a newer one, and a same-version rebuild replaces changed content.';

alter function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) owner to vortex_search_owner;
-- The Operations writer's alert_signals identity check invokes is_non_nil_uuid;
-- Search validates its supplied identifiers and binds row access to the
-- established request organisation.
grant usage on schema vortex_context
  to vortex_operations_owner, vortex_search_owner;
-- Operations signals contain no customer or request data. The owner needs all
-- signal columns for bounded reads and RETURNING, all columns for first writes,
-- and only the mutable fields for duplicate-key updates.
grant select (
  signal_id, code, severity, affected_service, deduplication_key, owning_role,
  runbook_reference, occurrence_count, first_seen_at, last_seen_at, state
) on table vortex_operations.alert_signals to vortex_operations_owner;
grant insert (
  signal_id, code, severity, affected_service, deduplication_key, owning_role,
  runbook_reference, occurrence_count, first_seen_at, last_seen_at, state
) on table vortex_operations.alert_signals to vortex_operations_owner;
grant update (
  code, severity, affected_service, owning_role, runbook_reference,
  occurrence_count, last_seen_at, state
) on table vortex_operations.alert_signals to vortex_operations_owner;

create policy alert_signals_operations_owner_select
  on vortex_operations.alert_signals
  for select to vortex_operations_owner using (true);
create policy alert_signals_operations_owner_insert
  on vortex_operations.alert_signals
  for insert to vortex_operations_owner with check (true);
create policy alert_signals_operations_owner_update
  on vortex_operations.alert_signals
  for update to vortex_operations_owner using (true) with check (true);

-- Search documents remain scoped to the established request organisation,
-- including reads performed by the definer while it compares stored versions.
grant select (
  organization_id, record_type_id, record_id, application_root_id,
  source_record_version, document_schema_version, deleted, entries,
  content_fingerprint, updated_at
) on table vortex_search.documents to vortex_search_owner;
grant insert (
  organization_id, record_type_id, record_id, application_root_id,
  source_record_version, document_schema_version, deleted, entries,
  content_fingerprint
) on table vortex_search.documents to vortex_search_owner;
grant update (
  application_root_id, source_record_version, deleted, entries,
  content_fingerprint, updated_at
) on table vortex_search.documents to vortex_search_owner;

create policy documents_search_owner_select
  on vortex_search.documents
  for select to vortex_search_owner
  using (organization_id = vortex_context.organization_id());
create policy documents_search_owner_insert
  on vortex_search.documents
  for insert to vortex_search_owner
  with check (organization_id = vortex_context.organization_id());
create policy documents_search_owner_update
  on vortex_search.documents
  for update to vortex_search_owner
  using (organization_id = vortex_context.organization_id())
  with check (organization_id = vortex_context.organization_id());

commit;
