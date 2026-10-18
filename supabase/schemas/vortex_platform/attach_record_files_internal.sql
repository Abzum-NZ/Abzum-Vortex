create or replace function vortex_platform.attach_record_files_internal(
  p_record_type_id uuid, p_record_id uuid, p_record_type jsonb, p_values jsonb
) returns void language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  actor_value jsonb := vortex_platform.upload_request_actor(context_value);
  field_value jsonb;
  attached jsonb;
  file_id_value uuid;
  file_value vortex_platform.file_records%rowtype;
  upload_value vortex_platform.file_uploads%rowtype;
  maximum_files integer;
begin
  -- Only apply_record_changes may call this, after the record writer accepted
  -- the final values under current permissions and concurrency. An exception
  -- rolls back its record, attachment, activity and receipt transaction together.
  for field_value in select value from pg_catalog.jsonb_array_elements(p_record_type -> 'fields')
    where value ->> 'type' = 'attachment' and p_values ? (value ->> 'fieldId')
    order by value ->> 'fieldId'
  loop
    attached := coalesce(nullif(p_values -> (field_value ->> 'fieldId'),'null'::jsonb),'[]'::jsonb);
    maximum_files := case when (field_value #>> '{settings,multiple}')::boolean then (field_value #>> '{settings,maxFiles}')::integer else 1 end;
    if pg_catalog.jsonb_typeof(attached) is distinct from 'array'
      or pg_catalog.jsonb_array_length(attached) > maximum_files
      or ((field_value ->> 'required')::boolean and pg_catalog.jsonb_array_length(attached) = 0)
      or (select pg_catalog.count(distinct value) from pg_catalog.jsonb_array_elements_text(attached)) <> pg_catalog.jsonb_array_length(attached) then
      raise exception using errcode = 'P4021', message = 'Attachment field value refused'; end if;
    for file_id_value in select value::uuid from pg_catalog.jsonb_array_elements_text(attached) order by value::uuid loop
      select * into file_value from vortex_platform.file_records f where f.file_id = file_id_value for update;
      if not found or file_value.organization_id is distinct from (context_value ->> 'organizationId')::uuid
        or file_value.application_root_id is distinct from (context_value ->> 'applicationRootId')::uuid
        or file_value.owner_record_type_id is distinct from p_record_type_id
        or file_value.owner_field_id is distinct from (field_value ->> 'fieldId')::uuid
        or file_value.scanner_result <> 'clean' then
        raise exception using errcode = 'P4021', message = 'Attachment reference refused'; end if;
      if file_value.lifecycle_state = 'active' then
        if file_value.owner_record_id is distinct from p_record_id
          or not (p_record_id = any(file_value.owning_attachment_references)) then
          raise exception using errcode = 'P4021', message = 'Attachment owner refused'; end if;
      else
        select * into upload_value from vortex_platform.file_uploads u where u.file_id = file_id_value for update;
        if not found or file_value.lifecycle_state <> 'scanning'
          or file_value.uploaded_by is distinct from actor_value
          or (file_value.owner_record_id is not null and file_value.owner_record_id <> p_record_id)
          or upload_value.upload_expires_at <= pg_catalog.clock_timestamp()
          or upload_value.completed_settings is distinct from field_value -> 'settings'
          or (upload_value.replacing_file_id is not null and (
            attached @> pg_catalog.jsonb_build_array(upload_value.replacing_file_id::text)
            or not exists(select 1 from vortex_platform.file_records old
              where old.file_id = upload_value.replacing_file_id and old.lifecycle_state = 'active'
                and old.organization_id = file_value.organization_id and old.application_root_id = file_value.application_root_id
                and old.owner_record_type_id = p_record_type_id and old.owner_record_id = p_record_id
                and old.owner_field_id = file_value.owner_field_id))) then
          raise exception using errcode = 'P4021', message = 'Completed upload unavailable'; end if;
        update vortex_platform.file_records set lifecycle_state = 'active', owner_record_id = p_record_id,
          owning_attachment_references = array[p_record_id], activated_at = pg_catalog.clock_timestamp()
        where file_id = file_id_value;
      end if;
    end loop;
    update vortex_platform.file_records f set lifecycle_state = 'soft_deleted',
      owning_attachment_references = '{}', deleted_at = pg_catalog.clock_timestamp()
    where f.organization_id = (context_value ->> 'organizationId')::uuid
      and f.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and f.owner_record_type_id = p_record_type_id and f.owner_record_id = p_record_id
      and f.owner_field_id = (field_value ->> 'fieldId')::uuid and f.lifecycle_state = 'active'
      and not (attached @> pg_catalog.jsonb_build_array(f.file_id::text));
  end loop;
end
$function$;
alter function vortex_platform.attach_record_files_internal(uuid,uuid,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_platform.attach_record_files_internal(uuid,uuid,jsonb,jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.attach_record_files_internal(uuid,uuid,jsonb,jsonb) to vortex_record_adapter;
