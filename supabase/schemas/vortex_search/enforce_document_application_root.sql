create or replace function vortex_search.enforce_document_application_root()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application_root record;
begin
  if new.application_root_id is null then
    return new;
  end if;

  select root.organization_id, root.kind into application_root
  from vortex_definition.roots as root
  where root.root_id = new.application_root_id;

  if not found or application_root.kind <> 'application'
    or application_root.organization_id <> new.organization_id then
    raise exception using errcode = '23514',
      message = 'Search document application does not belong to the organisation';
  end if;

  return new;
end
$function$;
revoke execute on function vortex_search.enforce_document_application_root()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_search.enforce_document_application_root() is
  'Checks that a search document application root is an Application root belonging to the same organisation.';

alter function vortex_search.enforce_document_application_root()
  owner to postgres;
