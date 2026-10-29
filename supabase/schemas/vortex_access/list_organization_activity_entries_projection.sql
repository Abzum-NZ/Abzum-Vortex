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
