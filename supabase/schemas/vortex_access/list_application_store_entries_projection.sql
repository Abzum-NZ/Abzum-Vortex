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
  exception when others then
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
    select $1, root.root_id, coalesce(root.current_release_revision, 0),
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
            and role_row.application_root_id = root.root_id),
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
