-- #3411: one database decision whether the person may use a choice option gated by a record-type permission, for a stored record or a new one; the offered list and the form save both ask it.

set local role vortex_record_adapter;

create or replace function vortex_record.decide_choice_option_permission(
  p_record_type_id uuid,
  p_permission_id uuid,
  p_record_id uuid
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
  declaration jsonb;
  eligibility jsonb;
  loaded jsonb;
  decision jsonb;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_permission_id is null
    or p_permission_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
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

  declaration := pg_catalog.jsonb_build_object(
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
  );

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    declaration, context_value, pg_catalog.clock_timestamp()
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    raise log 'Choice option permission refused for permission % on record type %: %',
      p_permission_id, p_record_type_id, eligibility ->> 'reasonCode';
    return false;
  end if;

  -- A role that grants the permission on every record, with no saved condition, decides it for any
  -- record, a new one included.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as alternative(value)
    where pg_catalog.jsonb_typeof(alternative.value -> 'recordScope') = 'object'
      and not (alternative.value -> 'recordScope' ? 'savedCondition')
      and coalesce(
        alternative.value -> 'recordScope' -> 'routes' @> '[{"kind":"all_records"}]'::jsonb,
        false
      )
  ) then
    return true;
  end if;

  -- A narrower record scope is decided only against the stored record it applies to, through the
  -- same record access evaluation every record action uses. A new record has none yet, and a scope
  -- that needs facts beyond the record itself (a relationship or a saved condition) is not offered.
  if p_record_id is null then
    raise log 'Choice option permission refused for permission % on record type %: record scope needs a stored record',
      p_permission_id, p_record_type_id;
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as alternative(value)
    where pg_catalog.jsonb_typeof(alternative.value -> 'recordScope' -> 'routes') is distinct from 'array'
      or alternative.value -> 'recordScope' ? 'savedCondition'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(alternative.value -> 'recordScope' -> 'routes') = 'array'
            then alternative.value -> 'recordScope' -> 'routes' else '[]'::jsonb end
        ) as route(value)
        where coalesce(route.value ->> 'kind', '') not in ('all_records', 'ownership', 'direct_share')
      )
  ) then
    raise log 'Choice option permission refused for permission % on record type %: record scope is not decided by the record alone',
      p_permission_id, p_record_type_id;
    return false;
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'update', p_record_id, null, null::jsonb
  );
  if loaded ->> 'outcome' is distinct from 'loaded' then
    raise log 'Choice option permission refused for permission % on record %: record facts %',
      p_permission_id, p_record_id, coalesce(loaded ->> 'outcome', 'unavailable');
    return false;
  end if;
  decision := vortex_access.evaluate_record_access_with_validated_types_internal(
    declaration, p_record_id, loaded -> 'facts', null, null
  );
  if decision ->> 'outcome' is distinct from 'allowed' then
    raise log 'Choice option permission refused for permission % on record %: %',
      p_permission_id, p_record_id, decision ->> 'reasonCode';
    return false;
  end if;
  return true;
end
$function$;

alter function vortex_record.decide_choice_option_permission(uuid, uuid, uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.decide_choice_option_permission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.decide_choice_option_permission(uuid, uuid, uuid)
  to vortex_runtime, vortex_request;
comment on function vortex_record.decide_choice_option_permission(uuid, uuid, uuid) is
  'The one decision whether the signed-in person may use a choice option gated by a record-type permission, for one stored record or (with no record) a new one; the offered list and the form save both ask it.';

reset role;
