create or replace function vortex_identity.initialize_organization_security_settings(
  p_organization_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization security settings initialization is invalid';
  end if;
  -- Every organisation starts with two-step verification required.
  insert into vortex_identity.organization_security_settings (
    organization_id, require_step_up, revision, changed_at, changed_by_account_id
  ) values (p_organization_id, true, 1, pg_catalog.statement_timestamp(), null)
  on conflict (organization_id) do nothing;
end
$function$;

comment on function vortex_identity.initialize_organization_security_settings(uuid) is
  'Creates the default organisation security settings row (two-step verification required); an existing row is kept. Called only by the organisation creation functions.';

revoke all on function vortex_identity.initialize_organization_security_settings(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

alter function vortex_identity.initialize_organization_security_settings(p_organization_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.initialize_organization_security_settings(p_organization_id uuid) to postgres;
