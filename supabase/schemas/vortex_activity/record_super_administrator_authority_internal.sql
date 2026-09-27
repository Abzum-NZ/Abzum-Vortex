create or replace function vortex_activity.record_super_administrator_authority_internal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_identity_id uuid;
  authority_assignment_id uuid;
begin
  if new.actor_kind = 'identity' then
    actor_identity_id := new.actor_id;
  elsif new.actor_kind = 'organization_account' then
    select account.identity_id
    into actor_identity_id
    from vortex_identity.organization_accounts as account
    where account.organization_id = new.organization_id
      and account.organization_account_id = new.actor_id;
  end if;

  if actor_identity_id is null then
    return new;
  end if;

  authority_assignment_id :=
    vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
      actor_identity_id, new.occurred_at
    );
  if authority_assignment_id is null then
    return new;
  end if;

  insert into vortex_activity.organization_activity_super_administrator_authority (
    organization_id, activity_id, authority_kind, assignment_id
  ) values (
    new.organization_id, new.activity_id, 'vortex_super_administrator',
    authority_assignment_id
  );
  return new;
end
$function$;

revoke all on function vortex_activity.record_super_administrator_authority_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_activity.record_super_administrator_authority_internal() is
  'Attributes each organisation activity by an assigned Vortex super administrator to the exact active assignment without changing activity writers.';
