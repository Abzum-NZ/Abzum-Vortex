set role vortex_owner;

create or replace function vortex_access.delegable_invitation_role_ids(p_role_ids uuid[])
returns uuid[]
language plpgsql stable security definer set search_path = ''
as $function$
declare
  scope record;
  checked_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_role_ids is null or pg_catalog.cardinality(p_role_ids) > 200 then
    raise exception using errcode = '22023', message = 'Delegable role request is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  return coalesce((
    select pg_catalog.array_agg(role.role_id order by role.role_id)
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = scope.organization_id and role.role_id = any(p_role_ids)
      and revision.lifecycle = 'active'
      and revision.assignment_policy in ('standing', 'activation_required')
      and vortex_access.check_organization_invitation_role_authority_internal(
        scope.organization_id, scope.organization_account_id, role.role_id, checked_at)
  ), '{}'::uuid[]);
end
$function$;

alter function vortex_access.delegable_invitation_role_ids(uuid[]) owner to vortex_owner;
revoke all on function vortex_access.delegable_invitation_role_ids(uuid[]) from public, anon, authenticated, service_role;
grant execute on function vortex_access.delegable_invitation_role_ids(uuid[]) to vortex_request, postgres;

reset role;
