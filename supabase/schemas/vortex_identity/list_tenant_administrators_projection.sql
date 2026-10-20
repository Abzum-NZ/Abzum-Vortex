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
      "identity_id": {"sql": "assignment.identity_id::text", "database": "text", "search": true}
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
