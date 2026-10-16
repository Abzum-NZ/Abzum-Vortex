create or replace function vortex_record.read_studio_person_label(p_account_id uuid)
returns table (record_id uuid, display_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  person_type_id uuid;
  title_field_id uuid;
begin
  select distinct storage.record_type_id,
    (storage.record_type_definition ->> 'titleFieldId')::uuid
  into strict person_type_id, title_field_id
  from vortex_record.storage_catalogue as storage
  where storage.state = 'active'
    and storage.protected_read_model_key = 'organization_accounts'
    and storage.record_type_definition ->> 'key' = 'person';

  return query
  select title.record_id,
    title.result -> 'values' ->> title_field_id::text
  from vortex_record.read_record_titles(
    person_type_id, array[p_account_id], title_field_id
  ) as title
  where title.result ->> 'outcome' = 'allowed';
end
$function$;

alter function vortex_record.read_studio_person_label(uuid) owner to vortex_owner;
revoke all on function vortex_record.read_studio_person_label(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_studio_person_label(uuid) to vortex_request;
