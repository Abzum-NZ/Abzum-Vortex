create or replace function vortex_record.read_attachment_upload_authority(
  p_record_type_id uuid, p_record_id uuid, p_field_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  field_value jsonb;
  eligible jsonb;
begin
  -- Live uploads cannot escape into preview storage. A create admission is provisional:
  -- the final proposed record must still pass the ordinary create writer at Save.
  if vortex_record.read_current_preview_installation_internal() is not null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, case when p_record_id is null then 'create' else 'update' end
  );
  if meta ->> 'outcome' = 'refused' or meta -> 'declaration' is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') item(value)
  where (item.value ->> 'fieldId')::uuid = p_field_id
    and item.value ->> 'type' = 'attachment';
  if not found then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
  if p_record_id is null then
    eligible := vortex_access.evaluate_organization_record_permission_eligibility_internal(
      meta -> 'declaration', context_value, pg_catalog.clock_timestamp()
    );
    if eligible ->> 'outcome' is distinct from 'eligible' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(pg_catalog.jsonb_build_object(
      'outcome', 'allowed', 'organizationId', context_value -> 'organizationId',
      'matchedContributions', eligible -> 'eligiblePermissions'
    ));
  else
    loaded := vortex_record.load_record_access_facts_internal(p_record_type_id, 'update', p_record_id, null, null);
    if loaded ->> 'outcome' is distinct from 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(loaded -> 'declaration', p_record_id, loaded -> 'facts');
    if decision ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    bounds := vortex_record.resolve_record_field_bounds_internal(decision);
  end if;
  if not coalesce(bounds -> 'readableFieldIds' @> pg_catalog.jsonb_build_array(p_field_id::text), false)
    or not coalesce(bounds -> 'changeableFieldIds' @> pg_catalog.jsonb_build_array(p_field_id::text), false) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed', 'sessionContext', context_value,
    'readableFieldIds', bounds -> 'readableFieldIds', 'changeableFieldIds', bounds -> 'changeableFieldIds',
    'attachmentSettings', field_value -> 'settings',
    'existingAttachmentCount', case when p_record_id is null then 0
      else coalesce(pg_catalog.jsonb_array_length(nullif(loaded -> 'fieldValues' -> p_field_id::text, 'null'::jsonb)), 0) end
  );
end
$function$;
alter function vortex_record.read_attachment_upload_authority(uuid,uuid,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.read_attachment_upload_authority(uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_attachment_upload_authority(uuid,uuid,uuid) to vortex_request, vortex_owner;
