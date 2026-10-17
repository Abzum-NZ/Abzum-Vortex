create or replace function vortex_access.list_organization_group_memberships_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer
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
    after_text, after_record_id, after_time, p_limit, checked_at;
end
$function$;

revoke all on function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer) owner to vortex_owner;
