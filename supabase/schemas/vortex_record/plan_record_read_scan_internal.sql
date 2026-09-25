create or replace function vortex_record.plan_record_read_scan_internal(
  p_record_type_id uuid
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  shared_record_ids uuid[]
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_application_root_id uuid;
  plan jsonb;
  target_meta jsonb;
  required_permissions jsonb;
  declaration jsonb;
begin
  -- Narrowing only. Any refusal or failure here leaves the scan unrestricted,
  -- so the exact per-row decision, which raises or refuses for the same cause,
  -- is the only thing that decides what a caller reads.
  if p_record_type_id is null or p_record_type_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;

  plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_module.read_current_active_installation()
  );
  if (plan ->> 'organizationId')::uuid is distinct from (context_value ->> 'organizationId')::uuid
    or (plan ->> 'applicationRootId')::uuid is distinct from context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  target_meta := plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;

  -- The declaration the record loader builds for a read: every record-scoped
  -- read permission declared for this exact record type by the context
  -- Application or the record type's own Module, in canonical order.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', context_application_root_id,
      'ownerKind', declared.value ->> 'ownerKind',
      'ownerId', (declared.value ->> 'ownerId')::uuid,
      'permissionId', declared.key::uuid
    )
    order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
  )
  into required_permissions
  from pg_catalog.jsonb_each(plan -> 'permissions') as declared(key, value)
  where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and declared.value ->> 'actionKind' = 'read'
    and (declared.value ->> 'namedAction') is null
    and (
      (declared.value ->> 'ownerKind') = 'application'
      or (declared.value ->> 'ownerId')::uuid = (target_meta ->> 'moduleRootId')::uuid
    );

  if required_permissions is null then
    return query select false, null::uuid, array[]::uuid[], array[]::uuid[];
    return;
  end if;

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', context_application_root_id
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

  return query
  select routes.restricted, routes.owner_account_id, routes.owner_group_ids, routes.shared_record_ids
  from vortex_access.resolve_record_read_scan_routes_internal(
    declaration, target_meta ->> 'ownershipMode'
  ) as routes;
  return;
exception
  when others then
    return query select false, null::uuid, array[]::uuid[], array[]::uuid[];
    return;
end
$function$;

revoke all on function vortex_record.plan_record_read_scan_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.plan_record_read_scan_internal(uuid) is
  'Private read-scan narrowing for the record query: builds the read declaration for one record type of the exact active installation and returns the owner account, owner groups and directly shared record identifiers a caller can be admitted through, or unrestricted; any failure returns unrestricted and never widens what the exact per-row decision allows.';
