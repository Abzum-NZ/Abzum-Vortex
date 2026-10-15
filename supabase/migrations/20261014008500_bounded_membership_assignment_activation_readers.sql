set local role vortex_owner;


create index organization_group_memberships_starts_at_page_idx on vortex_access.organization_group_memberships (organization_id, starts_at, membership_id);

create index organization_group_memberships_expires_at_page_idx on vortex_access.organization_group_memberships (organization_id, (coalesce(expires_at, 'infinity'::timestamptz)), (expires_at is null), membership_id);

create index organization_group_memberships_state_page_idx on vortex_access.organization_group_memberships (organization_id, state collate "C", membership_id);

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
    when 'account_display_name' then 'legacy_text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind = 'legacy_text' then
    -- A stored release can still request a sort dropped from current publishable definitions.
    candidate_joins := $joins$join vortex_identity.organization_accounts as account
      on account.organization_id = membership.organization_id
      and account.organization_account_id = membership.organization_account_id$joins$;
  end if;
  if sort_kind = 'nullable_time' then
    -- The null flag distinguishes NULL from a real infinity timestamp in both directions.
    sort_expression := pg_catalog.format('coalesce(%s, ''infinity''::timestamptz)', sort_column);
    sort_null_expression := pg_catalog.format('(%s is null)', sort_column);
    order_sql := pg_catalog.format('%s %s, %s %s, membership.membership_id %s',
      sort_expression, direction_sql, sort_null_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s, candidate.sort_null %s, candidate.record_id %s',
      direction_sql, direction_sql, direction_sql);
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
    elsif sort_kind in ('text', 'legacy_text') then
      keyset_sql := pg_catalog.format(' and (%s, membership.membership_id) %s ($3 collate "C", $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'nullable_time' then
      keyset_sql := pg_catalog.format(
        ' and (%s, %s, membership.membership_id) %s (coalesce($5, ''infinity''::timestamptz), $5 is null, $4)',
        sort_expression, sort_null_expression,
        case when p_direction = 'ascending' then '>' else '<' end);
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

create or replace function vortex_access.list_organization_group_memberships_projection(p_record_id uuid, p_page_size integer)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.* from vortex_access.list_organization_group_memberships_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer) owner to vortex_owner;

revoke all on function vortex_access.list_organization_group_memberships_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_group_memberships_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter, postgres;
comment on function vortex_access.list_organization_group_memberships_projection(uuid, integer) is
  'Registered group memberships projection with original visibility and record-id order; delegates to the bounded reader.';
alter function vortex_access.list_organization_group_memberships_projection(uuid, integer) owner to vortex_owner;


create index organization_role_assignments_starts_at_page_idx on vortex_access.organization_role_assignments (organization_id, starts_at, role_assignment_id);

create index organization_role_assignments_expires_at_page_idx on vortex_access.organization_role_assignments (organization_id, (coalesce(expires_at, 'infinity'::timestamptz)), (expires_at is null), role_assignment_id);

create index organization_role_assignments_state_page_idx on vortex_access.organization_role_assignments (organization_id, state collate "C", role_assignment_id);

create or replace function vortex_access.list_organization_role_assignments_projection(
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
    -- The null flag distinguishes NULL from a real infinity timestamp in both directions.
    sort_expression := pg_catalog.format('coalesce(%s, ''infinity''::timestamptz)', sort_column);
    sort_null_expression := pg_catalog.format('(%s is null)', sort_column);
    order_sql := pg_catalog.format('%s %s, %s %s, assignment.role_assignment_id %s',
      sort_expression, direction_sql, sort_null_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s, candidate.sort_null %s, candidate.record_id %s',
      direction_sql, direction_sql, direction_sql);
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
      keyset_sql := pg_catalog.format(
        ' and (%s, %s, assignment.role_assignment_id) %s (coalesce($5, ''infinity''::timestamptz), $5 is null, $4)',
        sort_expression, sort_null_expression,
        case when p_direction = 'ascending' then '>' else '<' end);
    else
      keyset_sql := pg_catalog.format(' and (%s, assignment.role_assignment_id) %s ($5, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
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
    after_text, after_record_id, after_time, p_limit, checked_at;
end
$function$;

create or replace function vortex_access.list_organization_role_assignments_projection(p_record_id uuid, p_page_size integer)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.* from vortex_access.list_organization_role_assignments_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer) owner to vortex_owner;

revoke all on function vortex_access.list_organization_role_assignments_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_role_assignments_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter, postgres;
comment on function vortex_access.list_organization_role_assignments_projection(uuid, integer) is
  'Registered role assignments projection with original visibility and record-id order; delegates to the bounded reader.';
alter function vortex_access.list_organization_role_assignments_projection(uuid, integer) owner to vortex_owner;


create index organization_role_activations_activated_at_page_idx on vortex_access.organization_role_activations (organization_id, activated_at, role_activation_id);

create index organization_role_activations_expires_at_page_idx on vortex_access.organization_role_activations (organization_id, expires_at, role_activation_id);

create index organization_role_activations_state_page_idx on vortex_access.organization_role_activations (organization_id, state collate "C", role_activation_id);

create or replace function vortex_access.list_organization_role_activations_projection(
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
    when 'account_display_name' then 'legacy_text'
    when 'role_key' then 'legacy_text'
    when 'role_label' then 'legacy_text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind = 'legacy_text' then
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
  if sort_kind = 'nullable_time' then
    -- The null flag distinguishes NULL from a real infinity timestamp in both directions.
    sort_expression := pg_catalog.format('coalesce(%s, ''infinity''::timestamptz)', sort_column);
    sort_null_expression := pg_catalog.format('(%s is null)', sort_column);
    order_sql := pg_catalog.format('%s %s, %s %s, activation.role_activation_id %s',
      sort_expression, direction_sql, sort_null_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s, candidate.sort_null %s, candidate.record_id %s',
      direction_sql, direction_sql, direction_sql);
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
          and (sort_kind <> 'nullable_time'
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
    elsif sort_kind = 'nullable_time' then
      keyset_sql := pg_catalog.format(
        ' and (%s, %s, activation.role_activation_id) %s (coalesce($5, ''infinity''::timestamptz), $5 is null, $4)',
        sort_expression, sort_null_expression,
        case when p_direction = 'ascending' then '>' else '<' end);
    else
      keyset_sql := pg_catalog.format(' and (%s, activation.role_activation_id) %s ($5, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
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
    after_text, after_record_id, after_time, p_limit, checked_at;
end
$function$;

create or replace function vortex_access.list_organization_role_activations_projection(p_record_id uuid, p_page_size integer)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.* from vortex_access.list_organization_role_activations_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_role_activations_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_role_activations_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_role_activations_projection(uuid[], text, text, jsonb, integer) owner to vortex_owner;

revoke all on function vortex_access.list_organization_role_activations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_role_activations_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter, postgres;
comment on function vortex_access.list_organization_role_activations_projection(uuid, integer) is
  'Registered role activations projection with original visibility and record-id order; delegates to the bounded reader.';
alter function vortex_access.list_organization_role_activations_projection(uuid, integer) owner to vortex_owner;


reset role;
