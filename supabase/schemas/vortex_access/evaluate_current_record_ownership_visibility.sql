CREATE OR REPLACE FUNCTION vortex_access.evaluate_current_record_ownership_visibility(p_permission_record_scope jsonb, p_ownership_mode text, p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_scope jsonb, p_owner_organization_account_id uuid, p_owner_group_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) RETURNS TABLE(admitted boolean, valid_until timestamp with time zone)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  nil_id constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  scope_key_count integer;
  has_all_records boolean;
  has_ownership boolean;
  record_storage_scope text;
  record_organization_id uuid;
  record_application_root_id uuid;
  record_module_root_id uuid;
  record_type_id uuid;
  record_storage_contract_id uuid;
  record_id uuid;
  membership_deadline timestamptz;
begin
  has_all_records := exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      p_permission_record_scope -> 'routes'
    ) as route(value)
    where route.value ->> 'kind' = 'all_records'
  );
  has_ownership := exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      p_permission_record_scope -> 'routes'
    ) as route(value)
    where route.value ->> 'kind' = 'ownership'
  );

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
    or p_ownership_mode not in ('none', 'organization_account', 'group', 'inherited') then
    raise exception using errcode = '22023',
      message = 'Record visibility context is invalid';
  end if;

  if (p_ownership_mode in ('none', 'inherited')
      and (p_owner_organization_account_id is not null or p_owner_group_id is not null))
    or (p_ownership_mode = 'organization_account'
      and (p_owner_organization_account_id is null
        or p_owner_organization_account_id = nil_id
        or p_owner_group_id is not null))
    or (p_ownership_mode = 'group'
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
  if not vortex_platform.is_non_nil_uuid(p_record_scope ->> 'organizationId')
    or not vortex_platform.is_non_nil_uuid(p_record_scope ->> 'moduleRootId')
    or not vortex_platform.is_non_nil_uuid(p_record_scope ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(p_record_scope ->> 'storageContractId')
    or not vortex_platform.is_non_nil_uuid(p_record_scope ->> 'recordId')
    or (record_storage_scope = 'application_contained'
      and not vortex_platform.is_non_nil_uuid(
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

  if has_ownership and p_ownership_mode = 'group' then
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
$$;

ALTER FUNCTION vortex_access.evaluate_current_record_ownership_visibility(p_permission_record_scope jsonb, p_ownership_mode text, p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_scope jsonb, p_owner_organization_account_id uuid, p_owner_group_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.evaluate_current_record_ownership_visibility(p_permission_record_scope jsonb, p_ownership_mode text, p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_scope jsonb, p_owner_organization_account_id uuid, p_owner_group_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) IS 'Evaluates all-record and direct account/current-Group ownership routes over one trusted current record projection; unsupported valid routes add no authority.';

REVOKE ALL ON FUNCTION vortex_access.evaluate_current_record_ownership_visibility(p_permission_record_scope jsonb, p_ownership_mode text, p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_scope jsonb, p_owner_organization_account_id uuid, p_owner_group_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) FROM PUBLIC;
