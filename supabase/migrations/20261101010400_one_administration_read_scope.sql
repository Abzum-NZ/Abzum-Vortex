-- DF-9: one organisation-administration read scope. The roles, Groups, permissions and assignment
-- ledger scopes were one body differing only in the operation key and the refusal sentence; their
-- ten callers name both, and the four copies go.

set role vortex_owner;

create or replace function vortex_access.organization_administration_read_scope(
  p_operation_key text,
  p_unavailable_message text
)
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
begin
  if p_operation_key is null
    or p_operation_key !~ '^platform\.organization\.[a-z_]+\.read$'
    or p_unavailable_message is null then
    raise exception using errcode = '22023', message = 'Organization administration read is invalid';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', p_operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(p_operation_key),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501', message = p_unavailable_message;
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

revoke all on function vortex_access.organization_administration_read_scope(text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_access.organization_administration_read_scope(text, text) is
  'Private fixed organisation-administration read authorization: the caller names one platform.organization.*.read operation and the sentence a refusal carries; returns the organisation, account and access version.';

alter function vortex_access.organization_administration_read_scope(text, text) owner to vortex_owner;

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
    from vortex_access.organization_administration_read_scope(
      'platform.organization.roles.read', 'Organization role catalogue is unavailable'
    ) as authorized;
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
    -- The application root order has no cursor form.
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
  -- No limit in the scan: a candidate whose release roles fail validation is skipped, so the
  -- loop reads on until the page is full (the scan is an ordered index walk, so only the rows
  -- consumed are read).

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

create or replace function vortex_access.list_organization_delegations_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb, p_limit integer, p_predicate jsonb
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
  sort_expression text;
  sort_type text;
  order_sql text;
  keyset_sql text := '';
  after_value text;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'scope_kind', 'starts_at', 'expires_at', 'state')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Delegation projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'scope_kind' then 'delegation.scope_kind'
    when 'starts_at' then 'delegation.starts_at'
    when 'expires_at' then 'delegation.expires_at'
    when 'state' then 'delegation.state'
    else 'delegation.delegation_authority_id' end;
  sort_type := case when p_sort_key in ('starts_at', 'expires_at')
    then 'timestamptz' else 'text' end;
  sort_expression := case
    when sort_type = 'text' then sort_column || ' collate "C"'
    else sort_column end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) not in ('string', 'null')
      )) then
      raise exception using errcode = '22023', message = 'Delegation projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_value := p_after -> 'sortKey' ->> 0;
      if sort_type = 'timestamptz' and after_value is not null then
        perform after_value::timestamptz;
      end if;
    exception when invalid_text_representation or invalid_datetime_format
      or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Delegation projection cursor is invalid';
    end;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and delegation.delegation_authority_id > $4'
        else ' and delegation.delegation_authority_id < $4' end;
    elsif p_sort_key = 'expires_at' then
      keyset_sql := case when after_value is null then
        case when p_direction = 'ascending' then
          ' and (delegation.expires_at is not null or
            (delegation.expires_at is null and delegation.delegation_authority_id > $4))'
        else ' and delegation.expires_at is null and delegation.delegation_authority_id < $4' end
      when p_direction = 'ascending' then
        ' and (delegation.expires_at, delegation.delegation_authority_id) > ($3::timestamptz, $4)'
      else ' and (delegation.expires_at is null or
        (delegation.expires_at, delegation.delegation_authority_id) < ($3::timestamptz, $4))' end;
    else
      keyset_sql := pg_catalog.format(
        ' and (%s, delegation.delegation_authority_id) %s ($3::%s, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end,
        sort_type);
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('delegation.delegation_authority_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    when p_sort_key = 'expires_at' then pg_catalog.format(
      'delegation.expires_at %s nulls %s, delegation.delegation_authority_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'first' else 'last' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s %s, delegation.delegation_authority_id %s',
      sort_expression, case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;

  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "holder_kind": {"sql": "delegation.holder_kind::text", "database": "text", "filter": true},
      "organization_account_id": {"sql": "delegation.organization_account_id::text", "database": "text", "filter": true},
      "group_id": {"sql": "delegation.group_id::text", "database": "text", "filter": true},
      "scope_kind": {"sql": "delegation.scope_kind::text", "database": "text", "filter": true},
      "state": {"sql": "delegation.state::text", "database": "text", "filter": true},
      "temporal_state": {"sql": "(case when delegation.state = 'revoked' then 'revoked' when delegation.starts_at > $5 then 'scheduled' when delegation.expires_at is not null and delegation.expires_at <= $5 then 'expired' else 'active' end)", "database": "text", "filter": true}
    }$declared$::jsonb,
    7
  );
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_administration_read_scope(
      'platform.organization.assignments.read', 'Organization assignment ledger is unavailable'
    ) as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := $scan$
    select delegation.organization_id, delegation.delegation_authority_id,
      delegation.revision,
      pg_catalog.jsonb_build_object(
        'holder_kind', delegation.holder_kind,
        'holder_display_name', coalesce(holder_account.display_name, holder_group.label),
        'organization_account_id', delegation.organization_account_id,
        'group_id', delegation.group_id,
        'scope_kind', delegation.scope_kind,
        'starts_at', delegation.starts_at,
        'expires_at', delegation.expires_at,
        'state', delegation.state,
        'temporal_state', case
          when delegation.state = 'revoked' then 'revoked'
          when delegation.starts_at > $5 then 'scheduled'
          when delegation.expires_at is not null
            and delegation.expires_at <= $5 then 'expired'
          else 'active' end)
    from vortex_access.organization_delegation_authorities as delegation
    left join vortex_identity.organization_accounts as holder_account
      on delegation.holder_kind = 'organization_account'
      and holder_account.organization_id = delegation.organization_id
      and holder_account.organization_account_id = delegation.organization_account_id
    left join vortex_access.organization_groups as holder_group
      on delegation.holder_kind = 'group'
      and holder_group.organization_id = delegation.organization_id
      and holder_group.group_id = delegation.group_id
    where delegation.organization_id = $1
      and ($2 is null or delegation.delegation_authority_id = any($2))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_value, after_record_id, checked_at, p_limit, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_delegations_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_delegations_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_delegations_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;

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
  if p_sort_key not in ('record_id', 'starts_at', 'expires_at', 'state')
    or p_sort_key is null or p_direction not in ('ascending', 'descending')
    or p_direction is null or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Membership projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'starts_at' then 'membership.starts_at'
    when 'expires_at' then 'membership.expires_at'
    when 'state' then 'membership.state'
    else 'membership.membership_id' end;
  sort_kind := case p_sort_key
    when 'starts_at' then 'time'
    when 'expires_at' then 'nullable_time'
    when 'state' then 'text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind = 'nullable_time' then
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s nulls %s, membership.membership_id %s',
      sort_expression, direction_sql,
      case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s nulls %s, candidate.record_id %s',
      direction_sql, case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
  elsif sort_kind = 'text' then
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
          and (sort_kind <> 'nullable_time'
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
    elsif sort_kind = 'text' then
      keyset_sql := pg_catalog.format(' and (%s, membership.membership_id) %s ($3 collate "C", $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'nullable_time' then
      keyset_sql := pg_catalog.format(case when p_direction = 'ascending' then
        ' and ((%1$s is null and (%2$s is not null or (%2$s is null and membership.membership_id > $4)))'
          || ' or (%1$s is not null and (%2$s, membership.membership_id) > (%3$s, $4)))'
        else
        ' and ((%1$s is null and %2$s is null and membership.membership_id < $4)'
          || ' or (%1$s is not null and (%2$s is null or (%2$s, membership.membership_id) < (%3$s, $4))))'
        end,
        '$5',
        sort_expression,
        '$5');
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
    from vortex_access.organization_administration_read_scope(
      'platform.organization.groups.read', 'Organization Group administration is unavailable'
    ) as authorized;
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
  context_value jsonb;
  visible_organization_id uuid;
  names_only boolean := false;
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

  -- A viewer the groups administration scope admits sees every group of the organisation. Any
  -- other viewer whose human request context is live sees only the names of the organisation's
  -- active groups, the group chooser's choices: no key or state, and only the name to filter,
  -- search or sort by. A viewer neither rule admits sees no rows.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_administration_read_scope(
      'platform.organization.groups.read', 'Organization Group administration is unavailable'
    ) as authorized;
    visible_organization_id := scope_row.organization_id;
  exception when insufficient_privilege then
    visible_organization_id := null;
  end;
  if visible_organization_id is null then
    begin
      context_value := vortex_access.validated_human_request_context();
    exception when insufficient_privilege then
      return;
    end;
    visible_organization_id := (context_value ->> 'organizationId')::uuid;
    names_only := true;
    if p_sort_key in ('key', 'state') then
      return;
    end if;
  end if;

  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    case when names_only then
      $names${
        "label": {"sql": "organization_group.label", "database": "text", "filter": true, "search": true}
      }$names$::jsonb
    else
      $declared${
        "state": {"sql": "organization_group.state", "database": "text", "filter": true},
        "key": {"sql": "organization_group.group_key", "database": "text", "search": true},
        "label": {"sql": "organization_group.label", "database": "text", "filter": true, "search": true}
      }$declared$::jsonb
    end,
    6
  );
  scan_sql := $scan$
    select organization_group.organization_id,
      organization_group.group_id,
      organization_group.revision,
      case when $7 then pg_catalog.jsonb_build_object('label', organization_group.label)
      else pg_catalog.jsonb_build_object(
        'key', organization_group.group_key,
        'label', organization_group.label,
        'state', organization_group.state
      ) end
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = $1
      and ($2 is null or organization_group.group_id = any($2))
      and (not $7 or organization_group.state = 'active')
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $5', order_sql);
  return query execute scan_sql using visible_organization_id, p_record_ids,
    after_value, after_record_id, p_limit, predicate_plan -> 'parameters', names_only;
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
    from vortex_access.organization_administration_read_scope(
      'platform.organization.permissions.read', 'Organization permission catalogue is unavailable'
    ) as authorized;
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
  if p_sort_key not in ('record_id', 'starts_at', 'expires_at', 'state')
    or p_sort_key is null or p_direction not in ('ascending', 'descending')
    or p_direction is null or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Assignment projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'starts_at' then 'assignment.starts_at'
    when 'expires_at' then 'assignment.expires_at'
    when 'state' then 'assignment.state'
    else 'assignment.role_assignment_id' end;
  sort_kind := case p_sort_key
    when 'starts_at' then 'time'
    when 'expires_at' then 'nullable_time'
    when 'state' then 'text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind = 'nullable_time' then
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s nulls %s, assignment.role_assignment_id %s',
      sort_expression, direction_sql,
      case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s nulls %s, candidate.record_id %s',
      direction_sql, case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
  elsif sort_kind = 'text' then
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
    elsif sort_kind = 'text' then
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
    from vortex_access.organization_administration_read_scope(
      'platform.organization.assignments.read', 'Organization assignment ledger is unavailable'
    ) as authorized;
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
      'assignee_display_name', coalesce(assignee_account.display_name, assignee_group.label),
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
    left join vortex_identity.organization_accounts as assignee_account
      on assignment.assignee_kind = 'organization_account'
      and assignee_account.organization_id = assignment.organization_id
      and assignee_account.organization_account_id = assignment.organization_account_id
    left join vortex_access.organization_groups as assignee_group
      on assignment.assignee_kind = 'group'
      and assignee_group.organization_id = assignment.organization_id
      and assignee_group.group_id = assignment.group_id
    order by %s
  $scan$, sort_expression, sort_null_expression, candidate_joins, keyset_sql,
    order_sql, outer_order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_text, after_record_id, after_time, p_limit, checked_at, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, vortex_request, postgres;
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
    from vortex_access.organization_administration_read_scope(
      'platform.organization.roles.read', 'Organization role catalogue is unavailable'
    ) as authorized;
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
      'application_name', (
        select release.application_address ->> 'name'
        from vortex_definition.releases as release
        where release.root_id = role.application_root_id
        order by release.release_revision desc
        limit 1
      ),
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
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, vortex_request, postgres;
alter function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;

create or replace function vortex_access.list_visible_group_link_labels(p_record_ids uuid[])
returns table (record_id uuid, display_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  visible_organization_id uuid;
begin
  begin
    select scope.organization_id into strict visible_organization_id
    from vortex_access.organization_administration_read_scope(
      'platform.organization.groups.read', 'Organization Group administration is unavailable'
    ) as scope;
  exception
    when insufficient_privilege then
      return;
  end;

  return query
  select organization_group.group_id, organization_group.label
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = visible_organization_id
    and organization_group.group_id = any(p_record_ids)
    and pg_catalog.length(pg_catalog.btrim(organization_group.label)) > 0;
end
$function$;

revoke all on function vortex_access.list_visible_group_link_labels(uuid[])
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_visible_group_link_labels(uuid[]) to vortex_request;

comment on function vortex_access.list_visible_group_link_labels(uuid[]) is
  'Returns labels only for requested groups visible through the current viewer-permitted group directory.';

alter function vortex_access.list_visible_group_link_labels(uuid[]) owner to vortex_owner;
grant execute on function vortex_access.list_visible_group_link_labels(uuid[]) to postgres;
grant execute on function vortex_access.list_visible_group_link_labels(uuid[]) to vortex_record_adapter;

CREATE OR REPLACE FUNCTION vortex_access.read_organization_group_for_administration(p_group_id uuid) RETURNS TABLE(organization_id uuid, outcome text, group_summary jsonb, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  group_value jsonb;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_administration_read_scope(
      'platform.organization.groups.read', 'Organization Group administration is unavailable'
    ) as authorized;

  select pg_catalog.jsonb_build_object(
    'groupId', organization_group.group_id,
    'key', organization_group.group_key,
    'label', organization_group.label,
    'state', organization_group.state,
    'revision', organization_group.revision
  )
  into group_value
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = scope.organization_id
    and organization_group.group_id = p_group_id;

  return query select scope.organization_id,
    case when group_value is null then 'unavailable' else 'available' end,
    group_value, scope.access_version;
end
$$;

alter function vortex_access.read_organization_group_for_administration(p_group_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.read_organization_group_for_administration(p_group_id uuid) IS 'Returns one safe Group administration detail without exposing current-fact audit evidence.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_group_for_administration(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_organization_group_for_administration(p_group_id uuid) TO vortex_request;

grant execute on function vortex_access.read_organization_group_for_administration(p_group_id uuid) to postgres;

create or replace function vortex_access.read_organization_role_for_administration(
  p_role_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  role_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  role_value jsonb;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_administration_read_scope(
      'platform.organization.roles.read', 'Organization role catalogue is unavailable'
    ) as authorized;

  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'maximumActivationDurationSeconds', policy.maximum_activation_duration_seconds,
        'reasonRequired', policy.reason_required,
        'recentAuthentication', case policy.authentication_requirement
          when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
          else pg_catalog.jsonb_build_object(
            'kind', policy.authentication_requirement,
            'maximumAgeSeconds', policy.authentication_maximum_age_seconds
          )
        end
      ))
    end,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ),
    'acceptedPermissions', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_strip_nulls(
            pg_catalog.jsonb_build_object(
              'reference', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'applicationRootId', permission.application_root_id,
                  'ownerKind', permission.owner_kind,
                  'ownerId', permission.owner_id,
                  'permissionId', permission.permission_id
                )
              ),
              'key', catalogue.permission_key,
              'label', catalogue.label,
              'description', catalogue.description,
              'recordTypeId', catalogue.record_type_id,
              'action', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'actionKind', catalogue.action_kind,
                  'namedAction', catalogue.named_action
                )
              ),
              'administrative', catalogue.administrative,
              -- The meaning the role accepted, which may be older than the registered one.
              'recordScope', catalogue.record_scope,
              'fieldPolicy', catalogue.field_policy
            )
          ) order by permission.entry_ordinal
        ),
        '[]'::jsonb
      )
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_catalogue_entries as catalogue
        on catalogue.organization_id = permission.organization_id
        and catalogue.registration_kind = permission.registration_kind
        and catalogue.registration_owner_id = permission.registration_owner_id
        and catalogue.registration_revision = permission.accepted_registration_revision
        and catalogue.owner_kind = permission.owner_kind
        and catalogue.owner_id = permission.owner_id
        and catalogue.permission_id = permission.permission_id
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  into role_value
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
  where role.organization_id = scope.organization_id
    and role.role_id = p_role_id;

  return query select scope.organization_id,
    case when role_value is null then 'unavailable' else 'available' end,
    role_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.read_organization_role_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.read_organization_role_for_administration(uuid)
to vortex_request;

comment on function vortex_access.read_organization_role_for_administration(uuid) is
  'Returns one current local role and its accepted configuration without assignment evidence.';

alter function vortex_access.read_organization_role_for_administration(p_role_id uuid) owner to vortex_owner;

grant execute on function vortex_access.read_organization_role_for_administration(p_role_id uuid) to postgres;

drop function vortex_access.organization_roles_administration_scope();
drop function vortex_access.organization_groups_administration_scope();
drop function vortex_access.organization_permissions_administration_scope();
drop function vortex_access.organization_assignment_ledger_administration_scope();

reset role;
