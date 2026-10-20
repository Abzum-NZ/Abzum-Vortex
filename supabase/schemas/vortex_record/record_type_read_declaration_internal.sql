create or replace function vortex_record.record_type_read_declaration_internal(
  p_plan jsonb,
  p_record_type_id uuid,
  p_application_root_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  target_meta jsonb;
  required_permissions jsonb;
begin
  if p_record_type_id is null or p_application_root_id is null
    or pg_catalog.jsonb_typeof(p_plan -> 'recordTypes') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_plan -> 'permissions') is distinct from 'object' then
    raise exception using errcode = '22023',
      message = 'Record read declaration input is invalid';
  end if;
  target_meta := p_plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;

  -- The declaration the record loader builds for a read: every record-scoped
  -- read permission declared for this exact record type by the context
  -- Application or the record type's own Module, in canonical order.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', p_application_root_id,
      'ownerKind', declared.value ->> 'ownerKind',
      'ownerId', (declared.value ->> 'ownerId')::uuid,
      'permissionId', declared.key::uuid
    )
    order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
  )
  into required_permissions
  from pg_catalog.jsonb_each(p_plan -> 'permissions') as declared(key, value)
  where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and declared.value ->> 'actionKind' = 'read'
    and (declared.value ->> 'namedAction') is null
    and (
      (declared.value ->> 'ownerKind') = 'application'
      or (declared.value ->> 'ownerId')::uuid = (target_meta ->> 'moduleRootId')::uuid
    );

  -- No read permission is declared for the record type: nobody reads it.
  if required_permissions is null then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'operationKey', 'record.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', p_application_root_id
    ),
    'requiredPermissions', required_permissions,
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', (target_meta ->> 'moduleRootId')::uuid,
      'recordTypeId', p_record_type_id,
      'storageContractId', (target_meta ->> 'storageContractId')::uuid,
      'storageScope', target_meta ->> 'storageScope'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );
end
$function$;

alter function vortex_record.record_type_read_declaration_internal(jsonb, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.record_type_read_declaration_internal(jsonb, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.record_type_read_declaration_internal(jsonb, uuid, uuid) is
  'Private whole-record-type read declaration over one installation access plan: every record-scoped read permission the context Application or the record type''s own Module declares for the record type, or null when none is declared.';

grant execute on function vortex_record.record_type_read_declaration_internal(jsonb, uuid, uuid) to vortex_owner;
