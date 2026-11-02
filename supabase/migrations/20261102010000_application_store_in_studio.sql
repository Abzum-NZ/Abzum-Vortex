-- STUDIO-APP-STORE (#3889): the App Store is a module of Studio; an application is created,
-- published, installed, upgraded, removed and deleted there, and every one of those is a flow.
--
-- 1. The one applications read lists a never-published application as a draft for builders and
--    adds the owner, publisher, version history, the roles, record types and records an
--    application holds, and whether a removed application keeps its data.
-- 2. purge_application removes, in one transaction, everything an ordinary application and the
--    modules it owns hold. The history tables refuse every delete except one made by the NOLOGIN
--    role vortex_history_purger. That role owns exactly two functions:
--    purge_application_history_rows_internal, the unchecked deletion that only the purger itself
--    can execute, and purge_application_history_internal, the checked one that only vortex_owner
--    may execute and that proves, whoever calls it, a permitted human request in the organisation,
--    the whole purge review (an ordinary application that is not the organisation default, has no
--    dependents and is not installed when only deleting) and the typed name. No setting, session,
--    other function or member of another role can become that role.
-- 3. The old App Store application (vortex.app.app_store) is removed with everything it held, by the
--    same purge steps, and the stored App Store address names the Studio system application. Its
--    release history names the old key, so it cannot be renamed in place. The Studio application
--    is published and installed by the shipped-release path (see the pull request's rollout step);
--    this migration lists the accounts and groups that held the old App Store role as notices so
--    they can be given the Studio user role, and an organisation whose default application was the
--    old App Store gets its Landing Zone as default.

do $role$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_history_purger') then
    create role vortex_history_purger nologin noinherit nobypassrls;
  end if;
end
$role$;
grant vortex_history_purger to postgres;
grant usage on schema vortex_access, vortex_definition to vortex_history_purger;
grant create on schema vortex_definition to vortex_history_purger;

-- The purge also deletes an application's record lifecycle effects, a table the record adapter
-- owns, so its owner role is granted exactly that delete.
set role vortex_record_adapter;
grant delete on vortex_record.record_lifecycle_command_effects to vortex_owner;
reset role;

-- vortex_owner holds the purger role only while the two purger-owned functions are created and
-- their grants are written; the membership is revoked below.
grant vortex_history_purger to vortex_owner with inherit true;
set role vortex_owner;

grant usage on schema vortex_platform, vortex_record to vortex_history_purger;
grant execute on function vortex_access.lock_application_installation_authority()
  to vortex_history_purger;
grant select, delete on vortex_access.organization_role_assignments to vortex_history_purger;
create policy organization_role_assignments_history_purger_select on vortex_access.organization_role_assignments for select to vortex_history_purger using (true);
create policy organization_role_assignments_history_purger_delete on vortex_access.organization_role_assignments for delete to vortex_history_purger using (true);
grant select, delete on vortex_access.organization_role_permission_entries to vortex_history_purger;
create policy organization_role_permission_entries_history_purger_select on vortex_access.organization_role_permission_entries for select to vortex_history_purger using (true);
create policy organization_role_permission_entries_history_purger_delete on vortex_access.organization_role_permission_entries for delete to vortex_history_purger using (true);
grant select, delete on vortex_access.organization_role_revisions to vortex_history_purger;
create policy organization_role_revisions_history_purger_select on vortex_access.organization_role_revisions for select to vortex_history_purger using (true);
create policy organization_role_revisions_history_purger_delete on vortex_access.organization_role_revisions for delete to vortex_history_purger using (true);
grant select, delete on vortex_access.organization_roles to vortex_history_purger;
create policy organization_roles_history_purger_select on vortex_access.organization_roles for select to vortex_history_purger using (true);
create policy organization_roles_history_purger_delete on vortex_access.organization_roles for delete to vortex_history_purger using (true);
grant select, delete on vortex_access.permission_continuities to vortex_history_purger;
create policy permission_continuities_history_purger_select on vortex_access.permission_continuities for select to vortex_history_purger using (true);
create policy permission_continuities_history_purger_delete on vortex_access.permission_continuities for delete to vortex_history_purger using (true);
grant select, delete on vortex_access.application_role_template_continuities to vortex_history_purger;
create policy application_role_template_continuities_history_purger_select on vortex_access.application_role_template_continuities for select to vortex_history_purger using (true);
create policy application_role_template_continuities_history_purger_delete on vortex_access.application_role_template_continuities for delete to vortex_history_purger using (true);
grant select, delete on vortex_access.permission_catalogue_entries to vortex_history_purger;
create policy permission_catalogue_entries_history_purger_select on vortex_access.permission_catalogue_entries for select to vortex_history_purger using (true);
create policy permission_catalogue_entries_history_purger_delete on vortex_access.permission_catalogue_entries for delete to vortex_history_purger using (true);
grant select, delete on vortex_access.permission_registration_revisions to vortex_history_purger;
create policy permission_registration_revisions_history_purger_select on vortex_access.permission_registration_revisions for select to vortex_history_purger using (true);
create policy permission_registration_revisions_history_purger_delete on vortex_access.permission_registration_revisions for delete to vortex_history_purger using (true);
grant select, delete on vortex_access.permission_registrations to vortex_history_purger;
create policy permission_registrations_history_purger_select on vortex_access.permission_registrations for select to vortex_history_purger using (true);
create policy permission_registrations_history_purger_delete on vortex_access.permission_registrations for delete to vortex_history_purger using (true);
grant select, delete on vortex_platform.event_outbox to vortex_history_purger;
create policy event_outbox_history_purger_select on vortex_platform.event_outbox for select to vortex_history_purger using (true);
create policy event_outbox_history_purger_delete on vortex_platform.event_outbox for delete to vortex_history_purger using (true);
grant select, delete on vortex_definition.release_dependencies to vortex_history_purger;
create policy release_dependencies_history_purger_select on vortex_definition.release_dependencies for select to vortex_history_purger using (true);
create policy release_dependencies_history_purger_delete on vortex_definition.release_dependencies for delete to vortex_history_purger using (true);
grant select, delete on vortex_definition.releases to vortex_history_purger;
create policy releases_history_purger_select on vortex_definition.releases for select to vortex_history_purger using (true);
create policy releases_history_purger_delete on vortex_definition.releases for delete to vortex_history_purger using (true);
grant select, delete on vortex_definition.source_identity_aliases to vortex_history_purger;
create policy source_identity_aliases_history_purger_select on vortex_definition.source_identity_aliases for select to vortex_history_purger using (true);
create policy source_identity_aliases_history_purger_delete on vortex_definition.source_identity_aliases for delete to vortex_history_purger using (true);
grant select, delete on vortex_definition.source_identities to vortex_history_purger;
create policy source_identities_history_purger_select on vortex_definition.source_identities for select to vortex_history_purger using (true);
create policy source_identities_history_purger_delete on vortex_definition.source_identities for delete to vortex_history_purger using (true);
grant select on vortex_definition.roots to vortex_history_purger;
create policy roots_history_purger_select on vortex_definition.roots for select to vortex_history_purger using (true);
grant select on vortex_record.storage_catalogue to vortex_history_purger;
create policy storage_catalogue_history_purger_select on vortex_record.storage_catalogue for select to vortex_history_purger using (true);

CREATE OR REPLACE FUNCTION vortex_access.protect_application_role_template_continuity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Application role template continuity cannot be deleted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.application_root_id is distinct from old.application_root_id
    or new.source_role_id is distinct from old.source_role_id
    or old.last_processed_registration_revision = 9007199254740991
    or new.last_processed_registration_revision <= old.last_processed_registration_revision
    or new.continuity_revision not in (
      old.continuity_revision,
      old.continuity_revision + 1
    )
    or (
      new.continuity_revision = old.continuity_revision
      and new.state is distinct from old.state
    )
    or (
      new.continuity_revision = old.continuity_revision + 1
      and new.state is not distinct from old.state
    ) then
    raise exception using errcode = '23514',
      message = 'Application role template continuity transition is invalid';
  end if;

  return new;
end;
$$;

alter function vortex_access.protect_application_role_template_continuity() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.protect_application_role_template_continuity() FROM PUBLIC;

grant execute on function vortex_access.protect_application_role_template_continuity() to postgres;

CREATE OR REPLACE FUNCTION vortex_access.protect_organization_role_assignment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization role assignments cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role assignment revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.state <> 'revoked'
    or new.revoked_at is null
    or new.revoked_at < old.changed_at
    or new.organization_id is distinct from old.organization_id
    or new.role_assignment_id is distinct from old.role_assignment_id
    or new.role_id is distinct from old.role_id
    or new.assignee_kind is distinct from old.assignee_kind
    or new.organization_account_id is distinct from old.organization_account_id
    or new.group_id is distinct from old.group_id
    or new.starts_at is distinct from old.starts_at
    or new.expires_at is distinct from old.expires_at
    or new.granted_by is distinct from old.granted_by
    or new.granted_at is distinct from old.granted_at
    or new.grant_correlation_id is distinct from old.grant_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id) then
    raise exception using errcode = '23514',
      message = 'Organization role assignment transition is invalid';
  end if;

  return new;
end
$$;

alter function vortex_access.protect_organization_role_assignment() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_role_assignment() FROM PUBLIC;

grant execute on function vortex_access.protect_organization_role_assignment() to postgres;

CREATE OR REPLACE FUNCTION vortex_access.refuse_organization_role_history_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
  raise exception using errcode = '23514', message = 'Organization role history is immutable';
end;
$$;

alter function vortex_access.refuse_organization_role_history_mutation() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.refuse_organization_role_history_mutation() FROM PUBLIC;

grant execute on function vortex_access.refuse_organization_role_history_mutation() to postgres;

CREATE OR REPLACE FUNCTION vortex_access.protect_organization_role_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Organization roles cannot be deleted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.role_id is distinct from old.role_id
    or new.role_kind is distinct from old.role_kind
    or new.application_root_id is distinct from old.application_root_id
    or new.source_role_id is distinct from old.source_role_id
    or new.derived_application_root_id is distinct from old.derived_application_root_id
    or new.derived_source_role_id is distinct from old.derived_source_role_id
    or new.derived_source_definition_key is distinct from old.derived_source_definition_key
    or new.derived_source_release_revision is distinct from old.derived_source_release_revision
    or new.derived_source_release_version is distinct from old.derived_source_release_version
    or new.derived_source_validation_contract_version is distinct
      from old.derived_source_validation_contract_version
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or old.live_revision = 9007199254740991
    or new.live_revision <> old.live_revision + 1 then
    raise exception using errcode = '23514',
      message = 'Organization role updates require one permanent-identity revision';
  end if;

  return new;
end;
$$;

alter function vortex_access.protect_organization_role_identity() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_role_identity() FROM PUBLIC;

grant execute on function vortex_access.protect_organization_role_identity() to postgres;

CREATE OR REPLACE FUNCTION vortex_access.protect_permission_continuity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  meaning_changed boolean := false;
  must_advance boolean;
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Permission continuity cannot be deleted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.application_root_id is distinct from old.application_root_id
    or new.owner_kind is distinct from old.owner_kind
    or new.owner_id is distinct from old.owner_id
    or new.permission_id is distinct from old.permission_id
    or new.registration_kind is distinct from old.registration_kind
    or new.registration_owner_id is distinct from old.registration_owner_id
    or old.last_processed_registration_revision = 9007199254740991
    or new.last_processed_registration_revision <= old.last_processed_registration_revision then
    raise exception using errcode = '23514', message = 'Permission continuity transition is invalid';
  end if;

  if old.state = 'available' and new.state = 'available' then
    select not vortex_access.permission_meaning_is_same_internal(previous, current_entry)
    into meaning_changed
    from vortex_access.permission_catalogue_entries as previous
    join vortex_access.permission_catalogue_entries as current_entry
      on current_entry.organization_id = previous.organization_id
      and current_entry.registration_kind = previous.registration_kind
      and current_entry.registration_owner_id = previous.registration_owner_id
      and current_entry.application_root_id is not distinct from previous.application_root_id
      and current_entry.owner_kind = previous.owner_kind
      and current_entry.owner_id = previous.owner_id
      and current_entry.permission_id = previous.permission_id
      and current_entry.registration_revision = new.last_processed_registration_revision
    where previous.organization_id = old.organization_id
      and previous.registration_kind = old.registration_kind
      and previous.registration_owner_id = old.registration_owner_id
      and previous.registration_revision = old.last_processed_registration_revision
      and previous.application_root_id is not distinct from old.application_root_id
      and previous.owner_kind = old.owner_kind and previous.owner_id = old.owner_id
      and previous.permission_id = old.permission_id;
    if not found then
      raise exception using errcode = '23514', message = 'Permission continuity meaning is unavailable';
    end if;
  end if;

  must_advance := old.state is distinct from new.state or meaning_changed;
  if (must_advance and (old.continuity_revision = 9007199254740991
      or new.continuity_revision <> old.continuity_revision + 1))
    or (not must_advance and new.continuity_revision <> old.continuity_revision) then
    raise exception using errcode = '23514', message = 'Permission continuity transition is invalid';
  end if;
  return new;
end;
$$;

alter function vortex_access.protect_permission_continuity() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.protect_permission_continuity() FROM PUBLIC;

grant execute on function vortex_access.protect_permission_continuity() to postgres;

CREATE OR REPLACE FUNCTION vortex_access.refuse_permission_registration_history_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
  raise exception using errcode = '23514', message = 'Permission registration history is immutable';
end
$$;

alter function vortex_access.refuse_permission_registration_history_mutation() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.refuse_permission_registration_history_mutation() FROM PUBLIC;

grant execute on function vortex_access.refuse_permission_registration_history_mutation() to postgres;

CREATE OR REPLACE FUNCTION vortex_access.protect_permission_registration() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Permission registrations cannot be deleted';
  end if;
  if new.organization_id is distinct from old.organization_id
    or new.registration_kind is distinct from old.registration_kind
    or new.registration_owner_id is distinct from old.registration_owner_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at then
    raise exception using errcode = '23514', message = 'Permission registration updates require one permanent-scope revision';
  end if;
  return new;
end
$$;

alter function vortex_access.protect_permission_registration() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.protect_permission_registration() FROM PUBLIC;

grant execute on function vortex_access.protect_permission_registration() to postgres;

CREATE OR REPLACE FUNCTION vortex_definition.refuse_release_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
  raise exception using
    errcode = '23514',
    message = 'Definition releases and dependency manifests are append-only';
end
$$;

alter function vortex_definition.refuse_release_mutation() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_definition.refuse_release_mutation() FROM PUBLIC;

grant execute on function vortex_definition.refuse_release_mutation() to postgres;

CREATE OR REPLACE FUNCTION vortex_definition.refuse_source_identity_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
  raise exception using
    errcode = '23514',
    message = 'Definition source identities and aliases are append-only';
end
$$;

alter function vortex_definition.refuse_source_identity_mutation() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_definition.refuse_source_identity_mutation() FROM PUBLIC;

grant execute on function vortex_definition.refuse_source_identity_mutation() to postgres;

CREATE OR REPLACE FUNCTION vortex_platform.refuse_event_outbox_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Only the history purge role may delete these rows; it owns one function and nothing else.
  if tg_op = 'DELETE' and current_user = 'vortex_history_purger' then
    return old;
  end if;
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

-- The records an application and the modules it owns hold, counted up to a bound, for the
-- applications read to show what an installed or removed application keeps.
create or replace function vortex_definition.application_record_count_internal(
  p_application_root_id uuid
)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  storage_row record;
  total bigint := 0;
  counted bigint;
begin
  for storage_row in
    select catalogue.physical_table_token
    from vortex_record.storage_catalogue as catalogue
    join vortex_definition.roots as module on module.root_id = catalogue.module_root_id
    where catalogue.physical_schema_token = 'record_data'
      and (module.root_id = p_application_root_id
        or module.owner_application_root_id = p_application_root_id)
  loop
    if pg_catalog.to_regclass(pg_catalog.format('record_data.%I', storage_row.physical_table_token))
      is null then
      continue;
    end if;
    execute pg_catalog.format(
      'select pg_catalog.count(*) from (select 1 from record_data.%I limit 100000) as bounded',
      storage_row.physical_table_token) into counted;
    total := total + counted;
  end loop;
  return total;
end
$function$;

revoke all on function vortex_definition.application_record_count_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.application_record_count_internal(uuid)
  to vortex_owner;
comment on function vortex_definition.application_record_count_internal(uuid) is
  'Counts, up to 100000 per record table, the records one application and the modules it owns hold; for the applications read, which has already limited its rows to one organisation.';
alter function vortex_definition.application_record_count_internal(uuid) owner to vortex_owner;

-- The organisation's application catalogue: every Application it has, ordinary or a platform
-- system application, with its latest published version, the version installed now if any, and
-- whether it is the organisation's default application. An application that was never published
-- is listed as a draft, for a builder only. Studio's App Store section, the Landing Zone's
-- application tiles and organisation administration's installed applications all read this one
-- projection, so the surfaces cannot disagree about which applications exist or which versions
-- are installed and waiting.
create or replace function vortex_access.list_application_store_entries_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer
set search_path = ''
set max_parallel_workers_per_gather = 0
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  sort_column text;
  sort_sql text;
  keyset_sql text := '';
  after_text text;
  after_revision bigint;
  after_record_id uuid;
  comparison text;
  predicate_plan jsonb;
  name_sql constant text :=
    $name$coalesce(latest.application_address ->> 'name', nullif(pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name'), ''), root.key)$name$;
  status_sql constant text :=
    $status$(case when installed.release_revision is null then (case when root.current_release_revision is null then 'draft_only' else 'available' end) when installed.release_revision < root.current_release_revision then 'update_available' else 'installed' end)$status$;
  order_sql constant text :=
    $order$((case when root.application_origin_kind = 'platform_system_application' then '0/' else '1/' end) || coalesce(latest.application_address ->> 'name', nullif(pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name'), ''), root.key))$order$;
  builder_visible boolean := false;
begin
  if p_sort_key not in ('record_id', 'key', 'name', 'release_revision', 'status', 'listing_order')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key not in ('record_id', 'key') and p_limit is null) then
    raise exception using errcode = '22023',
      message = 'Application catalogue projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0)
          not in ('string', 'null')
      )) then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if p_sort_key = 'release_revision' then
        after_revision := after_text::bigint;
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end;
    if p_sort_key <> 'record_id' and after_text is null then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end if;
  end if;

  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    pg_catalog.format($declared${
      "key": {"sql": "root.key", "database": "text", "filter": true, "search": true},
      "name": {"sql": %s, "database": "text", "filter": true, "search": true},
      "release_revision": {"sql": "installed.release_revision", "database": "integer", "filter": true},
      "is_default": {"sql": "(root.root_id is not distinct from (select default_settings.default_application_root_id from vortex_identity.organization_runtime_settings as default_settings where default_settings.organization_id = root.organization_id))", "database": "boolean", "filter": true},
      "is_system_application": {"sql": "(root.application_origin_kind = 'platform_system_application')", "database": "boolean", "filter": true},
      "status": {"sql": %s, "database": "text", "filter": true}
    }$declared$, pg_catalog.to_json(name_sql)::text, pg_catalog.to_json(status_sql)::text)::jsonb,
    6
  );
  begin
    context_value := vortex_access.validated_human_request_context();
  exception when insufficient_privilege then
    return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform 1 from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    );
  exception when sqlstate '42501' or sqlstate 'P0002' then
    return;
  end;
  -- A draft that was never published is the builders' business only.
  begin
    perform vortex_definition.validated_builder_read_context_internal();
    builder_visible := true;
  exception when sqlstate '42501' then
    builder_visible := false;
  end;

  sort_column := case p_sort_key
    when 'key' then 'root.key'
    when 'name' then name_sql
    when 'status' then status_sql
    when 'listing_order' then order_sql
    when 'release_revision' then 'installed.release_revision'
    else 'root.root_id' end;
  comparison := case when p_direction = 'ascending' then '>' else '<' end;
  if p_after is not null then
    if p_sort_key = 'record_id' then
      keyset_sql := pg_catalog.format(' and root.root_id %s $4', comparison);
    elsif p_sort_key = 'release_revision' then
      keyset_sql := pg_catalog.format(
        ' and (installed.release_revision, root.root_id) %s ($3::bigint, $4)',
        comparison);
    else
      keyset_sql := pg_catalog.format(
        ' and ((%s collate "C", root.root_id) %s ($3 collate "C", $4))', sort_column, comparison);
    end if;
  end if;
  sort_sql := pg_catalog.format('%s%s %s, %s %s',
    sort_column,
    case when p_sort_key in ('key', 'name', 'status', 'listing_order') then ' collate "C"' else '' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end,
    'root.root_id',
    case when p_direction = 'ascending' then 'asc' else 'desc' end);
  if p_sort_key = 'record_id' then
    sort_sql := pg_catalog.format('root.root_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end);
  end if;

  return query execute $scan$
    select $1, root.root_id, coalesce(root.current_release_revision, 1),
      pg_catalog.jsonb_build_object(
        'key', root.key,
        'name', $scan$ || name_sql || $scan$,
        'listing_order', $scan$ || order_sql || $scan$,
        'icon', coalesce(latest.application_address ->> 'icon', draft.draft_source -> 'body' ->> 'icon'),
        'is_system_application',
          root.application_origin_kind = 'platform_system_application',
        'owner_type', case when root.application_origin_kind = 'platform_system_application'
          then 'system' else 'organisation' end,
        'description', coalesce(
          latest.compilation_output #>> '{canonical,content,description}',
          draft.draft_source -> 'body' ->> 'description'),
        'latest_version', latest.release_version,
        'latest_release_note', latest.release_note,
        'published_at', latest.published_at,
        'published_by_name', publisher.display_name,
        'release_history', history.lines,
        'role_count', (
          select pg_catalog.count(*) from vortex_access.organization_roles as role_row
          where role_row.organization_id = root.organization_id
            and (role_row.application_root_id = root.root_id
              or role_row.derived_application_root_id = root.root_id)),
        -- The count scans the application's record tables, so only the read of one application (its
        -- detail page) makes it; a list of applications does not.
        'records_held', case when $2 is null then null
          else vortex_definition.application_record_count_internal(root.root_id) end,
        'data_kept', case when $2 is null or root.application_origin_kind = 'platform_system_application' then null
          else (installed.release_revision is null
            and root.current_release_revision is not null
            and vortex_definition.application_record_count_internal(root.root_id) > 0) end,
        'record_type_count', (
          select pg_catalog.count(*) from vortex_record.storage_catalogue as storage
          where storage.state = 'active'
            and storage.module_root_id in (
              select module.root_id from vortex_definition.roots as module
              where module.owner_application_root_id = root.root_id)),
        'record_update_status', case
          when installed.release_revision is null then 'not_required'
          when backfill.occurrence_id is null then 'up_to_date'
          when backfill.terminally_failed_at is not null then 'failed'
          when backfill.acknowledged_at is not null or (
            (backfill.checkpoint ->> 'complete')::boolean
            and (backfill.checkpoint ->> 'releaseRevision')::bigint = installed.release_revision
          ) then 'up_to_date'
          when backfill.last_failure_code is not null then 'retrying'
          when backfill.claimed_at is null then 'pending'
          else 'updating' end,
        'records_processed', coalesce((backfill.checkpoint ->> 'processedCount')::bigint, 0),
        'installed_version', coalesce(installed.release_version, 'Not installed'),
        'release_revision', installed.release_revision,
        'is_default', root.root_id is not distinct from (
          select default_settings.default_application_root_id
          from vortex_identity.organization_runtime_settings as default_settings
          where default_settings.organization_id = root.organization_id),
        'status', $scan$ || status_sql || $scan$
      )
    from vortex_definition.roots as root
    left join vortex_definition.releases as latest
      on latest.root_id = root.root_id
      and latest.release_revision = root.current_release_revision
    left join vortex_definition.drafts as draft on draft.root_id = root.root_id
    left join vortex_identity.organization_accounts as publisher
      on publisher.organization_account_id = latest.published_by
      and publisher.organization_id = root.organization_id
    left join lateral (
      select pg_catalog.string_agg(
        entry.release_version || ' (' || pg_catalog.to_char(entry.published_at, 'YYYY-MM-DD') || ')'
          || case when entry.release_note = '' then '' else ': ' || entry.release_note end,
        E'\n' order by entry.release_revision desc) as lines
      from (
        select release.release_version, release.published_at, release.release_note,
          release.release_revision
        from vortex_definition.releases as release
        where release.root_id = root.root_id
        order by release.release_revision desc
        limit 10
      ) as entry
    ) as history on true
    left join lateral (
      select release.release_revision, release.release_version
      from vortex_access.permission_registrations as registration
      join vortex_definition.releases as release
        on release.root_id = root.root_id
        and release.release_revision = registration.source_revision
        and release.release_version = registration.source_version
        and release.validation_contract_version = registration.validation_contract_version
      where registration.organization_id = root.organization_id
        and registration.registration_owner_id = root.root_id
        and registration.registration_kind = 'application'
        and registration.state = 'active'
        and registration.source_definition_key = root.key
        and exists (
          select 1 from vortex_definition.installation_bindings as binding
          where binding.organization_id = root.organization_id
            and binding.application_root_id = root.root_id
            and binding.application_release_revision = registration.source_revision
            and binding.state = 'active'
        )
      limit 1
    ) as installed on true
    left join lateral (
      select occurrence.occurrence_id, progress.terminally_failed_at, progress.acknowledged_at,
        progress.claimed_at, progress.last_failure_code, progress.checkpoint
      from vortex_platform.event_outbox as occurrence
      left join vortex_platform.consumer_occurrence_progress as progress
        on progress.occurrence_id = occurrence.occurrence_id
        and progress.consumer_key = 'installation-derived-values'
      where occurrence.organization_id = root.organization_id
        and occurrence.sequence_application_root_id = root.root_id
        and occurrence.occurrence_kind = 'installation_activated'
        and occurrence.record_sequence <= installed.release_revision
      -- Surface the work that blocks this installation, including an older failed
      -- activation in front of the current one. Once caught up, show the latest result.
      order by (progress.acknowledged_at is null) desc,
        case when progress.acknowledged_at is null then occurrence.record_sequence end asc,
        occurrence.record_sequence desc
      limit 1
    ) as backfill on true
    where root.organization_id = $1
      and root.kind = 'application'
      and ($2 is null or root.root_id = any($2))
      and (
        (latest.release_revision is not null and latest.application_address ->> 'kind' = 'application')
        or (latest.release_revision is null and $7)
      )
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $5', sort_sql)
  using visible_organization_id, p_record_ids, after_text, after_record_id, p_limit,
    predicate_plan -> 'parameters', builder_visible;
end
$function$;

comment on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) is 'The organisation''s application catalogue: every Application it has, ordinary or platform system, a never-published one for builders only, with the latest version and its release note and history, who published it, the version installed now if any, whether it is the default application, and the release revision installed.';

revoke all on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

-- Everything that must hold before an application can be removed for good, proved in one place and
-- read by both the purge function and the history purge, so whoever calls either gets the same
-- proof: the application exists in the organisation and is ordinary (never a system application),
-- is not the organisation's default application, nothing else depends on it, an installed
-- application is not deleted, and, when a typed name is given, it equals the application's name.
-- It returns what the removal would take. It deletes nothing.
create or replace function vortex_definition.purge_application_review_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_delete_only boolean,
  p_confirmed_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  app_root record;
  module_ids uuid[];
  all_ids uuid[];
  role_ids uuid[];
  storage_row record;
  installed boolean;
  record_total bigint := 0;
  table_total bigint;
  table_count bigint := 0;
  role_count bigint;
  assignment_count bigint;
  entry_count bigint;
  release_count bigint;
  external_links bigint;
  application_name text;
begin
  if p_organization_id is null
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_delete_only is null then
    raise exception using errcode = '22023',
      message = 'Application purge command is invalid';
  end if;

  select root.root_id, root.key, root.application_origin_kind into app_root
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = p_organization_id
    and root.kind = 'application'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Application is unavailable';
  end if;
  if app_root.application_origin_kind <> 'ordinary' then
    raise exception using errcode = '42501',
      message = 'Only an ordinary application can be removed or deleted';
  end if;
  if exists (
    select 1 from vortex_identity.organization_runtime_settings as settings
    where settings.organization_id = p_organization_id
      and settings.default_application_root_id = p_application_root_id
  ) then
    raise exception using errcode = 'VX001',
      message = 'The organisation default application cannot be removed or deleted';
  end if;

  select coalesce(pg_catalog.array_agg(module.root_id), array[]::uuid[]) into module_ids
  from vortex_definition.roots as module
  where module.organization_id = p_organization_id
    and module.owner_application_root_id = p_application_root_id;
  all_ids := pg_catalog.array_append(module_ids, p_application_root_id);

  -- Another definition that was published against this one would lose what it pins.
  if exists (
    select 1 from vortex_definition.release_dependencies as dependency
    where dependency.target_root_id = any(all_ids) and dependency.root_id <> all(all_ids)
  ) then
    raise exception using errcode = 'VX002',
      message = 'Another application depends on this application';
  end if;

  select pg_catalog.bool_or(binding.state <> 'detached') into installed
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id;
  installed := coalesce(installed, false);
  if p_delete_only and installed then
    raise exception using errcode = 'VX003',
      message = 'An installed application cannot be deleted';
  end if;

  select coalesce(pg_catalog.array_agg(role_row.role_id), array[]::uuid[]) into role_ids
  from vortex_access.organization_roles as role_row
  where role_row.organization_id = p_organization_id
    and (role_row.application_root_id = p_application_root_id
      or role_row.derived_application_root_id = p_application_root_id);
  role_count := pg_catalog.cardinality(role_ids);
  select pg_catalog.count(*) into assignment_count
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = p_organization_id
    and assignment.role_id = any(role_ids);
  select pg_catalog.count(*) into entry_count
  from vortex_access.organization_role_permission_entries as entry
  where entry.organization_id = p_organization_id
    and (entry.role_id = any(role_ids) or entry.application_root_id = p_application_root_id);
  select pg_catalog.count(*) into release_count
  from vortex_definition.releases as release where release.root_id = p_application_root_id;
  application_name := coalesce((
      select release.application_address ->> 'name'
      from vortex_definition.roots as root
      join vortex_definition.releases as release
        on release.root_id = root.root_id
        and release.release_revision = root.current_release_revision
      where root.root_id = p_application_root_id),
    (select pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name')
      from vortex_definition.drafts as draft where draft.root_id = p_application_root_id),
    app_root.key);
  -- Links other applications keep into this one's records are removed with them, and counted.
  select pg_catalog.count(*) into external_links
  from vortex_record.relationship_edges as edge
  where edge.to_storage_contract_id in (
      select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
      where catalogue.module_root_id = any(all_ids))
    and edge.from_storage_contract_id not in (
      select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
      where catalogue.module_root_id = any(all_ids));

  for storage_row in
    select catalogue.storage_contract_id, catalogue.physical_table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = any(all_ids)
      and catalogue.physical_schema_token = 'record_data'
    order by catalogue.storage_contract_id
  loop
    table_count := table_count + 1;
    if pg_catalog.to_regclass(pg_catalog.format('record_data.%I', storage_row.physical_table_token))
      is not null then
      execute pg_catalog.format('select pg_catalog.count(*) from record_data.%I',
        storage_row.physical_table_token) into table_total;
      record_total := record_total + table_total;
    end if;
  end loop;

  if p_confirmed_name is not null
    and pg_catalog.btrim(p_confirmed_name) <> application_name then
    raise exception using errcode = 'VX004',
      message = 'The typed name does not match the application name';
  end if;

  return pg_catalog.jsonb_build_object(
    'application_name', application_name,
    'installed', installed,
    'external_links', external_links,
    'roles', role_count,
    'role_assignments', assignment_count,
    'permission_entries', entry_count,
    'releases', release_count,
    'records', record_total,
    'record_tables', table_count
  );
end
$function$;

revoke all on function vortex_definition.purge_application_review_internal(uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.purge_application_review_internal(uuid, uuid, boolean, text)
  to vortex_owner, vortex_history_purger;

comment on function vortex_definition.purge_application_review_internal(uuid, uuid, boolean, text) is
  'The proof every removal of an application needs, and what it would take: an ordinary application of the organisation, not the default application, nothing depending on it, not installed when only deleting, and the typed name when one is given. Deletes nothing.';

alter function vortex_definition.purge_application_review_internal(uuid, uuid, boolean, text) owner to vortex_owner;

-- The first deletion of an application (the history function runs it, and the migration that
-- converts the old App Store runs it as vortex_owner): everything that is not protected
-- history: records and their tables, drafts, bindings, runtime bundles, previews, runs, views,
-- files, access plans. It ends with the roots released so that the releases can go.
create or replace function vortex_definition.purge_application_rows_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  all_ids uuid[];
  storage_row record;
begin
  select pg_catalog.array_agg(root.root_id) into all_ids
  from vortex_definition.roots as root
  where root.organization_id = p_organization_id
    and (root.root_id = p_application_root_id
      or root.owner_application_root_id = p_application_root_id);

  delete from vortex_access.flow_run_evidence as evidence
  where evidence.organization_id = p_organization_id
    and evidence.application_root_id = p_application_root_id;
  delete from vortex_definition.form_drafts as form_draft
  where form_draft.organization_id = p_organization_id
    and form_draft.application_root_id = p_application_root_id;
  delete from vortex_platform.backend_runs as run
  where run.organization_id = p_organization_id
    and run.application_root_id = p_application_root_id;
  delete from vortex_platform.grid_views as view_row
  where view_row.organization_id = p_organization_id
    and view_row.application_root_id = p_application_root_id;
  delete from vortex_platform.file_records as file_row
  where file_row.organization_id = p_organization_id
    and file_row.application_root_id = p_application_root_id;
  delete from vortex_definition.preview_installations as preview
  where preview.organization_id = p_organization_id
    and preview.application_root_id = p_application_root_id;
  -- A preview of another draft that pinned this application, and its storage bindings.
  delete from vortex_definition.preview_releases as pinned where pinned.root_id = any(all_ids);
  delete from vortex_record.preview_storage_bindings as binding
  where binding.module_root_id = any(all_ids)
    or binding.storage_contract_id in (
      select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
      where catalogue.module_root_id = any(all_ids));

  delete from vortex_platform.consumer_occurrence_progress as progress
  where progress.occurrence_id in (
    select occurrence.occurrence_id from vortex_platform.event_outbox as occurrence
    where occurrence.organization_id = p_organization_id
      and (occurrence.sequence_application_root_id = p_application_root_id
        or occurrence.storage_contract_id in (
          select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
          where catalogue.module_root_id = any(all_ids))));

  delete from vortex_definition.installation_runtime_bundle_parts as part
  where part.organization_id = p_organization_id
    and part.application_root_id = p_application_root_id;
  delete from vortex_definition.installation_runtime_bundles as bundle
  where bundle.organization_id = p_organization_id
    and bundle.application_root_id = p_application_root_id;
  delete from vortex_definition.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id;
  delete from vortex_record.installation_access_plans as plan
  where plan.organization_id = p_organization_id
    and plan.application_root_id = p_application_root_id;

  delete from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = p_organization_id
    and effect.application_root_id = p_application_root_id;
  delete from vortex_record.documents as document
  where document.organization_id = p_organization_id
    and document.application_root_id = p_application_root_id;
  delete from vortex_record.record_type_lifecycle_policies as policy
  where policy.organization_id = p_organization_id
    and policy.application_root_id = p_application_root_id;
  for storage_row in
    select catalogue.storage_contract_id, catalogue.physical_table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = any(all_ids)
    order by catalogue.storage_contract_id
  loop
    delete from vortex_record.relationship_edges as edge
    where edge.from_storage_contract_id = storage_row.storage_contract_id
      or edge.to_storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.record_reference_counters as counter
    where counter.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.index_catalogue as index_row
    where index_row.storage_contract_id = storage_row.storage_contract_id;
    -- A lifecycle policy of any application that names this storage goes with it.
    delete from vortex_record.record_type_lifecycle_policies as policy
    where policy.storage_contract_id = storage_row.storage_contract_id;
    execute pg_catalog.format('drop table if exists record_data.%I', storage_row.physical_table_token);
    delete from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_row.storage_contract_id;
  end loop;
  delete from vortex_record.relationship_storage_mappings as mapping
  where mapping.module_root_id = any(all_ids);
  delete from vortex_record.release_provisions as provision
  where provision.module_root_id = any(all_ids);

  -- The roots stop naming a release so that the releases can go, and the drafts go first.
  update vortex_definition.roots as root
  set current_release_revision = null
  where root.root_id = any(all_ids);
  delete from vortex_definition.drafts as draft where draft.root_id = any(all_ids);
end
$function$;

revoke all on function vortex_definition.purge_application_rows_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.purge_application_rows_internal(uuid, uuid)
  to vortex_owner, vortex_history_purger;
alter function vortex_definition.purge_application_rows_internal(uuid, uuid) owner to vortex_owner;

-- Step 3 of removing an application, run as vortex_owner: the roots themselves, modules first.
create or replace function vortex_definition.purge_application_roots_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  delete from vortex_definition.roots as module
  where module.organization_id = p_organization_id
    and module.owner_application_root_id = p_application_root_id;
  delete from vortex_definition.roots as root
  where root.organization_id = p_organization_id and root.root_id = p_application_root_id;
end
$function$;

revoke all on function vortex_definition.purge_application_roots_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.purge_application_roots_internal(uuid, uuid)
  to vortex_owner;
alter function vortex_definition.purge_application_roots_internal(uuid, uuid) owner to vortex_owner;

-- Step 2 of removing an application: the protected history rows (roles, assignments, permission
-- entries, registrations, releases, dependencies, source identities, outbox). This unchecked
-- deletion is owned by the NOLOGIN role vortex_history_purger, the only role the history
-- protection lets delete, and only that role can execute it: purge_application_history_internal
-- reaches it after proving everything, and the migration that converts the old App Store
-- application runs it as the purger.
create or replace function vortex_definition.purge_application_history_rows_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  all_ids uuid[];
  role_ids uuid[];
begin
  select pg_catalog.array_agg(root.root_id) into all_ids
  from vortex_definition.roots as root
  where root.organization_id = p_organization_id
    and (root.root_id = p_application_root_id
      or root.owner_application_root_id = p_application_root_id);
  select coalesce(pg_catalog.array_agg(role_row.role_id), array[]::uuid[]) into role_ids
  from vortex_access.organization_roles as role_row
  where role_row.organization_id = p_organization_id
    and (role_row.application_root_id = p_application_root_id
      or role_row.derived_application_root_id = p_application_root_id);

  delete from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = p_organization_id and assignment.role_id = any(role_ids);
  delete from vortex_access.organization_role_permission_entries as entry
  where entry.organization_id = p_organization_id
    and (entry.role_id = any(role_ids) or entry.application_root_id = p_application_root_id);
  delete from vortex_access.organization_role_revisions as revision
  where revision.organization_id = p_organization_id and revision.role_id = any(role_ids);
  delete from vortex_access.organization_roles as role_row
  where role_row.organization_id = p_organization_id and role_row.role_id = any(role_ids);
  delete from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and (continuity.application_root_id = p_application_root_id
      or continuity.registration_owner_id = any(all_ids));
  delete from vortex_access.application_role_template_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id = p_application_root_id;
  delete from vortex_access.permission_catalogue_entries as catalogue_entry
  where catalogue_entry.organization_id = p_organization_id
    and (catalogue_entry.application_root_id = p_application_root_id
      or catalogue_entry.registration_owner_id = any(all_ids));
  delete from vortex_access.permission_registration_revisions as registration
  where registration.organization_id = p_organization_id
    and registration.registration_owner_id = any(all_ids);
  delete from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_owner_id = any(all_ids);
  delete from vortex_platform.event_outbox as occurrence
  where occurrence.organization_id = p_organization_id
    and (occurrence.sequence_application_root_id = p_application_root_id
      or occurrence.storage_contract_id in (
        select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
        where catalogue.module_root_id = any(all_ids)));
  delete from vortex_definition.release_dependencies as dependency
  where dependency.root_id = any(all_ids);
  delete from vortex_definition.releases as release where release.root_id = any(all_ids);
  delete from vortex_definition.source_identity_aliases as alias where alias.root_id = any(all_ids);
  delete from vortex_definition.source_identities as identity_row
  where identity_row.root_id = any(all_ids);
end
$function$;

alter function vortex_definition.purge_application_history_rows_internal(uuid, uuid)
  owner to vortex_history_purger;

revoke all on function vortex_definition.purge_application_history_rows_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter, vortex_owner;
grant execute on function vortex_definition.purge_application_history_rows_internal(uuid, uuid)
  to vortex_history_purger;

-- The checked deletion of an application's protected history. It is owned by the NOLOGIN role
-- vortex_history_purger, the only role the history protection lets delete, and is executable by
-- vortex_owner only. It proves everything itself, whoever calls it: a permitted human request in
-- the organisation, then the whole purge review (ordinary application, not the default, no
-- dependents, delete-only refused when installed) and the typed name. Only then does it delete:
-- first what is not history (records, tables, drafts, bindings), then the history itself.
create or replace function vortex_definition.purge_application_history_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_delete_only boolean,
  p_confirmed_name text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
begin
  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;
  if authority.organization_id is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Application purge organisation mismatch';
  end if;
  if p_confirmed_name is null then
    raise exception using errcode = 'VX004',
      message = 'The typed name does not match the application name';
  end if;
  perform vortex_definition.purge_application_review_internal(
    p_organization_id, p_application_root_id, p_delete_only, p_confirmed_name);
  -- Everything that is not protected history goes first: it releases the roots so that the
  -- releases can be deleted. The review above has already read the name it needs.
  perform vortex_definition.purge_application_rows_internal(
    p_organization_id, p_application_root_id);
  perform vortex_definition.purge_application_history_rows_internal(
    p_organization_id, p_application_root_id);
end
$function$;

alter function vortex_definition.purge_application_history_internal(uuid, uuid, boolean, text)
  owner to vortex_history_purger;

revoke all on function vortex_definition.purge_application_history_internal(uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.purge_application_history_internal(uuid, uuid, boolean, text)
  to vortex_owner;

comment on function vortex_definition.purge_application_history_internal(uuid, uuid, boolean, text) is
  'Deletes an ordinary application''s protected history rows. Owned by vortex_history_purger, the only role the history protection lets delete; executable by vortex_owner only. It proves a permitted human request in the organisation, the whole purge review and the typed name itself before it deletes.';

-- Counts, or with p_apply removes, everything one ordinary application and the modules it owns
-- hold in the validated organisation, in one transaction under the application installation
-- authority. The proof of what may be removed (purge_application_review_internal) and the
-- deletion of the protected history (purge_application_history_internal, owned by the only role
-- the history protection lets delete) both prove it again themselves; this function only
-- sequences them, then removes the roots and records the change.
create or replace function vortex_definition.purge_application(
  p_application_root_id uuid,
  p_apply boolean,
  p_delete_only boolean,
  p_confirmed_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  impact jsonb;
  context_value jsonb;
begin
  if p_application_root_id is null or p_apply is null or p_delete_only is null then
    raise exception using errcode = '22023',
      message = 'Application purge command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  -- Without a typed name this only reads; with p_apply the typed name is required and proved.
  impact := vortex_definition.purge_application_review_internal(
    authority.organization_id,
    p_application_root_id,
    p_delete_only,
    case when p_apply then coalesce(p_confirmed_name, '') else null end);
  if not p_apply then
    return impact;
  end if;

  perform vortex_definition.purge_application_history_internal(
    authority.organization_id, p_application_root_id, p_delete_only, p_confirmed_name);
  perform vortex_definition.purge_application_roots_internal(
    authority.organization_id, p_application_root_id);

  context_value := vortex_access.validated_human_request_context();
  perform vortex_access.increment_organization_access_version(
    authority.organization_id,
    authority.organization_account_id,
    authority.correlation_id,
    'application_access_changed'
  );
  perform vortex_record.append_organization_activity_entry(
    authority.organization_id,
    pg_catalog.gen_random_uuid(),
    pg_catalog.statement_timestamp(),
    'organization_account',
    authority.organization_account_id,
    case when p_delete_only then 'delete_application' else 'purge_application' end,
    array[p_application_root_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );

  return pg_catalog.jsonb_build_object(
    'roles', impact -> 'roles',
    'role_assignments', impact -> 'role_assignments',
    'permission_entries', impact -> 'permission_entries',
    'releases', impact -> 'releases',
    'records', impact -> 'records',
    'record_tables', impact -> 'record_tables'
  );
end
$function$;

revoke all on function vortex_definition.purge_application(uuid, boolean, boolean, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.purge_application(uuid, boolean, boolean, text)
  to vortex_request;

comment on function vortex_definition.purge_application(uuid, boolean, boolean, text) is
  'Counts, or with p_apply removes, everything one ordinary Application and the Modules it owns hold in the validated organisation, in one transaction under the application installation authority: the protected history through the one role allowed to delete it, then the roots. A system application, the default application and an application another one depends on are refused; p_delete_only also refuses an installed application; the typed name is required and proved to remove.';

alter function vortex_definition.purge_application(uuid, boolean, boolean, text) owner to vortex_owner;

reset role;
revoke create on schema vortex_definition from vortex_history_purger;
revoke vortex_history_purger from vortex_owner;

-- The old App Store application is removed with what it held and replaced by Studio. Who held its
-- role is listed first, so those accounts and groups can be given the Studio user role.
set role vortex_owner;
do $holders$
declare
  holder record;
begin
  for holder in
    select assignment.organization_id, assignment.assignee_kind,
      coalesce(assignment.organization_account_id, assignment.group_id) as assignee_id
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role_row
      on role_row.organization_id = assignment.organization_id
      and role_row.role_id = assignment.role_id
    join vortex_definition.roots as app
      on app.root_id = role_row.application_root_id
      and app.kind = 'application' and app.key = 'vortex.app.app_store'
    where assignment.revoked_at is null
    order by assignment.organization_id, assignment.assignee_kind, assignee_id
  loop
    raise notice 'former App Store role holder: organisation %, % %',
      holder.organization_id, holder.assignee_kind, holder.assignee_id;
  end loop;
end
$holders$;
update vortex_identity.organization_runtime_settings as settings
set default_application_root_id = (
  select landing.root_id from vortex_definition.roots as landing
  where landing.organization_id = settings.organization_id
    and landing.kind = 'application' and landing.key = 'vortex.app.landing_zone')
where settings.default_application_root_id in (
  select root.root_id from vortex_definition.roots as root
  where root.kind = 'application' and root.key = 'vortex.app.app_store');
update vortex_identity.organization_runtime_settings
set extension_values = pg_catalog.jsonb_set(extension_values, '{app_store_address}', '"vortex.app.studio"')
where extension_values ->> 'app_store_address' = 'vortex.app.app_store';
select vortex_definition.purge_application_rows_internal(root.organization_id, root.root_id)
from vortex_definition.roots as root
where root.kind = 'application' and root.key = 'vortex.app.app_store';
reset role;
set role vortex_history_purger;
select vortex_definition.purge_application_history_rows_internal(root.organization_id, root.root_id)
from vortex_definition.roots as root
where root.kind = 'application' and root.key = 'vortex.app.app_store';
reset role;
set role vortex_owner;
select vortex_definition.purge_application_roots_internal(root.organization_id, root.root_id)
from vortex_definition.roots as root
where root.kind = 'application' and root.key = 'vortex.app.app_store';
reset role;

set role vortex_owner;
-- The read pages by status and by its listing order (core applications first) as well.
update vortex_record.protected_read_model_views
set cursor_sort_keys = array['record_id', 'key', 'name', 'release_revision', 'status', 'listing_order']::text[]
where protected_read_model_key = 'application_store_entries';
reset role;

revoke vortex_history_purger from postgres;

reset role;
