-- The checked deletion of an application's protected history. It is owned by the NOLOGIN role
-- vortex_history_purger, the only role the history protection lets delete, and is executable by
-- vortex_owner only. It proves everything itself, whoever calls it: a permitted human request in
-- the organisation, then the whole purge review (ordinary application, not the default, no
-- dependents, delete-only refused when installed) and the typed name. Only then does it delete:
-- first what is not history (records, tables, drafts, bindings), then the history itself.
create or replace function vortex_definition.purge_application_history_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_delete_only boolean,
  p_confirmed_name text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
begin
  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;
  if authority.organization_id is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Application purge organisation mismatch';
  end if;
  if p_confirmed_name is null then
    raise exception using errcode = 'VX004',
      message = 'The typed name does not match the application name';
  end if;
  perform vortex_definition.purge_application_review_internal(
    p_organization_id, p_application_root_id, p_delete_only, p_confirmed_name);
  -- Everything that is not protected history goes first: it releases the roots so that the
  -- releases can be deleted. The review above has already read the name it needs.
  perform vortex_definition.purge_application_rows_internal(
    p_organization_id, p_application_root_id);
  perform vortex_definition.purge_application_history_rows_internal(
    p_organization_id, p_application_root_id);
end
$function$;

alter function vortex_definition.purge_application_history_internal(uuid, uuid, boolean, text)
  owner to vortex_history_purger;

revoke all on function vortex_definition.purge_application_history_internal(uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.purge_application_history_internal(uuid, uuid, boolean, text)
  to vortex_owner;

comment on function vortex_definition.purge_application_history_internal(uuid, uuid, boolean, text) is
  'Deletes an ordinary application''s protected history rows. Owned by vortex_history_purger, the only role the history protection lets delete; executable by vortex_owner only. It proves a permitted human request in the organisation, the whole purge review and the typed name itself before it deletes.';
