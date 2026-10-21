-- The organisation's application catalogue: every ordinary Application it owns with a published
-- version, the latest version and its release note, and the version installed now, if any.
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
  sort_sql text;
  keyset_sql text := '';
  after_text text;
  after_record_id uuid;
  comparison text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'key')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023',
      message = 'Application catalogue projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key = 'key' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
    exception when invalid_text_representation then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end;
  end if;

  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "key": {"sql": "root.key", "database": "text", "search": true},
      "name": {"sql": "(latest.application_address ->> 'name')", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
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

  comparison := case when p_direction = 'ascending' then '>' else '<' end;
  if p_after is not null then
    keyset_sql := case p_sort_key
      when 'key' then pg_catalog.format(
        ' and (root.key collate "C", root.root_id) %s ($3 collate "C", $4)', comparison)
      else pg_catalog.format(' and root.root_id %s $4', comparison) end;
  end if;
  sort_sql := case p_sort_key
    when 'key' then pg_catalog.format('root.key collate "C" %1$s, root.root_id %1$s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('root.root_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;

  return query execute $scan$
    select $1, root.root_id, root.current_release_revision,
      pg_catalog.jsonb_build_object(
        'key', root.key,
        'name', latest.application_address ->> 'name',
        'description', latest.compilation_output #>> '{canonical,content,description}',
        'latest_version', latest.release_version,
        'latest_release_note', latest.release_note,
        'published_at', latest.published_at,
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
        'status', case
          when installed.release_revision is null then 'available'
          when installed.release_revision < root.current_release_revision then 'update_available'
          else 'installed' end
      )
    from vortex_definition.roots as root
    join vortex_definition.releases as latest
      on latest.root_id = root.root_id
      and latest.release_revision = root.current_release_revision
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
      and root.application_origin_kind = 'ordinary'
      and root.current_release_revision is not null
      and ($2 is null or root.root_id = any($2))
      and latest.application_address ->> 'kind' = 'application'
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $5', sort_sql)
  using visible_organization_id, p_record_ids, after_text, after_record_id, p_limit,
    predicate_plan -> 'parameters';
end
$function$;

comment on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) is 'The organisation''s application catalogue: its ordinary Applications with a published version, the latest version and the installed one.';

revoke all on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;
