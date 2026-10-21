-- #3351: a record type's title field is always filterable; the bounded system-projection readers declare their title key filterable so a pasted link title resolves.

set local role vortex_owner;

create or replace function vortex_access.list_application_role_templates_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer
set search_path = ''
set enable_sort = off
set max_parallel_workers_per_gather = 0
as $function$
declare
  scope_row record;
  candidate record;
  template_value jsonb;
  selected_template jsonb;
  source_role_id_value uuid;
  seen_role_ids uuid[];
  valid_roles boolean;
  after_record_id uuid;
  after_text text;
  emitted integer := 0;
  page_limit integer := coalesce(p_limit, 40);
  scan_sql text;
  comparison text;
  sort_column text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'source_role_id', 'application_root_id', 'key', 'label')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or page_limit not between 1 and 200 then
    raise exception using errcode = '22023',
      message = 'Application role template projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key in ('source_role_id', 'key', 'label') and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0)
          not in ('string', 'null')
      )) then
      raise exception using errcode = '22023',
        message = 'Application role template projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023',
        message = 'Application role template projection cursor is invalid';
    end;
    after_text := p_after -> 'sortKey' ->> 0;
    if p_sort_key = 'source_role_id'
      and after_text is distinct from after_record_id::text then
      raise exception using errcode = '22023',
        message = 'Application role template projection cursor is invalid';
    end if;
  end if;

  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "application_root_id": {"sql": "continuity.application_root_id::text", "database": "text", "filter": true},
      "key": {"sql": "continuity.key", "database": "text", "search": true},
      "label": {"sql": "continuity.label", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    6
  );
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_roles_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;

  comparison := case when p_direction = 'ascending' then '>' else '<' end;
  sort_column := case p_sort_key
    when 'key' then 'continuity.key collate "C"'
    when 'label' then 'continuity.label collate "C"'
    else null end;
  scan_sql := $scan$
    select continuity.application_root_id, continuity.source_role_id,
      continuity.key, continuity.label, continuity.continuity_revision,
      registration.revision as registration_revision,
      release.compilation_output #> '{canonical,content,roles}' as roles
    from vortex_access.application_role_template_continuities as continuity
    join vortex_access.permission_registrations as registration
      on registration.organization_id = continuity.organization_id
      and registration.registration_owner_id = continuity.application_root_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and registration.revision = continuity.last_processed_registration_revision
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
    where continuity.organization_id = $1
      and continuity.state = 'available'
      and ($2 is null or continuity.source_role_id = any($2))
      and release.application_address ->> 'kind' = 'application'
      and release.compilation_output ->> 'kind' = 'application'
      and exists (
        select 1 from vortex_definition.installation_bindings as binding
        where binding.organization_id = $1
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '');
  if p_after is not null and p_sort_key in ('record_id', 'source_role_id') then
    scan_sql := scan_sql || pg_catalog.format(
      ' and continuity.source_role_id %s $3', comparison
    );
  elsif p_after is not null and sort_column is not null then
    if after_text is null then
      scan_sql := scan_sql || pg_catalog.format(
        ' and ((%1$s is null and continuity.source_role_id %2$s $3)%3$s)',
        sort_column, comparison,
        case when p_direction = 'ascending'
          then pg_catalog.format(' or %s is not null', sort_column)
          else '' end
      );
    else
      scan_sql := scan_sql || pg_catalog.format(
        ' and ((%1$s, continuity.source_role_id) %2$s ($4 collate "C", $3)%3$s)',
        sort_column, comparison,
        case when p_direction = 'descending'
          then pg_catalog.format(' or %s is null', sort_column)
          else '' end
      );
    end if;
  elsif p_after is not null then
    -- Only the delegating old signature uses this order without a cursor.
    raise exception using errcode = '22023',
      message = 'Application role template projection cursor is invalid';
  end if;
  scan_sql := scan_sql || case when p_sort_key in ('record_id', 'source_role_id')
    then pg_catalog.format(' order by continuity.source_role_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    when sort_column is not null then pg_catalog.format(
      ' order by %s %s nulls %s, continuity.source_role_id %s',
      sort_column,
      case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'first' else 'last' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format(
      ' order by continuity.application_root_id %s, continuity.source_role_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    end;
  -- No limit in the scan: a candidate whose release roles fail validation is skipped, as the
  -- legacy reader skipped it, so the loop reads on until the page is full (the scan is an
  -- ordered index walk, so only the rows consumed are read).

  for candidate in execute scan_sql using scope_row.organization_id, p_record_ids,
    after_record_id, after_text, p_limit, predicate_plan -> 'parameters'
  loop
    if pg_catalog.jsonb_typeof(candidate.roles) is distinct from 'array' then
      continue;
    end if;
    -- Keep in step with maximumApplicationRoles; p_limit remains the independent page bound.
    if pg_catalog.jsonb_array_length(candidate.roles) not between 1 and 500 then
      continue;
    end if;
    seen_role_ids := array[]::uuid[];
    valid_roles := true;
    selected_template := null;
    -- The entire registered array must be valid even when only one role is read.
    for template_value in
      select template.value
      from pg_catalog.jsonb_array_elements(candidate.roles) as template(value)
    loop
      if pg_catalog.jsonb_typeof(template_value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(template_value -> 'roleId') is distinct from 'string'
        or not vortex_platform.is_non_nil_uuid(template_value ->> 'roleId')
        or pg_catalog.jsonb_typeof(template_value -> 'key') is distinct from 'string'
        or pg_catalog.char_length(template_value ->> 'key') not between 1 and 40
        or (template_value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
        or pg_catalog.jsonb_typeof(template_value -> 'name') is distinct from 'string'
        or pg_catalog.char_length(template_value ->> 'name') not between 1 and 60 then
        valid_roles := false;
        exit;
      end if;
      source_role_id_value := (template_value ->> 'roleId')::uuid;
      if source_role_id_value = any(seen_role_ids)
        or not vortex_definition.application_role_identity_is_exact_for_human_request_internal(
          candidate.application_root_id, source_role_id_value
        ) then
        valid_roles := false;
        exit;
      end if;
      seen_role_ids := pg_catalog.array_append(seen_role_ids, source_role_id_value);
      if source_role_id_value = candidate.source_role_id then
        selected_template := template_value;
      end if;
    end loop;
    if not valid_roles or selected_template is null then
      continue;
    end if;
    return query select scope_row.organization_id,
      candidate.source_role_id, candidate.registration_revision,
      pg_catalog.jsonb_build_object(
        'application_root_id', candidate.application_root_id,
        'source_role_id', candidate.source_role_id,
        'key', candidate.key,
        'label', candidate.label,
        'continuity_revision', candidate.continuity_revision
      );
    emitted := emitted + 1;
    exit when emitted >= page_limit;
  end loop;
end
$function$;

revoke all on function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

comment on function vortex_access.list_application_role_templates_projection(
  uuid[], text, text, jsonb, integer, jsonb
) is 'Returns one keyset page of registered application role templates, defaulting to 40 rows and limited to 200 rows.';

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

create or replace function vortex_access.list_organization_activity_entries_projection(
  p_record_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer,
  p_predicate jsonb
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  actor_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean;
  person_record_type_id uuid;
  installation_plan jsonb;
  installation_record_types jsonb;
  after_occurred_at timestamptz;
  after_record_id uuid;
  keyset_sql text := '';
  base_sql text;
  source_sql text;
  order_sql text;
  scan_sql text;
  predicate_plan jsonb;
begin
  -- The action is the one filterable key (the record title); there is no searchable key.
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "action": {"sql": "entry.action", "database": "text", "filter": true}
    }$declared$::jsonb,
    10
  );
  if p_sort_key <> 'occurred_at' or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Activity projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) <> 'string'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Activity projection cursor is invalid';
    end if;
    begin
      after_occurred_at := (p_after -> 'sortKey' ->> 0)::timestamptz;
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Activity projection cursor is invalid';
    end;
    keyset_sql := case when p_direction = 'descending'
      then ' and (entry.occurred_at, entry.activity_id) < ($6, $7)'
      else ' and (entry.occurred_at, entry.activity_id) > ($6, $7)' end;
  end if;
  begin
    checked_context := vortex_access.validated_human_request_context();
    visible_organization_id := (checked_context ->> 'organizationId')::uuid;
    actor_identity_id := (checked_context ->> 'identityId')::uuid;
    actor_account_id := (checked_context ->> 'organizationAccountId')::uuid;
    perform 1 from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    );
  exception
    when insufficient_privilege or no_data_found then
      return;
  end;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.permissions.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.permissions.read'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = visible_organization_id
      and decision_account_id = actor_account_id,
    false
  );

  -- Use this request's validated live/preview installation, including its pins.
  installation_plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_current_active_installation()
  );
  select pg_catalog.jsonb_agg(installed.value) into installation_record_types
  from pg_catalog.jsonb_each(installation_plan -> 'recordTypes') as installed(key, value);
  person_record_type_id := vortex_access.resolve_installed_account_record_type_internal(
    installation_record_types
  );

  order_sql := pg_catalog.format(
    ' order by entry.occurred_at %s, entry.activity_id %s limit $8',
    case when p_direction = 'descending' then 'desc' else 'asc' end,
    case when p_direction = 'descending' then 'desc' else 'asc' end
  );
  base_sql := $scan$select entry.*
    from vortex_record.organization_activity_entries as entry
    where entry.organization_id = $1
      and entry.occurred_at >= pg_catalog.statement_timestamp() - interval '90 days'
      and ($2 is null or entry.activity_id = any($2))$scan$
    || coalesce(' and ' || (predicate_plan ->> 'predicate'), '');
  if audit_projection then
    source_sql := base_sql || keyset_sql || order_sql;
  else
    source_sql := 'select visible.* from (('
      || base_sql
      || ' and entry.actor_kind = ''organization_account'' and entry.actor_id = $4'
      || keyset_sql || order_sql
      || ') union all ('
      || base_sql
      || ' and entry.actor_kind = ''identity'' and entry.actor_id = $5'
      || keyset_sql || order_sql
      || ')) as visible'
      || pg_catalog.format(' order by visible.occurred_at %s, visible.activity_id %s limit $8',
        case when p_direction = 'descending' then 'desc' else 'asc' end,
        case when p_direction = 'descending' then 'desc' else 'asc' end);
  end if;
  scan_sql := $scan$select
    entry.organization_id,
    entry.activity_id,
    1::bigint,
    pg_catalog.jsonb_build_object(
      'organization_id', entry.organization_id::text,
      'revision', 1,
      'occurred_at', entry.occurred_at,
      'actor_kind', case entry.actor_kind
        when 'organization_account' then 'Person'
        when 'identity' then 'Platform operator'
        when 'system' then 'System'
        when 'public_session' then 'Public visitor'
        else 'Other' end,
      'actor', case when entry.actor_kind = 'organization_account'
        then pg_catalog.jsonb_build_object('recordTypeId', $9, 'recordId', entry.actor_id::text)
        else null end,
      'action', entry.action,
      'subject_count', pg_catalog.cardinality(entry.subject_ids),
      'changed_field_count', case when $3
        then pg_catalog.cardinality(entry.changed_field_ids) else null end
    )
  from ($scan$ || source_sql || $scan$) as entry$scan$
    || pg_catalog.format(' order by entry.occurred_at %s, entry.activity_id %s',
      case when p_direction = 'descending' then 'desc' else 'asc' end,
      case when p_direction = 'descending' then 'desc' else 'asc' end);
  return query execute scan_sql using visible_organization_id, p_record_ids,
    audit_projection, actor_account_id, actor_identity_id,
    after_occurred_at, after_record_id, p_limit, person_record_type_id,
    predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

create or replace function vortex_access.list_organization_group_memberships_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
  sort_column text;
  sort_kind text;
  sort_expression text;
  sort_null_expression text := 'false';
  candidate_joins text := '';
  direction_sql text;
  keyset_sql text := '';
  order_sql text;
  outer_order_sql text;
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'starts_at', 'expires_at', 'state', 'account_display_name')
    or p_sort_key is null or p_direction not in ('ascending', 'descending')
    or p_direction is null or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Membership projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'starts_at' then 'membership.starts_at'
    when 'expires_at' then 'membership.expires_at'
    when 'state' then 'membership.state'
    when 'account_display_name' then 'account.display_name'
    else 'membership.membership_id' end;
  sort_kind := case p_sort_key
    when 'starts_at' then 'time'
    when 'expires_at' then 'nullable_time'
    when 'state' then 'text'
    when 'account_display_name' then 'nullable_text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind = 'nullable_text' then
    -- A stored release can still request a sort dropped from current publishable definitions.
    candidate_joins := $joins$join vortex_identity.organization_accounts as account
      on account.organization_id = membership.organization_id
      and account.organization_account_id = membership.organization_account_id$joins$;
  end if;
  if sort_kind in ('nullable_time', 'nullable_text') then
    sort_expression := sort_column || case when sort_kind = 'nullable_text' then ' collate "C"' else '' end;
    order_sql := pg_catalog.format('%s %s nulls %s, membership.membership_id %s',
      sort_expression, direction_sql,
      case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value%s %s nulls %s, candidate.record_id %s',
      case when sort_kind = 'nullable_text' then ' collate "C"' else '' end,
      direction_sql, case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
  elsif sort_kind in ('text', 'legacy_text') then
    sort_expression := sort_column || ' collate "C"';
    order_sql := pg_catalog.format('%s %s, membership.membership_id %s', sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value collate "C" %s, candidate.record_id %s',
      direction_sql, direction_sql);
  else
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s, membership.membership_id %s',
      sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s, candidate.record_id %s',
      direction_sql, direction_sql);
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (sort_kind <> 'id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or (pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
          and (sort_kind not in ('nullable_time', 'nullable_text')
            or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'null'))
      )) then
      raise exception using errcode = '22023', message = 'Membership projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if sort_kind in ('time', 'nullable_time') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Membership projection cursor is invalid';
    end;
    if sort_kind = 'id' then
      keyset_sql := pg_catalog.format(' and membership.membership_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind in ('text', 'legacy_text') then
      keyset_sql := pg_catalog.format(' and (%s, membership.membership_id) %s ($3 collate "C", $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind in ('nullable_time', 'nullable_text') then
      keyset_sql := pg_catalog.format(case when p_direction = 'ascending' then
        ' and ((%1$s is null and (%2$s is not null or (%2$s is null and membership.membership_id > $4)))'
          || ' or (%1$s is not null and (%2$s, membership.membership_id) > (%3$s, $4)))'
        else
        ' and ((%1$s is null and %2$s is null and membership.membership_id < $4)'
          || ' or (%1$s is not null and (%2$s is null or (%2$s, membership.membership_id) < (%3$s, $4))))'
        end,
        case when sort_kind = 'nullable_time' then '$5' else '$3' end,
        sort_expression,
        case when sort_kind = 'nullable_time' then '$5' else '$3 collate "C"' end);
    else
      keyset_sql := pg_catalog.format(' and (%s, membership.membership_id) %s ($5, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "group_id": {"sql": "membership.group_id::text", "database": "text", "filter": true},
      "organization_account_id": {"sql": "membership.organization_account_id::text", "database": "text", "filter": true},
      "state": {"sql": "membership.state::text", "database": "text", "filter": true},
      "temporal_state": {"sql": "(case when membership.state = 'revoked' then 'revoked' when membership.starts_at > $7 then 'scheduled' when membership.expires_at is not null and membership.expires_at <= $7 then 'expired' else 'active' end)", "database": "text", "filter": true},
      "account_display_name": {"sql": "account.display_name", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    8
  );
  if predicate_plan ->> 'predicate' is not null then
    -- The predicate may read the account of a membership; the final select
    -- joins it the same way, so the candidate scan sees the same rows.
    candidate_joins := $joins$join vortex_identity.organization_accounts as account
      on account.organization_id = membership.organization_id
      and account.organization_account_id = membership.organization_account_id$joins$;
    keyset_sql := ' and ' || (predicate_plan ->> 'predicate') || keyset_sql;
  end if;
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_groups_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := pg_catalog.format($scan$
    with candidate as materialized (
      select membership.membership_id as record_id,
        %s as sort_value, %s as sort_null
      from vortex_access.organization_group_memberships as membership
      %s
      where membership.organization_id = $1
        and ($2 is null or membership.membership_id = any($2))
      %s
      order by %s limit $6
    )
    select membership.organization_id, membership.membership_id, membership.revision,
      pg_catalog.jsonb_build_object(
      'group_id', membership.group_id,
      'organization_account_id', membership.organization_account_id,
      'account_display_name', account.display_name,
      'starts_at', membership.starts_at,
      'expires_at', membership.expires_at,
      'state', membership.state,
      'temporal_state', case
        when membership.state = 'revoked' then 'revoked'
        when membership.starts_at > $7 then 'scheduled'
        when membership.expires_at is not null and membership.expires_at <= $7 then 'expired'
        else 'active' end
      )
    from candidate
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = $1 and membership.membership_id = candidate.record_id
    join vortex_identity.organization_accounts as account
      on account.organization_id = membership.organization_id
      and account.organization_account_id = membership.organization_account_id
    order by %s
  $scan$, sort_expression, sort_null_expression, candidate_joins, keyset_sql,
    order_sql, outer_order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_text, after_record_id, after_time, p_limit, checked_at, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer, jsonb) owner to vortex_owner;

create or replace function vortex_access.list_organization_groups_projection(
  p_record_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer,
  p_predicate jsonb
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_value text;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'key', 'label', 'state')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Group projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'key' then 'organization_group.group_key'
    when 'label' then 'organization_group.label'
    when 'state' then 'organization_group.state'
    else 'organization_group.group_id' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Group projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Group projection cursor is invalid';
    end;
    after_value := p_after -> 'sortKey' ->> 0;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and organization_group.group_id > $4'
        else ' and organization_group.group_id < $4' end;
    else
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", organization_group.group_id) %s ($3 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end
      );
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('organization_group.group_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s collate "C" %s, organization_group.group_id %s',
      sort_column, case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;

  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "state": {"sql": "organization_group.state", "database": "text", "filter": true},
      "key": {"sql": "organization_group.group_key", "database": "text", "search": true},
      "label": {"sql": "organization_group.label", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    6
  );

  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_groups_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  scan_sql := $scan$
    select organization_group.organization_id,
      organization_group.group_id,
      organization_group.revision,
      pg_catalog.jsonb_build_object(
        'key', organization_group.group_key,
        'label', organization_group.label,
        'state', organization_group.state
      )
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = $1
      and ($2 is null or organization_group.group_id = any($2))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $5', order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_value, after_record_id, p_limit, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_groups_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_groups_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_groups_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;

create or replace function vortex_access.list_organization_permissions_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb,
  p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  after_record_id uuid;
  after_sort_key text;
  record_id_sql text := 'vortex_access.permission_projection_record_id('
    || 'entry.organization_id, entry.registration_kind, entry.registration_owner_id, '
    || 'entry.owner_kind, entry.owner_id, entry.permission_id)';
  keyset_sql text := '';
  sort_sql text;
  outer_sort_sql text;
  sort_bind_sql text;
  direction_sql text;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key is null or p_sort_key not in ('record_id', 'key', 'label', 'administrative')
    or p_direction not in ('ascending', 'descending')
    or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Permission projection bounds are invalid';
  end if;
  sort_sql := case p_sort_key
    when 'key' then 'entry.permission_key'
    when 'label' then 'entry.label'
    when 'administrative' then 'entry.administrative'
    else record_id_sql end;
  outer_sort_sql := case p_sort_key
    when 'key' then 'entry.permission_key'
    when 'label' then 'entry.label'
    when 'administrative' then 'entry.administrative'
    else 'entry.projected_record_id' end;
  sort_bind_sql := case when p_sort_key = 'administrative' then '$5::boolean' else '$5' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Permission projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_sort_key := p_after -> 'sortKey' ->> 0;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Permission projection cursor is invalid';
    end;
    if p_sort_key = 'administrative' and after_sort_key not in ('true', 'false') then
      raise exception using errcode = '22023', message = 'Permission projection cursor is invalid';
    end if;
    keyset_sql := case when p_sort_key = 'record_id' then pg_catalog.format(
      ' and %s %s $3', record_id_sql,
      case when p_direction = 'ascending' then '>' else '<' end
    ) else pg_catalog.format(
      ' and (%s, %s) %s (%s, $3)', sort_sql, record_id_sql,
      case when p_direction = 'ascending' then '>' else '<' end,
      sort_bind_sql
    ) end;
  end if;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "key": {"sql": "entry.permission_key", "database": "text", "search": true},
      "label": {"sql": "entry.label", "database": "text", "filter": true, "search": true},
      "owner_kind": {"sql": "entry.owner_kind", "database": "text", "filter": true},
      "action_kind": {"sql": "entry.action_kind", "database": "text", "filter": true},
      "administrative": {"sql": "entry.administrative", "database": "boolean", "filter": true}
    }$declared$::jsonb,
    6
  );
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_permissions_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  scan_sql := $scan$
    select entry.organization_id,
      entry.projected_record_id,
      entry.registration_revision,
      pg_catalog.jsonb_build_object(
        'key', entry.permission_key,
        'label', entry.label,
        'description', entry.description,
        'owner_kind', entry.owner_kind,
        'action_kind', entry.action_kind,
        'named_action', entry.named_action,
        'administrative', entry.administrative
      )
    from vortex_access.permission_registrations as registration
    cross join lateral (
      select entry.*,
        vortex_access.permission_projection_record_id(
          entry.organization_id, entry.registration_kind, entry.registration_owner_id,
          entry.owner_kind, entry.owner_id, entry.permission_id
        ) as projected_record_id
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = registration.organization_id
        and entry.registration_kind = registration.registration_kind
        and entry.registration_owner_id = registration.registration_owner_id
        and entry.registration_revision = registration.revision
        and ($2 is null or vortex_access.permission_projection_record_id(
          entry.organization_id, entry.registration_kind, entry.registration_owner_id,
          entry.owner_kind, entry.owner_id, entry.permission_id
        ) = any($2))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(
    ' order by %s %s, %s %s limit $4) as entry '
      || 'where registration.organization_id = $1 and registration.state = ''active'' '
      || 'order by %s %s, entry.projected_record_id %s limit $4',
    sort_sql, direction_sql, record_id_sql, direction_sql,
    outer_sort_sql, direction_sql, direction_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_record_id, p_limit, after_sort_key, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;

create or replace function vortex_access.list_organization_role_activations_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
  sort_column text;
  sort_kind text;
  sort_expression text;
  sort_null_expression text := 'false';
  candidate_joins text := '';
  direction_sql text;
  keyset_sql text := '';
  order_sql text;
  outer_order_sql text;
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'activated_at', 'expires_at', 'state', 'account_display_name', 'role_key', 'role_label')
    or p_sort_key is null or p_direction not in ('ascending', 'descending')
    or p_direction is null or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Activation projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'activated_at' then 'activation.activated_at'
    when 'expires_at' then 'activation.expires_at'
    when 'state' then 'activation.state'
    when 'account_display_name' then 'account.display_name'
    when 'role_key' then 'role_revision.role_key'
    when 'role_label' then 'role_revision.label'
    else 'activation.role_activation_id' end;
  sort_kind := case p_sort_key
    when 'activated_at' then 'time'
    when 'expires_at' then 'time'
    when 'state' then 'text'
    when 'account_display_name' then 'nullable_text'
    when 'role_key' then 'legacy_text'
    when 'role_label' then 'legacy_text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind in ('legacy_text', 'nullable_text') then
    -- A stored release can still request a sort dropped from current publishable definitions.
    candidate_joins := $joins$join vortex_identity.organization_accounts as account
      on account.organization_id = activation.organization_id
      and account.organization_account_id = activation.organization_account_id
    join vortex_access.organization_roles as role
      on role.organization_id = activation.organization_id and role.role_id = activation.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision$joins$;
  end if;
  if sort_kind = 'nullable_text' then
    sort_expression := sort_column || ' collate "C"';
    order_sql := pg_catalog.format('%s %s nulls %s, activation.role_activation_id %s',
      sort_expression, direction_sql,
      case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value collate "C" %s nulls %s, candidate.record_id %s',
      direction_sql, case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
  elsif sort_kind in ('text', 'legacy_text') then
    sort_expression := sort_column || ' collate "C"';
    order_sql := pg_catalog.format('%s %s, activation.role_activation_id %s', sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value collate "C" %s, candidate.record_id %s',
      direction_sql, direction_sql);
  else
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s, activation.role_activation_id %s',
      sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s, candidate.record_id %s',
      direction_sql, direction_sql);
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (sort_kind <> 'id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or (pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
          and (sort_kind <> 'nullable_text'
            or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'null'))
      )) then
      raise exception using errcode = '22023', message = 'Activation projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if sort_kind in ('time', 'nullable_time') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Activation projection cursor is invalid';
    end;
    if sort_kind = 'id' then
      keyset_sql := pg_catalog.format(' and activation.role_activation_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind in ('text', 'legacy_text') then
      keyset_sql := pg_catalog.format(' and (%s, activation.role_activation_id) %s ($3 collate "C", $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'nullable_text' then
      keyset_sql := pg_catalog.format(case when p_direction = 'ascending' then
        ' and (($3 is null and (account.display_name is not null or (account.display_name is null and activation.role_activation_id > $4)))'
          || ' or ($3 is not null and (account.display_name collate "C", activation.role_activation_id) > ($3 collate "C", $4)))'
        else
        ' and (($3 is null and account.display_name is null and activation.role_activation_id < $4)'
          || ' or ($3 is not null and (account.display_name is null or (account.display_name collate "C", activation.role_activation_id) < ($3 collate "C", $4))))'
        end);
    else
      keyset_sql := pg_catalog.format(' and (%s, activation.role_activation_id) %s ($5, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "organization_account_id": {"sql": "activation.organization_account_id::text", "database": "text", "filter": true},
      "role_id": {"sql": "activation.role_id::text", "database": "text", "filter": true},
      "eligibility_source_kind": {"sql": "activation.eligibility_source_kind::text", "database": "text", "filter": true},
      "state": {"sql": "activation.state::text", "database": "text", "filter": true},
      "temporal_state": {"sql": "(case when activation.state = 'revoked' then 'revoked' when activation.expires_at <= $7 then 'expired' else 'active' end)", "database": "text", "filter": true},
      "account_display_name": {"sql": "account.display_name", "database": "text", "filter": true, "search": true},
      "role_key": {"sql": "role_revision.role_key", "database": "text", "search": true},
      "role_label": {"sql": "role_revision.label", "database": "text", "search": true}
    }$declared$::jsonb,
    8
  );
  if predicate_plan ->> 'predicate' is not null then
    -- The predicate may read the account and role of an activation; the final
    -- select joins them the same way, so the candidate scan sees the same rows.
    candidate_joins := $joins$join vortex_identity.organization_accounts as account
      on account.organization_id = activation.organization_id
      and account.organization_account_id = activation.organization_account_id
    join vortex_access.organization_roles as role
      on role.organization_id = activation.organization_id and role.role_id = activation.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision$joins$;
    keyset_sql := ' and ' || (predicate_plan ->> 'predicate') || keyset_sql;
  end if;
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := pg_catalog.format($scan$
    with candidate as materialized (
      select activation.role_activation_id as record_id,
        %s as sort_value, %s as sort_null
      from vortex_access.organization_role_activations as activation
      %s
      where activation.organization_id = $1
        and ($2 is null or activation.role_activation_id = any($2))
      %s
      order by %s limit $6
    )
    select activation.organization_id, activation.role_activation_id, activation.revision,
      pg_catalog.jsonb_build_object(
      'organization_account_id', activation.organization_account_id,
      'account_display_name', account.display_name,
      'role_id', activation.role_id,
      'role_key', role_revision.role_key,
      'role_label', role_revision.label,
      'eligibility_source_kind', activation.eligibility_source_kind,
      'activated_at', activation.activated_at,
      'expires_at', activation.expires_at,
      'state', activation.state,
      'temporal_state', case
        when activation.state = 'revoked' then 'revoked'
        when activation.expires_at <= $7 then 'expired'
        else 'active' end
      )
    from candidate
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = $1 and activation.role_activation_id = candidate.record_id
    join vortex_identity.organization_accounts as account
      on account.organization_id = activation.organization_id
      and account.organization_account_id = activation.organization_account_id
    join vortex_access.organization_roles as role
      on role.organization_id = activation.organization_id and role.role_id = activation.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision
    order by %s
  $scan$, sort_expression, sort_null_expression, candidate_joins, keyset_sql,
    order_sql, outer_order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_text, after_record_id, after_time, p_limit, checked_at, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_role_activations_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_role_activations_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_role_activations_projection(uuid[], text, text, jsonb, integer, jsonb) owner to vortex_owner;

create or replace function vortex_access.list_organization_role_assignments_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
  sort_column text;
  sort_kind text;
  sort_expression text;
  sort_null_expression text := 'false';
  candidate_joins text := '';
  direction_sql text;
  keyset_sql text := '';
  order_sql text;
  outer_order_sql text;
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'starts_at', 'expires_at', 'state', 'role_key', 'role_label')
    or p_sort_key is null or p_direction not in ('ascending', 'descending')
    or p_direction is null or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Assignment projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'starts_at' then 'assignment.starts_at'
    when 'expires_at' then 'assignment.expires_at'
    when 'state' then 'assignment.state'
    when 'role_key' then 'role_revision.role_key'
    when 'role_label' then 'role_revision.label'
    else 'assignment.role_assignment_id' end;
  sort_kind := case p_sort_key
    when 'starts_at' then 'time'
    when 'expires_at' then 'nullable_time'
    when 'state' then 'text'
    when 'role_key' then 'legacy_text'
    when 'role_label' then 'legacy_text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind = 'legacy_text' then
    -- A stored release can still request a sort dropped from current publishable definitions.
    candidate_joins := $joins$join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision$joins$;
  end if;
  if sort_kind = 'nullable_time' then
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s nulls %s, assignment.role_assignment_id %s',
      sort_expression, direction_sql,
      case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s nulls %s, candidate.record_id %s',
      direction_sql, case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
  elsif sort_kind in ('text', 'legacy_text') then
    sort_expression := sort_column || ' collate "C"';
    order_sql := pg_catalog.format('%s %s, assignment.role_assignment_id %s', sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value collate "C" %s, candidate.record_id %s',
      direction_sql, direction_sql);
  else
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s, assignment.role_assignment_id %s',
      sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s, candidate.record_id %s',
      direction_sql, direction_sql);
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (sort_kind <> 'id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or (pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
          and (sort_kind <> 'nullable_time'
            or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'null'))
      )) then
      raise exception using errcode = '22023', message = 'Assignment projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if sort_kind in ('time', 'nullable_time') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Assignment projection cursor is invalid';
    end;
    if sort_kind = 'id' then
      keyset_sql := pg_catalog.format(' and assignment.role_assignment_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind in ('text', 'legacy_text') then
      keyset_sql := pg_catalog.format(' and (%s, assignment.role_assignment_id) %s ($3 collate "C", $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'nullable_time' then
      keyset_sql := pg_catalog.format(case when p_direction = 'ascending' then
        ' and (($5 is null and (assignment.expires_at is not null or (assignment.expires_at is null and assignment.role_assignment_id > $4)))'
          || ' or ($5 is not null and (assignment.expires_at, assignment.role_assignment_id) > ($5, $4)))'
        else
        ' and (($5 is null and assignment.expires_at is null and assignment.role_assignment_id < $4)'
          || ' or ($5 is not null and (assignment.expires_at is null or (assignment.expires_at, assignment.role_assignment_id) < ($5, $4))))'
        end);
    else
      keyset_sql := pg_catalog.format(' and (%s, assignment.role_assignment_id) %s ($5, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "role_id": {"sql": "assignment.role_id::text", "database": "text", "filter": true},
      "assignee_kind": {"sql": "assignment.assignee_kind::text", "database": "text", "filter": true},
      "organization_account_id": {"sql": "assignment.organization_account_id::text", "database": "text", "filter": true},
      "group_id": {"sql": "assignment.group_id::text", "database": "text", "filter": true},
      "assignment_kind": {"sql": "assignment.assignment_kind::text", "database": "text", "filter": true},
      "state": {"sql": "assignment.state::text", "database": "text", "filter": true},
      "temporal_state": {"sql": "(case when assignment.state = 'revoked' then 'revoked' when assignment.starts_at > $7 then 'scheduled' when assignment.expires_at is not null and assignment.expires_at <= $7 then 'expired' else 'active' end)", "database": "text", "filter": true},
      "role_key": {"sql": "role_revision.role_key", "database": "text", "search": true},
      "role_label": {"sql": "role_revision.label", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    8
  );
  if predicate_plan ->> 'predicate' is not null then
    -- The predicate may read the role of an assignment; the final select
    -- joins it the same way, so the candidate scan sees the same rows.
    candidate_joins := $joins$join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision$joins$;
    keyset_sql := ' and ' || (predicate_plan ->> 'predicate') || keyset_sql;
  end if;
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := pg_catalog.format($scan$
    with candidate as materialized (
      select assignment.role_assignment_id as record_id,
        %s as sort_value, %s as sort_null
      from vortex_access.organization_role_assignments as assignment
      %s
      where assignment.organization_id = $1
        and ($2 is null or assignment.role_assignment_id = any($2))
      %s
      order by %s limit $6
    )
    select assignment.organization_id, assignment.role_assignment_id, assignment.revision,
      pg_catalog.jsonb_build_object(
      'role_id', assignment.role_id,
      'role_key', role_revision.role_key,
      'role_label', role_revision.label,
      'assignee_kind', assignment.assignee_kind,
      'organization_account_id', assignment.organization_account_id,
      'group_id', assignment.group_id,
      'assignment_kind', assignment.assignment_kind,
      'starts_at', assignment.starts_at,
      'expires_at', assignment.expires_at,
      'state', assignment.state,
      'temporal_state', case
        when assignment.state = 'revoked' then 'revoked'
        when assignment.starts_at > $7 then 'scheduled'
        when assignment.expires_at is not null and assignment.expires_at <= $7 then 'expired'
        else 'active' end
      )
    from candidate
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = $1 and assignment.role_assignment_id = candidate.record_id
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision
    order by %s
  $scan$, sort_expression, sort_null_expression, candidate_joins, keyset_sql,
    order_sql, outer_order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_text, after_record_id, after_time, p_limit, checked_at, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb) owner to vortex_owner;

create or replace function vortex_access.list_organization_roles_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb,
  p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  sort_column text;
  keyset_sql text := '';
  order_sql text;
  after_value text;
  after_record_id uuid;
  join_sql text;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'key', 'label', 'lifecycle')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Role projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'key' then 'role.role_key'
    when 'label' then 'role_revision.label'
    when 'lifecycle' then 'role_revision.lifecycle'
    else 'role.role_id' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Role projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Role projection cursor is invalid';
    end;
    after_value := p_after -> 'sortKey' ->> 0;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and role.role_id > $4' else ' and role.role_id < $4' end;
    else
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", role.role_id) %s ($3 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('role.role_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s collate "C" %s, role.role_id %s',
      sort_column, case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;
  join_sql := case when p_sort_key in ('record_id', 'key') then $join$
    join lateral (
      select role_revision.*
      from vortex_access.organization_role_revisions as role_revision
      where role_revision.organization_id = role.organization_id
        and role_revision.role_id = role.role_id
        and role_revision.revision = role.live_revision
      limit 1
    ) as role_revision on true
  $join$ else $join$
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
  $join$ end;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "key": {"sql": "role_revision.role_key", "database": "text", "search": true},
      "label": {"sql": "role_revision.label", "database": "text", "filter": true, "search": true},
      "lifecycle": {"sql": "role_revision.lifecycle::text", "database": "text", "filter": true},
      "role_kind": {"sql": "role.role_kind::text", "database": "text", "filter": true},
      "privilege_classification": {"sql": "role_revision.privilege_classification::text", "database": "text", "filter": true},
      "assignment_policy": {"sql": "role_revision.assignment_policy::text", "database": "text", "filter": true}
    }$declared$::jsonb,
    6
  );
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_roles_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  scan_sql := $scan$
  select role.organization_id,
    role.role_id,
    role.live_revision,
    pg_catalog.jsonb_build_object(
      'key', role_revision.role_key,
      'label', role_revision.label,
      'lifecycle', role_revision.lifecycle,
      'role_kind', role.role_kind,
      'privilege_classification', role_revision.privilege_classification,
      'assignment_policy', role_revision.assignment_policy,
      'accepted_permission_count', (
        select pg_catalog.count(*)
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role_revision.organization_id
          and permission.role_id = role_revision.role_id
          and permission.role_revision = role_revision.revision
      )
    )
  from vortex_access.organization_roles as role
  $scan$ || join_sql || $scan$
  where role.organization_id = $1
    and ($2 is null or role.role_id = any($2))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $5', order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_value, after_record_id, p_limit, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;

create or replace function vortex_access.list_organization_runtime_settings_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb,
  p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  settings_row record;
  settings_default_application_root_id uuid;
  settings_extension_values jsonb;
  predicate_plan jsonb;
  predicate_matches boolean;
begin
  -- One settings row per organisation, so ordering is irrelevant: record_id and the projection's
  -- declared sortable field (language) are both accepted.
  if p_sort_key is null or p_sort_key not in ('record_id', 'language')
    or p_direction not in ('ascending', 'descending')
    or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Runtime settings projection bounds are invalid';
  end if;
  if p_after is not null and (
    pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
  ) then
    raise exception using errcode = '22023', message = 'Runtime settings projection cursor is invalid';
  end if;
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- runtime-settings read decision the bespoke reader applies decides whether
  -- any row exists at all, and the caller's current organisation is never an
  -- input. A viewer the decision refuses sees no row, exactly as a missing or
  -- foreign record, so the record adapters return their identical refusal and
  -- a list page is empty rather than failing. The record identity is the
  -- organisation, whose settings are a single row, and the revision is the
  -- settings document's own revision, which the default application shares.
  -- Attribute names are the lowercase field keys a projection record type
  -- declares.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_runtime_settings_administration_read_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  select result.* into settings_row
  from vortex_identity.read_current_organization_runtime_settings_internal(
    scope_row.organization_id
  ) as result;
  if settings_row.organization_id is null
    or settings_row.organization_id is distinct from scope_row.organization_id then
    return;
  end if;
  -- The organisation is the record title and the one filterable key; it is the single row's own
  -- value, so the predicate is evaluated against that value as a literal. There is no searchable key.
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    pg_catalog.jsonb_build_object(
      'organization_id',
      pg_catalog.jsonb_build_object(
        'sql', pg_catalog.format('%L::text', settings_row.organization_id::text),
        'database', 'text',
        'filter', true
      )
    ),
    1
  );
  if predicate_plan ->> 'predicate' is not null then
    execute 'select (' || (predicate_plan ->> 'predicate') || ') is true'
      into predicate_matches using predicate_plan -> 'parameters';
    if not predicate_matches then
      return;
    end if;
  end if;
  if p_record_ids is not null
    and not (settings_row.organization_id = any(p_record_ids)) then
    return;
  end if;
  if p_after is not null then
    begin
      if (p_direction = 'ascending'
          and settings_row.organization_id <= (p_after ->> 'recordId')::uuid)
        or (p_direction = 'descending'
          and settings_row.organization_id >= (p_after ->> 'recordId')::uuid) then
        return;
      end if;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Runtime settings projection cursor is invalid';
    end;
  end if;
  select settings.default_application_root_id, settings.extension_values
  into settings_default_application_root_id, settings_extension_values
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = settings_row.organization_id;
  return query select
    settings_row.organization_id,
    settings_row.organization_id,
    settings_row.revision,
    coalesce(settings_extension_values, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'language', settings_row.language,
      'time_zone', settings_row.time_zone,
      'currency', settings_row.currency,
      'date_format', settings_row.date_format,
      'number_format', settings_row.number_format,
      'default_application_root_id', settings_default_application_root_id
    );
end
$function$;

revoke all on function vortex_access.list_organization_runtime_settings_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_runtime_settings_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_runtime_settings_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;

create or replace function vortex_identity.list_organization_accounts_projection_internal(
  p_organization_id uuid,
  p_active_members_only boolean,
  p_account_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer,
  p_predicate jsonb
)
returns table (
  organization_account_id uuid,
  display_name text,
  account_state text,
  language text,
  time_zone text,
  revision bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_value text;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'display_name', 'state')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Account projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'display_name' then 'account.display_name'
    when 'state' then 'account.state'
    else 'account.organization_account_id' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) not in ('string', 'null')
      )) then
      raise exception using errcode = '22023', message = 'Account projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Account projection cursor is invalid';
    end;
    after_value := p_after -> 'sortKey' ->> 0;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and account.organization_account_id > $6'
        else ' and account.organization_account_id < $6' end;
    elsif p_direction = 'ascending' then
      keyset_sql := case when after_value is null
        then pg_catalog.format(
          ' and (%s is not null or (%s is null and account.organization_account_id > $6))',
          sort_column, sort_column
        )
        else pg_catalog.format(
          ' and (%s collate "C", account.organization_account_id) > ($5 collate "C", $6)',
          sort_column
        ) end;
    else
      keyset_sql := case when after_value is null
        then pg_catalog.format(' and %s is null and account.organization_account_id < $6', sort_column)
        else pg_catalog.format(
          ' and (%s is null or (%s collate "C") < ($5 collate "C") or (%s = $5 and account.organization_account_id < $6))',
          sort_column, sort_column, sort_column
        ) end;
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('account.organization_account_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s collate "C" %s nulls %s, account.organization_account_id %s',
      sort_column, case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'first' else 'last' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "state": {"sql": "account.state", "database": "text", "filter": true},
      "display_name": {"sql": "account.display_name", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    7
  );
  scan_sql := $scan$
  -- Two fixed visibility modes, chosen only by the Access-owned reader. The
  -- administration mode returns every account of the organisation. The member
  -- mode applies today's account-choice rule: only active accounts whose
  -- identity, organisation and tenant are active, and only the display name and
  -- state, exactly the facts any active member may already list.
  select account.organization_account_id, account.display_name, account.state,
    case when $2 then null else account.language end,
    case when $2 then null else account.time_zone end,
    account.revision
  from vortex_identity.organization_accounts as account
  where account.organization_id = $1
    and $1 is not null
    and $1 <> '00000000-0000-0000-0000-000000000000'::uuid
    and $2 is not null
    and ($3 is null or account.organization_account_id = any($3))
    and (select case when $2 then projection.state = 'active' else true end
         from vortex_identity.identity_projections as projection
         where projection.identity_id = account.identity_id) is true
    and (
      not $2
      or (
        account.state = 'active'
        and (select organization.state = 'active' and tenant.state = 'active'
             from vortex_identity.organizations as organization
             join vortex_identity.tenants as tenant
               on tenant.tenant_id = organization.tenant_id
             where organization.organization_id = $1) is true
      )
    )
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $4', order_sql);
  return query execute scan_sql using p_organization_id, p_active_members_only,
    p_account_ids, p_limit, after_value, after_record_id, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_identity.list_organization_accounts_projection_internal(
  uuid, boolean, uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_organization_accounts_projection_internal(
  uuid, boolean, uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, postgres;
alter function vortex_identity.list_organization_accounts_projection_internal(
  uuid, boolean, uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

create or replace function vortex_identity.list_organization_invitations_projection_internal(
  p_organization_id uuid, p_record_ids uuid[], p_sort_key text,
  p_direction text, p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  invitation_id uuid, invited_email text, invitation_state text,
  invited_at timestamptz, expires_at timestamptz, revision bigint
)
language plpgsql stable security definer set search_path = ''
as $function$
declare
  sort_column text;
  keyset_sql text := '';
  order_sql text;
  after_text text;
  after_expires_at timestamptz;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'invited_email', 'expires_at', 'state')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Invitation projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'invited_email' then 'invitation.invited_email'
    when 'expires_at' then 'invitation.expires_at'
    -- Releases published before the state sort was dropped still forward it; it has no index.
    when 'state' then '(' || $state$case
          when invitation.accepted_at is not null then 'accepted'
          when invitation.revoked_at is not null then 'revoked'
          when invitation.expires_at <= pg_catalog.statement_timestamp() then 'expired'
          else 'pending'
        end$state$ || ')'
    else 'invitation.invitation_id' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Invitation projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if p_sort_key = 'expires_at' then
        after_expires_at := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Invitation projection cursor is invalid';
    end;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and invitation.invitation_id > $4'
        else ' and invitation.invitation_id < $4' end;
    elsif p_sort_key in ('invited_email', 'state') then
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", invitation.invitation_id) %s ($3 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end
      );
    else
      keyset_sql := pg_catalog.format(
        ' and (invitation.expires_at, invitation.invitation_id) %s ($5, $4)',
        case when p_direction = 'ascending' then '>' else '<' end
      );
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('invitation.invitation_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s%s %s, invitation.invitation_id %s',
      sort_column, case when p_sort_key in ('invited_email', 'state') then ' collate "C"' else '' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "state": {"sql": "(case when invitation.accepted_at is not null then 'accepted' when invitation.revoked_at is not null then 'revoked' when invitation.expires_at <= pg_catalog.statement_timestamp() then 'expired' else 'pending' end)", "database": "text", "filter": true},
      "invited_email": {"sql": "invitation.invited_email", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    7
  );
  scan_sql := $scan$
    select invitation.invitation_id, invitation.invited_email,
      case
        when invitation.accepted_at is not null then 'accepted'
        when invitation.revoked_at is not null then 'revoked'
        when invitation.expires_at <= pg_catalog.statement_timestamp() then 'expired'
        else 'pending'
      end,
      invitation.invited_at, invitation.expires_at, invitation.revision
    from vortex_identity.organization_invitations as invitation
    where invitation.organization_id = $1
      and $1 is not null
      and $1 <> '00000000-0000-0000-0000-000000000000'::uuid
      and ($2 is null or invitation.invitation_id = any($2))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql);
  return query execute scan_sql using p_organization_id, p_record_ids,
    after_text, after_record_id, after_expires_at, p_limit, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_identity.list_organization_invitations_projection_internal(
  uuid, uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_organization_invitations_projection_internal(
  uuid, uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, postgres;
alter function vortex_identity.list_organization_invitations_projection_internal(
  uuid, uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

create or replace function vortex_identity.list_organizations_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_tenant_id uuid;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'short_name', 'display_name', 'state',
      'state_changed_at', 'created_at')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Organisation projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Organisation projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if p_sort_key in ('state_changed_at', 'created_at') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Organisation projection cursor is invalid';
    end;
  end if;

  begin
    context_value := vortex_access.validated_human_request_context();
  exception when insufficient_privilege then
    return;
  end;
  visible_tenant_id := (context_value ->> 'tenantId')::uuid;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_tenant_id::text)
    or not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id, visible_tenant_id, 'platform.tenant.hierarchy.read', evaluated_at
    );
  exception when sqlstate 'V3101' then
    return;
  end;

  sort_column := case p_sort_key
    when 'short_name' then 'organization.short_name'
    when 'display_name' then 'organization.display_name'
    when 'state' then 'organization.state'
    when 'state_changed_at' then 'organization.state_changed_at'
    when 'created_at' then 'organization.created_at'
    else 'organization.organization_id' end;
  if p_after is not null then
    if p_sort_key = 'record_id' then
      keyset_sql := pg_catalog.format(' and organization.organization_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif p_sort_key in ('short_name', 'display_name', 'state') then
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", organization.organization_id) %s ($7 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    else
      keyset_sql := pg_catalog.format(
        ' and (%s, organization.organization_id) %s ($5, $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  order_sql := pg_catalog.format('%s%s %s, organization.organization_id %s',
    sort_column,
    case when p_sort_key in ('short_name', 'display_name', 'state')
      then ' collate "C"' else '' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end);
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "state": {"sql": "organization.state", "database": "text", "filter": true},
      "short_name": {"sql": "organization.short_name", "database": "text", "search": true},
      "display_name": {"sql": "organization.display_name", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    8
  );
  return query execute $scan$
    select $1, organization.organization_id, organization.revision,
      pg_catalog.jsonb_build_object(
        'tenant_id', organization.tenant_id,
        'parent_organization_id', organization.parent_organization_id,
        'short_name', organization.short_name,
        'display_name', organization.display_name,
        'state', organization.state,
        'state_changed_at', organization.state_changed_at,
        'created_at', organization.created_at
      )
    from vortex_identity.organizations as organization
    where organization.tenant_id = $2
      and ($3 is null or organization.organization_id = any($3))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql)
  using visible_organization_id, visible_tenant_id, p_record_ids,
    after_record_id, after_time, p_limit, after_text, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_identity.list_organizations_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_organizations_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_organizations_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

create or replace function vortex_identity.list_tenant_administrators_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_tenant_id uuid;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'starts_at', 'expires_at', 'state')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023',
      message = 'Tenant administrator projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) not in ('string', 'null')
      )) then
      raise exception using errcode = '22023',
        message = 'Tenant administrator projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if p_sort_key in ('starts_at', 'expires_at') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023',
        message = 'Tenant administrator projection cursor is invalid';
    end;
    if p_sort_key <> 'expires_at' and p_sort_key <> 'record_id'
      and after_text is null then
      raise exception using errcode = '22023',
        message = 'Tenant administrator projection cursor is invalid';
    end if;
  end if;

  begin
    context_value := vortex_access.validated_human_request_context();
  exception when insufficient_privilege then
    return;
  end;
  visible_tenant_id := (context_value ->> 'tenantId')::uuid;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_tenant_id::text)
    or not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id, visible_tenant_id,
      'platform.tenant.administrators.read', evaluated_at
    );
  exception when sqlstate 'V3101' then
    return;
  end;

  sort_column := case p_sort_key
    when 'starts_at' then 'assignment.starts_at'
    when 'expires_at' then 'assignment.expires_at'
    -- Older published releases may still forward this derived, unindexed sort.
    when 'state' then $state$case
      when assignment.revoked_at is not null
        and assignment.revoked_at <= $8 then 'revoked'
      when assignment.starts_at > $8 then 'scheduled'
      when assignment.expires_at is not null
        and assignment.expires_at <= $8 then 'expired'
      else 'active' end$state$
    else 'assignment.assignment_id' end;
  if p_after is not null then
    if p_sort_key = 'record_id' then
      keyset_sql := pg_catalog.format(' and assignment.assignment_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif p_sort_key = 'state' then
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", assignment.assignment_id) %s ($7 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    elsif p_sort_key = 'starts_at' then
      keyset_sql := pg_catalog.format(
        ' and (assignment.starts_at, assignment.assignment_id) %s ($5, $4)',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif after_time is null then
      keyset_sql := case when p_direction = 'ascending'
        then ' and (assignment.expires_at is not null or
          (assignment.expires_at is null and assignment.assignment_id > $4))'
        else ' and assignment.expires_at is null and assignment.assignment_id < $4'
        end;
    elsif p_direction = 'ascending' then
      keyset_sql := ' and (assignment.expires_at, assignment.assignment_id) > ($5, $4)';
    else
      keyset_sql := ' and (assignment.expires_at is null or
        (assignment.expires_at, assignment.assignment_id) < ($5, $4))';
    end if;
  end if;
  order_sql := pg_catalog.format('%s%s %s nulls %s, assignment.assignment_id %s',
    sort_column, case when p_sort_key = 'state' then ' collate "C"' else '' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end,
    case when p_direction = 'ascending' then 'first' else 'last' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end);
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "state": {"sql": "(case when assignment.revoked_at is not null and assignment.revoked_at <= $8 then 'revoked' when assignment.starts_at > $8 then 'scheduled' when assignment.expires_at is not null and assignment.expires_at <= $8 then 'expired' else 'active' end)", "database": "text", "filter": true},
      "identity_id": {"sql": "assignment.identity_id::text", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    9
  );
  return query execute $scan$
    select $1, assignment.assignment_id, assignment.revision,
      pg_catalog.jsonb_build_object(
        'tenant_id', assignment.tenant_id,
        'identity_id', assignment.identity_id,
        'capability_keys', assignment.capability_keys,
        'starts_at', assignment.starts_at,
        'expires_at', assignment.expires_at,
        'state', case
          when assignment.revoked_at is not null
            and assignment.revoked_at <= $8 then 'revoked'
          when assignment.starts_at > $8 then 'scheduled'
          when assignment.expires_at is not null
            and assignment.expires_at <= $8 then 'expired'
          else 'active'
        end
      )
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.tenant_id = $2
      and ($3 is null or assignment.assignment_id = any($3))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql)
  using visible_organization_id, visible_tenant_id, p_record_ids,
    after_record_id, after_time, p_limit, after_text, evaluated_at, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_identity.list_tenant_administrators_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_tenant_administrators_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_tenant_administrators_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

create or replace function vortex_identity.list_tenants_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  is_super_administrator boolean;
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'short_name', 'display_name', 'state',
      'state_changed_at', 'created_at')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Tenant projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Tenant projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if p_sort_key in ('state_changed_at', 'created_at') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Tenant projection cursor is invalid';
    end;
  end if;

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
  is_super_administrator :=
    vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
      actor_identity_id, evaluated_at
    ) is not null;

  sort_column := case p_sort_key
    when 'short_name' then 'tenant.short_name'
    when 'display_name' then 'tenant.display_name'
    when 'state' then 'tenant.state'
    when 'state_changed_at' then 'tenant.state_changed_at'
    when 'created_at' then 'tenant.created_at'
    else 'tenant.tenant_id' end;
  if p_after is not null then
    if p_sort_key = 'record_id' then
      keyset_sql := pg_catalog.format(' and tenant.tenant_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif p_sort_key in ('short_name', 'display_name', 'state') then
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", tenant.tenant_id) %s ($3 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    else
      keyset_sql := pg_catalog.format(
        ' and (%s, tenant.tenant_id) %s ($5, $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  order_sql := pg_catalog.format('%s%s %s, tenant.tenant_id %s',
    sort_column,
    case when p_sort_key in ('short_name', 'display_name', 'state')
      then ' collate "C"' else '' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end);
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "state": {"sql": "tenant.state", "database": "text", "filter": true},
      "short_name": {"sql": "tenant.short_name", "database": "text", "search": true},
      "display_name": {"sql": "tenant.display_name", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    10
  );
  return query execute $scan$
    select $1, tenant.tenant_id, tenant.revision,
      pg_catalog.jsonb_build_object(
        'short_name', tenant.short_name,
        'display_name', tenant.display_name,
        'state', tenant.state,
        'state_changed_at', tenant.state_changed_at,
        'created_at', tenant.created_at
      )
    from vortex_identity.tenants as tenant
    where tenant.state = 'active'
      and ($2 is null or tenant.tenant_id = any($2))
      and ($7 or exists (
        select 1 from vortex_identity.tenant_administrator_assignments as assignment
        where assignment.tenant_id = tenant.tenant_id
          and assignment.identity_id = $8
          and assignment.revoked_at is null
          and assignment.starts_at <= $9
          and (assignment.expires_at is null or assignment.expires_at > $9)
      ))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql)
  using visible_organization_id, p_record_ids, after_text, after_record_id,
    after_time, p_limit, is_super_administrator, actor_identity_id, evaluated_at,
    predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_identity.list_tenants_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_tenants_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_tenants_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

reset role;
