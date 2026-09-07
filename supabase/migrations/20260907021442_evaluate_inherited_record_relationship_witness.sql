-- Compare one trusted published relationship declaration with one factual
-- stored edge. This helper supplies no permission or ownership decision; the
-- protected record composition owns the installed binding and current scope.
create function vortex_access.record_relationship_witness_matches(
  p_declared_relationship_id uuid,
  p_declared_from_module_root_id uuid,
  p_declared_from_record_type_id uuid,
  p_declared_to_module_root_id uuid,
  p_declared_to_record_type_id uuid,
  p_edge_relationship_id uuid,
  p_edge_from_record_id uuid,
  p_edge_to_record_id uuid,
  p_from_record_scope jsonb,
  p_to_record_scope jsonb,
  p_current_organization_id uuid,
  p_current_application_root_id uuid
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  from_key_count integer;
  from_storage_scope text;
  from_organization_id uuid;
  from_application_root_id uuid;
  from_module_root_id uuid;
  from_record_type_id uuid;
  from_record_id uuid;
  to_key_count integer;
  to_storage_scope text;
  to_organization_id uuid;
  to_application_root_id uuid;
  to_module_root_id uuid;
  to_record_type_id uuid;
  to_record_id uuid;
begin
  if not vortex_context.is_non_nil_uuid(p_declared_relationship_id::text)
    or not vortex_context.is_non_nil_uuid(p_declared_from_module_root_id::text)
    or not vortex_context.is_non_nil_uuid(p_declared_from_record_type_id::text)
    or not vortex_context.is_non_nil_uuid(p_declared_to_module_root_id::text)
    or not vortex_context.is_non_nil_uuid(p_declared_to_record_type_id::text)
    or not vortex_context.is_non_nil_uuid(p_edge_relationship_id::text)
    or not vortex_context.is_non_nil_uuid(p_edge_from_record_id::text)
    or not vortex_context.is_non_nil_uuid(p_edge_to_record_id::text)
    or not vortex_context.is_non_nil_uuid(p_current_organization_id::text)
    or not vortex_context.is_non_nil_uuid(p_current_application_root_id::text) then
    raise exception using errcode = '22023',
      message = 'Record relationship witness context is invalid';
  end if;

  if p_from_record_scope is null
    or pg_catalog.jsonb_typeof(p_from_record_scope) is distinct from 'object' then
    raise exception using errcode = '22023',
      message = 'Relationship source record identity is invalid';
  end if;
  select pg_catalog.count(*) into from_key_count
  from pg_catalog.jsonb_object_keys(p_from_record_scope) as scope_key;
  from_storage_scope := p_from_record_scope ->> 'storageScope';
  if not (p_from_record_scope ?& array[
      'storageScope', 'organizationId', 'moduleRootId', 'recordTypeId',
      'storageContractId', 'recordId'
    ])
    or pg_catalog.jsonb_typeof(p_from_record_scope -> 'storageScope')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_from_record_scope -> 'organizationId')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_from_record_scope -> 'moduleRootId')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_from_record_scope -> 'recordTypeId')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_from_record_scope -> 'storageContractId')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_from_record_scope -> 'recordId')
      is distinct from 'string'
    or not vortex_context.is_non_nil_uuid(p_from_record_scope ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(p_from_record_scope ->> 'moduleRootId')
    or not vortex_context.is_non_nil_uuid(p_from_record_scope ->> 'recordTypeId')
    or not vortex_context.is_non_nil_uuid(p_from_record_scope ->> 'storageContractId')
    or not vortex_context.is_non_nil_uuid(p_from_record_scope ->> 'recordId')
    or (from_storage_scope = 'organization_shared'
      and (from_key_count <> 6 or p_from_record_scope ? 'applicationRootId'))
    or (from_storage_scope = 'application_contained'
      and (from_key_count <> 7
        or pg_catalog.jsonb_typeof(p_from_record_scope -> 'applicationRootId')
          is distinct from 'string'
        or not vortex_context.is_non_nil_uuid(
          p_from_record_scope ->> 'applicationRootId'
        )))
    or from_storage_scope not in ('organization_shared', 'application_contained') then
    raise exception using errcode = '22023',
      message = 'Relationship source record identity is invalid';
  end if;

  if p_to_record_scope is null
    or pg_catalog.jsonb_typeof(p_to_record_scope) is distinct from 'object' then
    raise exception using errcode = '22023',
      message = 'Relationship target record identity is invalid';
  end if;
  select pg_catalog.count(*) into to_key_count
  from pg_catalog.jsonb_object_keys(p_to_record_scope) as scope_key;
  to_storage_scope := p_to_record_scope ->> 'storageScope';
  if not (p_to_record_scope ?& array[
      'storageScope', 'organizationId', 'moduleRootId', 'recordTypeId',
      'storageContractId', 'recordId'
    ])
    or pg_catalog.jsonb_typeof(p_to_record_scope -> 'storageScope')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_to_record_scope -> 'organizationId')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_to_record_scope -> 'moduleRootId')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_to_record_scope -> 'recordTypeId')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_to_record_scope -> 'storageContractId')
      is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_to_record_scope -> 'recordId')
      is distinct from 'string'
    or not vortex_context.is_non_nil_uuid(p_to_record_scope ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(p_to_record_scope ->> 'moduleRootId')
    or not vortex_context.is_non_nil_uuid(p_to_record_scope ->> 'recordTypeId')
    or not vortex_context.is_non_nil_uuid(p_to_record_scope ->> 'storageContractId')
    or not vortex_context.is_non_nil_uuid(p_to_record_scope ->> 'recordId')
    or (to_storage_scope = 'organization_shared'
      and (to_key_count <> 6 or p_to_record_scope ? 'applicationRootId'))
    or (to_storage_scope = 'application_contained'
      and (to_key_count <> 7
        or pg_catalog.jsonb_typeof(p_to_record_scope -> 'applicationRootId')
          is distinct from 'string'
        or not vortex_context.is_non_nil_uuid(
          p_to_record_scope ->> 'applicationRootId'
        )))
    or to_storage_scope not in ('organization_shared', 'application_contained') then
    raise exception using errcode = '22023',
      message = 'Relationship target record identity is invalid';
  end if;

  begin
    from_organization_id := (p_from_record_scope ->> 'organizationId')::uuid;
    from_module_root_id := (p_from_record_scope ->> 'moduleRootId')::uuid;
    from_record_type_id := (p_from_record_scope ->> 'recordTypeId')::uuid;
    from_record_id := (p_from_record_scope ->> 'recordId')::uuid;
    if from_storage_scope = 'application_contained' then
      from_application_root_id := (p_from_record_scope ->> 'applicationRootId')::uuid;
    end if;
    to_organization_id := (p_to_record_scope ->> 'organizationId')::uuid;
    to_module_root_id := (p_to_record_scope ->> 'moduleRootId')::uuid;
    to_record_type_id := (p_to_record_scope ->> 'recordTypeId')::uuid;
    to_record_id := (p_to_record_scope ->> 'recordId')::uuid;
    if to_storage_scope = 'application_contained' then
      to_application_root_id := (p_to_record_scope ->> 'applicationRootId')::uuid;
    end if;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023',
        message = 'Record relationship witness identity is invalid';
  end;

  return p_edge_relationship_id = p_declared_relationship_id
    and p_edge_from_record_id = from_record_id
    and p_edge_to_record_id = to_record_id
    and from_module_root_id = p_declared_from_module_root_id
    and from_record_type_id = p_declared_from_record_type_id
    and to_module_root_id = p_declared_to_module_root_id
    and to_record_type_id = p_declared_to_record_type_id
    and from_organization_id = p_current_organization_id
    and to_organization_id = p_current_organization_id
    and from_organization_id = to_organization_id
    and (from_storage_scope = 'organization_shared'
      or from_application_root_id = p_current_application_root_id)
    and (to_storage_scope = 'organization_shared'
      or to_application_root_id = p_current_application_root_id);
end
$function$;

revoke execute on function vortex_access.record_relationship_witness_matches(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.record_relationship_witness_matches(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, uuid, uuid
) is
  'Matches a trusted sealed relationship identity and exact current record scopes to one factual stored edge without deciding permission or ownership.';
