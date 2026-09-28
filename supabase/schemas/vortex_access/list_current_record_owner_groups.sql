create or replace function vortex_access.list_current_record_owner_groups()
returns table (group_id uuid, label text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();

  return query
  select distinct organization_group.group_id, organization_group.label
  from vortex_access.organization_groups as organization_group
  join vortex_access.organization_group_memberships as membership
    on membership.organization_id = organization_group.organization_id
    and membership.group_id = organization_group.group_id
  where organization_group.organization_id = (context_value ->> 'organizationId')::uuid
    and organization_group.state = 'active'
    and membership.organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and membership.state = 'live'
    and membership.starts_at <= pg_catalog.statement_timestamp()
    and (membership.expires_at is null
      or membership.expires_at > pg_catalog.statement_timestamp())
  order by organization_group.label, organization_group.group_id;
end
$function$;

revoke all on function vortex_access.list_current_record_owner_groups()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_current_record_owner_groups()
  to vortex_request;

comment on function vortex_access.list_current_record_owner_groups() is
  'Returns only the active Groups of which the verified current organisation account is a current member, for an explicit initial record ownership choice. The protected Record writer rechecks the selected Group under its own transaction lock.';
