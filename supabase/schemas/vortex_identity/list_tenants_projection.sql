create or replace function vortex_identity.list_tenants_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer
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
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql)
  using visible_organization_id, p_record_ids, after_text, after_record_id,
    after_time, p_limit, is_super_administrator, actor_identity_id, evaluated_at;
end
$function$;

revoke all on function vortex_identity.list_tenants_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_tenants_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_tenants_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;
