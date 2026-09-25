-- #660: the deadline worker's next wake-up comes from the live due metadata.
-- This read exposes only one timestamp for rows assigned to its configured
-- login role. It neither claims a row nor establishes a request context.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to postgres, vortex_record_adapter;
reset role;

set local role vortex_record_adapter;
create index record_deadline_due_metadata_transition_at_idx
  on vortex_record.record_deadline_due_metadata (transition_at);
reset role;

-- The forced-RLS due table spans organisations before a worker context exists.
-- As with claim_configured_deadline_due_row_internal, this narrow bridge is
-- postgres-owned and binds its cross-scope read to session_user, which SET ROLE
-- cannot change. Ordinary request logins have no configured deadline binding.
create function vortex_record.next_deadline_refresh_due_at()
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  worker_role_oid oid := pg_catalog.to_regrole(session_user)::oid;
  earliest_due_at timestamptz;
begin
  if not exists (
    select 1
    from vortex_record.deadline_actor_bindings as binding
    where binding.operation = 'refresh_record_deadline'
      and binding.execution_session_role_oid = worker_role_oid
  ) then
    raise exception using errcode = '42501',
      message = 'Deadline worker session required';
  end if;

  select metadata.transition_at into earliest_due_at
  from vortex_record.record_deadline_due_metadata as metadata
  join vortex_record.deadline_actor_bindings as binding
    on binding.organization_id = metadata.organization_id
    and binding.application_root_id is not distinct from metadata.application_root_id
    and binding.operation = 'refresh_record_deadline'
    and binding.state = 'active'
    and binding.execution_session_role_oid = worker_role_oid
  join vortex_record.deadline_actors as actor
    on actor.actor_id = binding.current_actor_id
    and actor.binding_id = binding.binding_id
    and actor.organization_id = binding.organization_id
    and actor.application_root_id is not distinct from binding.application_root_id
    and actor.operation = 'refresh_record_deadline'
    and actor.generation = binding.generation
    and actor.revoked_at is null
  join vortex_identity.organizations as org
    on org.organization_id = metadata.organization_id
    and org.state = 'active'
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = org.tenant_id
    and tenant.state = 'active'
  join vortex_access.organization_access_versions as version
    on version.organization_id = org.organization_id
    and version.current_version is not null
  join vortex_identity.organization_runtime_settings as settings
    on settings.organization_id = org.organization_id
    and settings.time_zone is not null
  order by metadata.transition_at asc
  limit 1;

  return earliest_due_at;
end
$function$;

alter function vortex_record.next_deadline_refresh_due_at() owner to postgres;
revoke all on function vortex_record.next_deadline_refresh_due_at()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.next_deadline_refresh_due_at()
  to vortex_runtime;

comment on function vortex_record.next_deadline_refresh_due_at() is
  'Read-only earliest deadline due timestamp for the configured worker login role; returns no record or tenant data.';

set local role vortex_record_owner;
revoke create on schema vortex_record from postgres, vortex_record_adapter;
reset role;

commit;
