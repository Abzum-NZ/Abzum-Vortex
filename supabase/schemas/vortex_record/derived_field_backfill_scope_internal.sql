create or replace function vortex_record.derived_field_backfill_scope_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_installation jsonb;
  installation jsonb;
  plan jsonb;
  binding_item jsonb;
  module_content jsonb;
  record_type_item jsonb;
  record_type_key text;
  type_meta jsonb;
  field_ids jsonb;
  definitions jsonb := '{}'::jsonb;
  targets jsonb := '{}'::jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Derived field backfill requires an application context';
  end if;
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null and preview_installation ->> 'outcome' = 'refused' then
    raise exception using errcode = '42501', message = 'Preview Record context is unavailable';
  end if;
  installation := case when preview_installation is null
    then vortex_definition.read_current_active_installation()
    else preview_installation end;
  plan := vortex_record.resolve_installation_access_plan_internal(installation);

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
    order by item.value ->> 'moduleRootId'
  loop
    select release.record_content into strict module_content
    from vortex_definition.runtime_releases as release
    where release.root_id = (binding_item ->> 'moduleRootId')::uuid
      and release.release_revision = (binding_item ->> 'moduleReleaseRevision')::bigint;
    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(coalesce(module_content -> 'recordTypes', '[]'::jsonb))
        as item(value)
    loop
      record_type_key := pg_catalog.lower(record_type_item ->> 'recordTypeId');
      type_meta := plan -> 'recordTypes' -> record_type_key;
      continue when type_meta is null
        or coalesce((type_meta ->> 'isSystemProjection')::boolean, false);
      definitions := definitions || pg_catalog.jsonb_build_object(record_type_key, record_type_item);
      -- The fields a backfill works out: every total and every stored calculation. A preview's
      -- storage is new, so all of them; a live upgrade only those this exact Module release
      -- brought into storage, since a published field's formula never changes afterwards.
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(field.value ->> 'fieldId')
          order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"), '[]'::jsonb)
      into field_ids
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      where (field.value ->> 'type' = 'total'
          or (field.value ->> 'type' = 'calculation'
            and field.value #>> '{settings,evaluation}' is distinct from 'read_time'))
        and (preview_installation is not null or exists (
          select 1
          from vortex_record.field_storage_mappings as mapping
          where mapping.storage_contract_id = (type_meta ->> 'storageContractId')::uuid
            and mapping.field_id = (field.value ->> 'fieldId')::uuid
            and mapping.state = 'active'
            and mapping.introduced_by_module_root_id = (type_meta ->> 'moduleRootId')::uuid
            and mapping.introduced_at_release_revision = (type_meta ->> 'releaseRevision')::bigint
        ));
      if pg_catalog.jsonb_array_length(field_ids) > 0 then
        targets := targets || pg_catalog.jsonb_build_object(record_type_key, field_ids);
      end if;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'organizationId', context_value -> 'organizationId',
    'applicationRootId', context_value -> 'applicationRootId',
    'plan', plan,
    'definitions', definitions,
    'targets', targets
  );
end
$function$;

alter function vortex_record.derived_field_backfill_scope_internal() owner to vortex_record_adapter;

revoke all on function vortex_record.derived_field_backfill_scope_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.derived_field_backfill_scope_internal()
  to vortex_record_adapter;
comment on function vortex_record.derived_field_backfill_scope_internal() is
  'Private derived-field backfill scope of the request''s live or preview installation: each record type''s definition and the totals and stored calculations a backfill works out for its existing records.';
