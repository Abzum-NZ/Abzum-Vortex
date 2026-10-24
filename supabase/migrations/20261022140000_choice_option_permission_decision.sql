-- #3411: one database decision whether the person holds the record-type permission that gates a choice option; the offered list and the form save both ask it.

set local role vortex_record_adapter;

create or replace function vortex_record.decide_choice_option_permission(
  p_record_type_id uuid,
  p_permission_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  meta jsonb;
  entry_count integer;
  entry record;
  eligibility jsonb;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_permission_id is null
    or p_permission_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Choice option permission selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'A choice option permission requires an Application context';
  end if;

  -- The record-owning Module and the record's exact storage identity come from the installed
  -- release, never from the caller.
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'update');
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object' then
    return false;
  end if;

  -- The option permission is a record-type permission the record-owning Module declares in its
  -- installed release; its action is whatever the release declares, so one decision serves a named
  -- action and a standard one.
  select pg_catalog.count(*) into entry_count
  from vortex_definition.runtime_releases as release
  cross join lateral pg_catalog.jsonb_array_elements(
    coalesce(release.record_content -> 'permissions', '[]'::jsonb)
  ) as item(value)
  where release.root_id = (meta ->> 'moduleRootId')::uuid
    and release.release_revision = (meta ->> 'moduleReleaseRevision')::bigint
    and (item.value ->> 'permissionId')::uuid = p_permission_id
    and (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  if entry_count <> 1 then
    raise log 'Choice option permission refused: % declarations of permission % for record type %',
      entry_count, p_permission_id, p_record_type_id;
    return false;
  end if;
  select item.value ->> 'actionKind' as action_kind, item.value ->> 'namedAction' as named_action
  into strict entry
  from vortex_definition.runtime_releases as release
  cross join lateral pg_catalog.jsonb_array_elements(release.record_content -> 'permissions') as item(value)
  where release.root_id = (meta ->> 'moduleRootId')::uuid
    and release.release_revision = (meta ->> 'moduleReleaseRevision')::bigint
    and (item.value ->> 'permissionId')::uuid = p_permission_id
    and (item.value ->> 'recordTypeId')::uuid = p_record_type_id;

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    pg_catalog.jsonb_build_object(
      'operationKey', 'record.choice_option',
      'action', case when entry.named_action is null
        then pg_catalog.jsonb_build_object('actionKind', entry.action_kind)
        else pg_catalog.jsonb_build_object(
          'actionKind', entry.action_kind, 'namedAction', entry.named_action
        ) end,
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', (context_value ->> 'applicationRootId')::uuid
      ),
      'requiredPermissions', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'applicationRootId', (context_value ->> 'applicationRootId')::uuid,
          'ownerKind', 'module',
          'ownerId', (meta ->> 'moduleRootId')::uuid,
          'permissionId', p_permission_id
        )
      ),
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', (meta ->> 'moduleRootId')::uuid,
        'recordTypeId', p_record_type_id,
        'storageContractId', (meta ->> 'storageContractId')::uuid,
        'storageScope', meta ->> 'storageScope'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    ),
    context_value,
    pg_catalog.clock_timestamp()
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    raise log 'Choice option permission refused for permission % on record type %: %',
      p_permission_id, p_record_type_id, eligibility ->> 'reasonCode';
    return false;
  end if;
  return true;
end
$function$;

alter function vortex_record.decide_choice_option_permission(uuid, uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.decide_choice_option_permission(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.decide_choice_option_permission(uuid, uuid)
  to vortex_runtime, vortex_request;
comment on function vortex_record.decide_choice_option_permission(uuid, uuid) is
  'The one decision whether the signed-in person holds the record-type permission that gates a choice option; the offered list and the form save both ask it.';

reset role;
