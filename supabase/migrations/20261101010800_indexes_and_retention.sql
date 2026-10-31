-- Indexes and retention (FIX-DB-SECURITY, review findings DT-10 to DT-14). DT-15 adds no index:
-- explain on a seeded lane shows permission_catalogue_entries_current_lookup_idx serving the
-- permission lookup, with no sequential scan.

set role vortex_owner;

-- DT-10: exact duplicates of unique indexes on the same columns.
drop index vortex_record.preview_storage_bindings_storage_idx;
drop index vortex_platform.event_outbox_record_sequence_lookup;

-- DT-11: the record-table creator provisions the owner index of the table's ownership mode, so a
-- group-owned table gets (organisation_id, owner_group_id) as an account-owned table gets
-- (organisation_id, owner_organisation_account_id). The catalogue trigger that built only the
-- account index (for every table, through the account-deletion fence too) goes.
create or replace function vortex_record.create_record_storage_table_internal(
  p_storage_contract_id uuid,
  p_module_root_id uuid,
  p_record_type_id uuid,
  p_storage_scope text,
  p_ownership_mode text,
  p_platform_references boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  table_token text;
  scope_index_columns text;
  scope_check text;
  owner_check text;
  organization_reference text := '';
  owner_references text := '';
begin
  if not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or p_storage_scope not in ('organization_shared', 'application_contained')
    or p_ownership_mode not in ('none', 'organization_account', 'group', 'inherited')
    or p_platform_references is null then
    raise exception using errcode = '22023', message = 'Record storage identity is invalid';
  end if;

  table_token := 'rt_' || pg_catalog.replace(
    pg_catalog.lower(p_storage_contract_id::text), '-', ''
  );
  scope_index_columns := case p_storage_scope
    when 'organization_shared' then 'organisation_id'
    else 'organisation_id, application_root_id'
  end;
  scope_check := case p_storage_scope
    when 'organization_shared' then 'application_root_id is null'
    else 'application_root_id is not null'
  end;
  owner_check := case p_ownership_mode
    when 'organization_account' then
      'owner_organisation_account_id is not null and owner_group_id is null'
    when 'group' then
      'owner_organisation_account_id is null and owner_group_id is not null'
    else 'owner_organisation_account_id is null and owner_group_id is null'
  end;
  -- Installed storage references the platform's organisation, account and Group rows. A
  -- preview's storage references none: a foreign key would lock those platform tables whenever
  -- the preview's table is created or dropped (dropping takes ACCESS EXCLUSIVE on every table it
  -- references), stopping every request of every organisation. The preview's own write paths
  -- keep its records inside the preview.
  if p_platform_references then
    organization_reference := ' references vortex_identity.organizations (organization_id)';
    owner_references := ',
      foreign key (organisation_id, owner_organisation_account_id)
        references vortex_identity.organization_accounts (organization_id, organization_account_id),
      foreign key (organisation_id, owner_group_id)
        references vortex_access.organization_groups (organization_id, group_id)';
  end if;

  execute pg_catalog.format(
    'create table record_data.%I (
      organisation_id uuid not null%s,
      module_root_id uuid not null check (module_root_id = %L::uuid),
      record_type_id uuid not null check (record_type_id = %L::uuid),
      storage_contract_id uuid not null check (storage_contract_id = %L::uuid),
      record_id uuid not null,
      application_root_id uuid,
      definition_revision bigint not null check (definition_revision between 1 and 9007199254740991),
      owner_organisation_account_id uuid,
      owner_group_id uuid,
      lifecycle_state text not null check (lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')),
      concurrency_number bigint not null check (concurrency_number between 1 and 9007199254740991),
      created_at timestamptz not null,
      created_by uuid not null,
      updated_at timestamptz not null,
      updated_by uuid not null,
      deleted_at timestamptz,
      deleted_by uuid,
      removal_due_at timestamptz,
      primary key (%s, record_id)%s,
      check (%s), check (%s),
      check ((deleted_at is null) = (deleted_by is null)),
      check ((lifecycle_state = ''active'') = (deleted_at is null and deleted_by is null)),
      check (updated_at >= created_at)
    )', table_token, organization_reference, p_module_root_id, p_record_type_id,
    p_storage_contract_id, scope_index_columns, owner_references, scope_check, owner_check
  );
  -- The owner route of a restricted read is a stored predicate on the one owner column this
  -- ownership mode fills; the partial index serves that predicate and the owner's foreign key.
  if p_ownership_mode = 'organization_account' then
    execute pg_catalog.format(
      'create index %I on record_data.%I (organisation_id, owner_organisation_account_id)
         where owner_organisation_account_id is not null',
      'ix_' || table_token || '_owner', table_token
    );
  elsif p_ownership_mode = 'group' then
    execute pg_catalog.format(
      'create index %I on record_data.%I (organisation_id, owner_group_id)
         where owner_group_id is not null',
      'ix_' || table_token || '_owner', table_token
    );
  end if;
  execute pg_catalog.format('alter table record_data.%I enable row level security', table_token);
  execute pg_catalog.format('alter table record_data.%I force row level security', table_token);
  execute pg_catalog.format(
    'create policy record_select on record_data.%I for select to vortex_record_adapter using (
      organisation_id = (select vortex_platform.organization_id())
      and case when application_root_id is null then true
        else application_root_id = (select vortex_platform.application_root_id(true)) end
    )', table_token
  );
  execute pg_catalog.format(
    'create policy record_insert on record_data.%I for insert to vortex_record_adapter with check (
      organisation_id = (select vortex_platform.organization_id())
      and case when application_root_id is null then true
        else application_root_id = (select vortex_platform.application_root_id(true)) end
    )', table_token
  );
  execute pg_catalog.format(
    'create policy record_update on record_data.%I for update to vortex_record_adapter using (
      organisation_id = (select vortex_platform.organization_id())
      and case when application_root_id is null then true
        else application_root_id = (select vortex_platform.application_root_id(true)) end
    ) with check (
      organisation_id = (select vortex_platform.organization_id())
      and case when application_root_id is null then true
        else application_root_id = (select vortex_platform.application_root_id(true)) end
    )', table_token
  );
  execute pg_catalog.format(
    'create policy record_delete on record_data.%I for delete to vortex_record_adapter using (
      organisation_id = (select vortex_platform.organization_id())
      and case when application_root_id is null then true
        else application_root_id = (select vortex_platform.application_root_id(true)) end
    )', table_token
  );
  execute pg_catalog.format(
    'grant select, insert, update, delete on record_data.%I to vortex_record_adapter',
    table_token
  );
end
$function$;

alter function vortex_record.create_record_storage_table_internal(uuid,uuid,uuid,text,text,boolean) owner to vortex_owner;

revoke all on function vortex_record.create_record_storage_table_internal(uuid, uuid, uuid, text, text, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.create_record_storage_table_internal(uuid, uuid, uuid, text, text, boolean)
  to vortex_owner;
comment on function vortex_record.create_record_storage_table_internal(uuid, uuid, uuid, text, text, boolean) is
  'Creates one generated Record storage table with its fixed scope checks, the owner index of its ownership mode and request-adapter policies; installed storage references the platform organisation, account and Group rows, preview storage references no platform table.';

CREATE OR REPLACE FUNCTION vortex_record.ensure_account_deletion_fence_internal(p_physical_table_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  relation_id oid;
begin
  if p_physical_table_token is null
    or p_physical_table_token !~ '^rt_[a-f0-9]{32}$' then
    raise exception using errcode = '55000',
      message = 'Account-deletion fence storage is unavailable';
  end if;
  relation_id := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', p_physical_table_token)
  );
  if relation_id is null then
    raise exception using errcode = '55000',
      message = 'Account-deletion fence storage is unavailable';
  end if;

  execute pg_catalog.format(
    'grant select on record_data.%I to vortex_record_inventory', p_physical_table_token
  );
  if not exists (
    select 1 from pg_catalog.pg_policy as policy
    where policy.polrelid = relation_id
      and policy.polname = 'record_account_deletion_inventory'
  ) then
    execute pg_catalog.format(
      'create policy record_account_deletion_inventory on record_data.%I
         for select to vortex_record_inventory
         using (organisation_id = vortex_platform.organization_id())',
      p_physical_table_token
    );
  end if;

  execute pg_catalog.format(
    'drop trigger if exists record_owner_account_fence on record_data.%I',
    p_physical_table_token
  );
  execute pg_catalog.format(
    'create trigger record_owner_account_fence
       before insert or update of owner_organisation_account_id, organisation_id
       on record_data.%I
       for each row execute function vortex_access.fence_record_owner_account_target_internal()',
    p_physical_table_token
  );
end
$_$;
alter function vortex_record.ensure_account_deletion_fence_internal(text) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.ensure_account_deletion_fence_internal(p_physical_table_token text) IS 'Private provisioner for one Record table: inventory read policy and the ownership fence trigger.';

REVOKE ALL ON FUNCTION vortex_record.ensure_account_deletion_fence_internal(p_physical_table_token text) FROM PUBLIC;

drop trigger storage_catalogue_offboarding_owner_index on vortex_record.storage_catalogue;
drop function vortex_record.provision_offboarding_owner_index_internal();
drop function vortex_record.ensure_offboarding_owner_index_internal(text);

-- Existing tables: the owner index follows the ownership mode. A table whose mode fills no
-- account owner loses the always-empty account index; a group-owned table gains its group index.
do $backfill$
declare
  catalogue_row record;
  index_name text;
begin
  for catalogue_row in
    select distinct on (catalogue.physical_table_token)
      catalogue.physical_table_token as table_token,
      catalogue.record_type_definition ->> 'ownershipMode' as ownership_mode
    from vortex_record.storage_catalogue as catalogue
    where catalogue.physical_schema_token = 'record_data'
      and pg_catalog.to_regclass(
        pg_catalog.format('record_data.%I', catalogue.physical_table_token)
      ) is not null
    order by catalogue.physical_table_token, catalogue.state = 'active' desc
  loop
    index_name := 'ix_' || catalogue_row.table_token || '_owner';
    if catalogue_row.ownership_mode = 'organization_account' then
      execute pg_catalog.format(
        'create index if not exists %I on record_data.%I (organisation_id, owner_organisation_account_id)
           where owner_organisation_account_id is not null',
        index_name, catalogue_row.table_token
      );
    else
      execute pg_catalog.format('drop index if exists record_data.%I', index_name);
      if catalogue_row.ownership_mode = 'group' then
        execute pg_catalog.format(
          'create index %I on record_data.%I (organisation_id, owner_group_id)
             where owner_group_id is not null',
          index_name, catalogue_row.table_token
        );
      end if;
    end if;
  end loop;
end
$backfill$;

-- DT-12: the claim reads the outbox in (occurred_at, occurrence_id) order; deleting an occurrence
-- checks its progress rows by occurrence. Retention: the dispatcher wake-up deletes delivered
-- occurrences older than 30 days, so the immutability trigger lets that delete through.
create index event_outbox_claim_order on vortex_platform.event_outbox (occurred_at, occurrence_id);
create index consumer_occurrence_progress_occurrence_idx
  on vortex_platform.consumer_occurrence_progress (occurrence_id);

CREATE OR REPLACE FUNCTION vortex_platform.refuse_event_outbox_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- An occurrence is immutable evidence. Only retention removes one, and only once it is
  -- older than the 30-day delivery window event_dispatch_backlog_status trims after.
  if tg_op = 'DELETE'
    and old.occurred_at < pg_catalog.statement_timestamp() - interval '30 days' then
    return old;
  end if;
  raise exception using errcode = '23514', message = 'Event outbox evidence is immutable';
end
$$;

alter function vortex_platform.refuse_event_outbox_change() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_platform.refuse_event_outbox_change() FROM PUBLIC;

grant execute on function vortex_platform.refuse_event_outbox_change() to postgres;

create or replace function vortex_platform.event_dispatch_backlog_status()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- Matches the window refuse_event_outbox_change allows retention to delete after.
  retention_window constant interval := interval '30 days';
  maximum_trim constant integer := 500;
  trimmed uuid[];
  result jsonb;
begin
  -- Retention runs once per dispatcher wake-up, before the status read. An occurrence goes once
  -- it is older than the window, every consumer that claimed it acknowledged it (a terminally
  -- failed claim stays as operator evidence), and a later occurrence of the same record or
  -- installation exists, so the newest one keeps that subject's sequence. The batch is bounded
  -- and skips rows a concurrent claim holds; the rest goes on later wake-ups.
  select coalesce(pg_catalog.array_agg(candidate.occurrence_id), array[]::uuid[])
  into trimmed
  from (
    select occurrence.occurrence_id
    from vortex_platform.event_outbox as occurrence
    where occurrence.occurred_at < pg_catalog.statement_timestamp() - retention_window
      and exists (
        select 1 from vortex_platform.consumer_occurrence_progress as progress
        where progress.occurrence_id = occurrence.occurrence_id
      )
      and not exists (
        select 1 from vortex_platform.consumer_occurrence_progress as progress
        where progress.occurrence_id = occurrence.occurrence_id
          and progress.acknowledged_at is null
      )
      and exists (
        select 1 from vortex_platform.event_outbox as newer
        where newer.organization_id = occurrence.organization_id
          and newer.occurrence_kind = occurrence.occurrence_kind
          and newer.storage_contract_id is not distinct from occurrence.storage_contract_id
          and newer.sequence_application_root_id is not distinct from
            occurrence.sequence_application_root_id
          and newer.record_id is not distinct from occurrence.record_id
          and newer.record_sequence > occurrence.record_sequence
      )
    order by occurrence.occurred_at, occurrence.occurrence_id
    limit maximum_trim
    for update of occurrence skip locked
  ) as candidate;

  if pg_catalog.cardinality(trimmed) > 0 then
    delete from vortex_platform.consumer_occurrence_progress as progress
    where progress.occurrence_id = any (trimmed);
    delete from vortex_platform.event_outbox as occurrence
    where occurrence.occurrence_id = any (trimmed);
  end if;

  with pending as (
    select pg_catalog.min(occurrence.occurred_at) as oldest_occurred_at
    from vortex_platform.consumer_occurrence_progress as progress
    join vortex_platform.event_outbox as occurrence
      on occurrence.occurrence_id = progress.occurrence_id
    where progress.acknowledged_at is null
      and progress.terminally_failed_at is null
  ), failed as (
    select pg_catalog.count(*) as failure_count
    from (
      select 1
      from vortex_platform.consumer_occurrence_progress as progress
      where progress.terminally_failed_at is not null
      limit 1000000
    ) as bounded
  )
  select pg_catalog.jsonb_build_object(
    'oldestPendingAgeSeconds',
      case
        when pending.oldest_occurred_at is null then null
        else least(
          2592000,
          greatest(
            0,
            -- EXTRACT is SQL syntax, not a schema-qualifiable call; it always
            -- resolves from pg_catalog even under the empty search_path.
            pg_catalog.floor(
              extract(
                epoch from (pg_catalog.statement_timestamp() - pending.oldest_occurred_at)
              )
            )
          )
        )::integer
      end,
    'terminalFailureCount', failed.failure_count::integer
  )
  into result
  from pending, failed;
  return result;
end
$function$;

alter function vortex_platform.event_dispatch_backlog_status() owner to vortex_owner;

revoke all on function vortex_platform.event_dispatch_backlog_status()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_platform.event_dispatch_backlog_status() to vortex_runtime;

comment on function vortex_platform.event_dispatch_backlog_status() is
  'Called once per dispatcher wake-up: first deletes a bounded batch of delivered Event occurrences older than 30 days (every claim acknowledged, a later occurrence of the same subject kept), then returns the bounded, content-free delivery backlog: age in seconds of the oldest claimed occurrence not yet acknowledged or terminally failed, and the terminal failure count. Reveals no occurrence identity, consumer identity or payload.';

-- DT-13: the run history read is (organisation, application, newest first); retention deletes
-- runs finished more than 90 days ago on the recovery tick.
create index backend_runs_history
  on vortex_platform.backend_runs (organization_id, application_root_id, created_at desc);
create index backend_runs_finished on vortex_platform.backend_runs (finished_at)
  where finished_at is not null;

create or replace function vortex_platform.list_pending_backend_runs(p_limit integer)
returns setof uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  retention_window constant interval := interval '90 days';
  maximum_trim constant integer := 500;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Back-end run limit is invalid';
  end if;
  -- Retention runs once per recovery tick: a bounded batch of runs that finished more than
  -- 90 days ago leaves the history; the rest goes on later ticks.
  delete from vortex_platform.backend_runs as run
  where run.backend_run_id in (
    select finished.backend_run_id
    from vortex_platform.backend_runs as finished
    where finished.finished_at < pg_catalog.statement_timestamp() - retention_window
    order by finished.finished_at
    limit maximum_trim
    for update skip locked
  );
  return query
  select run.backend_run_id
  from vortex_platform.backend_runs as run
  where run.state = 'pending'
    or (run.state = 'running' and run.claimed_until < pg_catalog.statement_timestamp())
  order by run.created_at
  limit p_limit;
end
$function$;
alter function vortex_platform.list_pending_backend_runs(integer) owner to vortex_owner;

revoke all on function vortex_platform.list_pending_backend_runs(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.list_pending_backend_runs(integer) to vortex_runtime;

comment on function vortex_platform.list_pending_backend_runs(integer) is
  'The recovery tick: deletes a bounded batch of back-end runs finished more than 90 days ago, then lists the oldest pending or abandoned back-end runs.';

-- DT-14: foreign keys whose parent rows are deleted get a covering index.
create index event_outbox_storage_contract_idx on vortex_platform.event_outbox (storage_contract_id)
  where storage_contract_id is not null;
create index record_type_lifecycle_policies_storage_idx
  on vortex_record.record_type_lifecycle_policies (storage_contract_id);
create index record_reference_counters_storage_field_idx
  on vortex_record.record_reference_counters (storage_contract_id, field_id);
create index index_catalogue_storage_field_idx
  on vortex_record.index_catalogue (storage_contract_id, field_id);
create index grid_views_based_on_idx on vortex_platform.grid_views (based_on_view_id)
  where based_on_view_id is not null;

reset role;
