create or replace function vortex_identity.update_organization_default_application_internal(
  p_organization_id uuid,
  p_expected_revision bigint,
  p_default_application_root_id uuid
)
returns table (
  organization_id uuid,
  previous_default_application_root_id uuid,
  default_application_root_id uuid,
  revision bigint,
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_runtime_settings%rowtype;
  previous_id uuid;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or (p_default_application_root_id is not null
      and p_default_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Organization default application update is invalid';
  end if;

  select settings.* into existing
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id
  for update;
  if not found or existing.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Organization default application is stale or unavailable';
  end if;

  previous_id := existing.default_application_root_id;

  -- Re-submitting the current value is not a change: report it unchanged so no
  -- Activity is written and the revision is not advanced.
  if previous_id is not distinct from p_default_application_root_id then
    return query select existing.organization_id, previous_id, previous_id,
      existing.revision, false;
    return;
  end if;

  update vortex_identity.organization_runtime_settings as settings
  set default_application_root_id = p_default_application_root_id,
      changed_at = pg_catalog.statement_timestamp(),
      revision = settings.revision + 1
  where settings.organization_id = p_organization_id
  returning * into existing;

  return query select existing.organization_id, previous_id,
    existing.default_application_root_id, existing.revision, true;
end
$function$;

revoke all on function vortex_identity.update_organization_default_application_internal(uuid, bigint, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.update_organization_default_application_internal(
  uuid, bigint, uuid
) is
  'Private Identity writer for the exact organisation default application reference; requires the current settings revision and reports an unchanged value without advancing it.';

alter function vortex_identity.update_organization_default_application_internal(uuid, bigint, uuid) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.update_organization_default_application_internal(uuid, bigint, uuid) to postgres;
reset role;
