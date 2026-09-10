-- Evaluate the first current record-visibility routes over a trusted row
-- projection. The caller owns the installed storage binding and verified
-- request context; this helper adds no record catalogue or authority surface.
create function vortex_access.evaluate_current_record_ownership_visibility(
  p_permission_record_scope jsonb,
  p_ownership_mode text,
  p_binding_organization_id uuid,
  p_binding_application_root_id uuid,
  p_binding_module_root_id uuid,
  p_binding_record_type_id uuid,
  p_binding_storage_contract_id uuid,
  p_binding_storage_scope text,
  p_record_scope jsonb,
  p_owner_organization_account_id uuid,
  p_owner_group_id uuid,
  p_current_organization_id uuid,
  p_current_application_root_id uuid,
  p_current_organization_account_id uuid,
  p_checked_at timestamptz
)
returns table (
  admitted boolean,
  valid_until timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_id constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  scope_key_count integer;
  route_count integer;
  route_value jsonb;
  route_kind text;
  route_key_count integer;
  route_identity text;
  previous_route_identity text;
  relationship_id uuid;
  source_permission_id uuid;
  has_all_records boolean := false;
  has_ownership boolean := false;
  record_storage_scope text;
  record_organization_id uuid;
  record_application_root_id uuid;
  record_module_root_id uuid;
  record_type_id uuid;
  record_storage_contract_id uuid;
  record_id uuid;
  membership_deadline timestamptz;
begin
  if p_permission_record_scope is null
    or pg_catalog.jsonb_typeof(p_permission_record_scope) is distinct from 'object' then
    raise exception using errcode = '22023',
      message = 'Permission record scope is invalid';
  end if;

  select pg_catalog.count(*) into scope_key_count
  from pg_catalog.jsonb_object_keys(p_permission_record_scope) as scope_key;
  if scope_key_count not in (1, 2)
    or not (p_permission_record_scope ? 'routes')
    or (scope_key_count = 2 and not (p_permission_record_scope ? 'savedCondition'))
    or (p_permission_record_scope ? 'savedCondition'
      and pg_catalog.jsonb_typeof(p_permission_record_scope -> 'savedCondition')
        is distinct from 'object')
    or pg_catalog.jsonb_typeof(p_permission_record_scope -> 'routes')
      is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Permission record scope is invalid';
  end if;

  route_count := pg_catalog.jsonb_array_length(p_permission_record_scope -> 'routes');
  if route_count < 1 then
    raise exception using errcode = '22023',
      message = 'Permission record scope is invalid';
  end if;

  for route_value in
    select route.value
    from pg_catalog.jsonb_array_elements(
      p_permission_record_scope -> 'routes'
    ) as route(value)
  loop
    if pg_catalog.jsonb_typeof(route_value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(route_value -> 'kind') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Permission record scope route is invalid';
    end if;
    route_kind := route_value ->> 'kind';
    select pg_catalog.count(*) into route_key_count
    from pg_catalog.jsonb_object_keys(route_value) as route_key;

    if route_kind in ('all_records', 'ownership', 'direct_share') then
      if route_key_count <> 1 then
        raise exception using errcode = '22023',
          message = 'Permission record scope route is invalid';
      end if;
      route_identity := case route_kind
        when 'all_records' then '0:'
        when 'ownership' then '1:'
        else '2:'
      end;
    elsif route_kind = 'relationship' then
      if route_key_count <> 3
        or not (route_value ? 'relationshipId')
        or not (route_value ? 'sourcePermissionId')
        or pg_catalog.jsonb_typeof(route_value -> 'relationshipId')
          is distinct from 'string'
        or pg_catalog.jsonb_typeof(route_value -> 'sourcePermissionId')
          is distinct from 'string' then
        raise exception using errcode = '22023',
          message = 'Permission record scope route is invalid';
      end if;
      if not vortex_context.is_non_nil_uuid(route_value ->> 'relationshipId')
        or not vortex_context.is_non_nil_uuid(
          route_value ->> 'sourcePermissionId'
        ) then
        raise exception using errcode = '22023',
          message = 'Permission record scope route is invalid';
      end if;
      begin
        relationship_id := (route_value ->> 'relationshipId')::uuid;
        source_permission_id := (route_value ->> 'sourcePermissionId')::uuid;
        if relationship_id is null or relationship_id = nil_id
          or source_permission_id is null or source_permission_id = nil_id then
          raise exception using errcode = '22023',
            message = 'Permission record scope route is invalid';
        end if;
      exception
        when invalid_text_representation then
          raise exception using errcode = '22023',
            message = 'Permission record scope route is invalid';
      end;
      route_identity := '3:' || relationship_id::text || ':' ||
        source_permission_id::text;
    else
      raise exception using errcode = '22023',
        message = 'Permission record scope route is invalid';
    end if;

    if previous_route_identity is not null
      and (route_identity collate "C") <= (previous_route_identity collate "C") then
      raise exception using errcode = '22023',
        message = 'Permission record scope routes are invalid';
    end if;
    previous_route_identity := route_identity;

    if route_kind = 'all_records' then
      if has_all_records then
        raise exception using errcode = '22023',
          message = 'Permission record scope routes are invalid';
      end if;
      has_all_records := true;
    elsif route_kind = 'ownership' then
      if has_ownership then
        raise exception using errcode = '22023',
          message = 'Permission record scope routes are invalid';
      end if;
      has_ownership := true;
    end if;
  end loop;

  if has_all_records and route_count <> 1 then
    raise exception using errcode = '22023',
      message = 'The all-record route must be the sole base route';
  end if;

  if p_binding_organization_id is null or p_binding_organization_id = nil_id
    or p_binding_application_root_id is null
    or p_binding_application_root_id = nil_id
    or p_binding_module_root_id is null or p_binding_module_root_id = nil_id
    or p_binding_record_type_id is null or p_binding_record_type_id = nil_id
    or p_binding_storage_contract_id is null
    or p_binding_storage_contract_id = nil_id
    or p_current_organization_id is null or p_current_organization_id = nil_id
    or p_current_application_root_id is null
    or p_current_application_root_id = nil_id
    or p_current_organization_account_id is null
    or p_current_organization_account_id = nil_id
    or p_checked_at is null
    or p_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_binding_storage_scope is null
    or p_binding_storage_scope not in ('organization_shared', 'application_contained')
    or p_ownership_mode is null
    or p_ownership_mode not in ('none', 'organization_account', 'team', 'inherited') then
    raise exception using errcode = '22023',
      message = 'Record visibility context is invalid';
  end if;

  if (p_ownership_mode in ('none', 'inherited')
      and (p_owner_organization_account_id is not null or p_owner_group_id is not null))
    or (p_ownership_mode = 'organization_account'
      and (p_owner_organization_account_id is null
        or p_owner_organization_account_id = nil_id
        or p_owner_group_id is not null))
    or (p_ownership_mode = 'team'
      and (p_owner_group_id is null or p_owner_group_id = nil_id
        or p_owner_organization_account_id is not null)) then
    raise exception using errcode = '22023',
      message = 'Record ownership evidence is invalid';
  end if;

  if p_record_scope is null
    or pg_catalog.jsonb_typeof(p_record_scope) is distinct from 'object' then
    raise exception using errcode = '22023',
      message = 'Record identity is invalid';
  end if;
  record_storage_scope := p_record_scope ->> 'storageScope';
  select pg_catalog.count(*) into scope_key_count
  from pg_catalog.jsonb_object_keys(p_record_scope) as record_key;
  if record_storage_scope = 'organization_shared' then
    if scope_key_count <> 6 or p_record_scope ? 'applicationRootId' then
      raise exception using errcode = '22023', message = 'Record identity is invalid';
    end if;
  elsif record_storage_scope = 'application_contained' then
    if scope_key_count <> 7 or not (p_record_scope ? 'applicationRootId') then
      raise exception using errcode = '22023', message = 'Record identity is invalid';
    end if;
  else
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;

  if not (p_record_scope ?& array[
    'organizationId', 'moduleRootId', 'recordTypeId',
    'storageContractId', 'recordId'
  ]) then
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;
  if not vortex_context.is_non_nil_uuid(p_record_scope ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'moduleRootId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'recordTypeId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'storageContractId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'recordId')
    or (record_storage_scope = 'application_contained'
      and not vortex_context.is_non_nil_uuid(
        p_record_scope ->> 'applicationRootId'
      )) then
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;
  begin
    record_organization_id := (p_record_scope ->> 'organizationId')::uuid;
    record_module_root_id := (p_record_scope ->> 'moduleRootId')::uuid;
    record_type_id := (p_record_scope ->> 'recordTypeId')::uuid;
    record_storage_contract_id := (p_record_scope ->> 'storageContractId')::uuid;
    record_id := (p_record_scope ->> 'recordId')::uuid;
    if record_storage_scope = 'application_contained' then
      record_application_root_id := (p_record_scope ->> 'applicationRootId')::uuid;
    end if;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Record identity is invalid';
  end;
  if record_organization_id is null or record_organization_id = nil_id
    or record_module_root_id is null or record_module_root_id = nil_id
    or record_type_id is null or record_type_id = nil_id
    or record_storage_contract_id is null or record_storage_contract_id = nil_id
    or record_id is null or record_id = nil_id
    or (record_storage_scope = 'application_contained'
      and (record_application_root_id is null or record_application_root_id = nil_id)) then
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;

  if p_binding_organization_id <> p_current_organization_id
    or p_binding_application_root_id <> p_current_application_root_id
    or record_organization_id <> p_current_organization_id
    or record_module_root_id <> p_binding_module_root_id
    or record_type_id <> p_binding_record_type_id
    or record_storage_contract_id <> p_binding_storage_contract_id
    or record_storage_scope <> p_binding_storage_scope
    or (record_storage_scope = 'application_contained'
      and record_application_root_id <> p_current_application_root_id) then
    return query select false, null::timestamptz;
    return;
  end if;

  if has_all_records then
    return query select true, null::timestamptz;
    return;
  end if;

  if has_ownership and p_ownership_mode = 'organization_account'
    and p_owner_organization_account_id = p_current_organization_account_id then
    return query select true, null::timestamptz;
    return;
  end if;

  if has_ownership and p_ownership_mode = 'team' then
    select membership.expires_at into membership_deadline
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = p_current_organization_id
      and membership.group_id = p_owner_group_id
      and membership.organization_account_id = p_current_organization_account_id
      and membership.state = 'live'
      and membership.starts_at <= p_checked_at
      and (membership.expires_at is null or membership.expires_at > p_checked_at);
    if found then
      return query select true, membership_deadline;
      return;
    end if;
  end if;

  return query select false, null::timestamptz;
end
$function$;

revoke execute on function vortex_access.evaluate_current_record_ownership_visibility(
  jsonb, text, uuid, uuid, uuid, uuid, uuid, text, jsonb, uuid, uuid,
  uuid, uuid, uuid, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.evaluate_current_record_ownership_visibility(
  jsonb, text, uuid, uuid, uuid, uuid, uuid, text, jsonb, uuid, uuid,
  uuid, uuid, uuid, timestamptz
) is
  'Evaluates all-record and direct account/current-Group ownership routes over one trusted current record projection; unsupported valid routes add no authority.';
