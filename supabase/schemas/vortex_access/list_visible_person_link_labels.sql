create or replace function vortex_access.list_visible_person_link_labels(p_record_ids uuid[])
returns table (record_id uuid, display_name text)
language sql
volatile
security definer
set search_path = ''
as $function$
  select person.record_id, person.attribute_values ->> 'display_name'
  from vortex_access.list_organization_accounts_projection(
    p_record_ids, 'record_id', 'ascending', null, null, null
  ) as person
  where person.record_id = any(p_record_ids)
    and pg_catalog.length(pg_catalog.btrim(person.attribute_values ->> 'display_name')) > 0
$function$;

revoke all on function vortex_access.list_visible_person_link_labels(uuid[])
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_visible_person_link_labels(uuid[]) to vortex_request;

comment on function vortex_access.list_visible_person_link_labels(uuid[]) is
  'Returns labels only for the requested people visible through the current viewer-permitted directory projection.';

alter function vortex_access.list_visible_person_link_labels(uuid[]) owner to vortex_owner;
grant execute on function vortex_access.list_visible_person_link_labels(uuid[]) to postgres;
