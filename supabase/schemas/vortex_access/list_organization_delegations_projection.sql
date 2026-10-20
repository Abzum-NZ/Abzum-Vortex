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
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := $scan$
    select delegation.organization_id, delegation.delegation_authority_id,
      delegation.revision,
      pg_catalog.jsonb_build_object(
        'holder_kind', delegation.holder_kind,
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
