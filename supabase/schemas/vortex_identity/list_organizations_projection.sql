create or replace function vortex_identity.list_organizations_projection(
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
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql)
  using visible_organization_id, visible_tenant_id, p_record_ids,
    after_record_id, after_time, p_limit, after_text;
end
$function$;

revoke all on function vortex_identity.list_organizations_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_organizations_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_identity.list_organizations_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;
