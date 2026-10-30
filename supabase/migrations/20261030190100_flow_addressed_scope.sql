set local role vortex_owner;

create or replace function vortex_access.resolve_human_application_address_scope(
  p_identity_id uuid, p_tenant_short_name text, p_organization_short_name text, p_application_key text
)
returns table (
  tenant_id uuid, organization_id uuid, organization_account_id uuid, application_root_id uuid,
  access_version bigint, completed_at timestamptz, account_display_name text
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  addressed record;
  hinted_root uuid;
begin
  select address.* into strict addressed
  from vortex_identity.read_organization_at_address(
    p_identity_id, p_tenant_short_name, p_organization_short_name
  ) as address;
  -- This is a selector only. The existing scope and address authorities decide it below.
  select root.root_id into strict hinted_root
  from vortex_definition.roots as root
  where root.organization_id = addressed.organization_id
    and root.kind = 'application' and root.key = p_application_key;
  return query
  select scope.tenant_id, scope.organization_id, scope.organization_account_id,
    scope.application_root_id, scope.access_version, pg_catalog.clock_timestamp(),
    addressed.account_display_name
  from vortex_access.resolve_human_application_scope(
    p_identity_id, addressed.organization_id, hinted_root
  ) as scope;
exception when no_data_found or too_many_rows then
  raise exception using errcode = 'P0002', message = 'Application address is unavailable';
end
$function$;

alter function vortex_access.resolve_human_application_address_scope(uuid, text, text, text) owner to vortex_owner;
revoke all on function vortex_access.resolve_human_application_address_scope(uuid, text, text, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_runtime;
grant execute on function vortex_access.resolve_human_application_address_scope(uuid, text, text, text)
  to vortex_runtime, postgres;
comment on function vortex_access.resolve_human_application_address_scope(uuid, text, text, text) is
  'Resolves an addressed human application scope using the current organisation and Access authorities.';

create or replace function vortex_definition.resolve_addressed_active_application_identity(p_application_key text)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare
  checked_context jsonb;
  final_context jsonb;
  selected_root uuid;
  installation jsonb;
  registered_app record;
begin
  if p_application_key is null or pg_catalog.length(p_application_key) not between 3 and 120
    or p_application_key !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$' or exists(select 1 from pg_catalog.unnest(pg_catalog.string_to_array(p_application_key,'.')) as segment(value) where pg_catalog.length(segment.value)>40) then
    raise exception using errcode='22023', message='Application address is invalid';
  end if;
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Application address is unavailable';
  end if;
  select root.root_id into strict selected_root from vortex_definition.roots as root
  where root.organization_id=(checked_context ->> 'organizationId')::uuid
    and root.kind='application' and root.key=p_application_key;
  if checked_context ? 'applicationRootId'
    and (checked_context ->> 'applicationRootId')::uuid is distinct from selected_root then
    raise exception using errcode='42501', message='Application address is unavailable';
  end if;
  installation:=vortex_definition.read_active_installation_for_scope_internal(
    (checked_context ->> 'organizationId')::uuid,selected_root);
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(
    (checked_context ->> 'organizationId')::uuid,selected_root) as snapshot;
  if registered_app.release_revision is distinct from (installation ->> 'applicationReleaseRevision')::bigint
    or registered_app.definition_key is distinct from p_application_key
    or exists(select 1 from vortex_definition.installation_bindings as binding
      where binding.organization_id=(checked_context ->> 'organizationId')::uuid
        and binding.application_root_id=selected_root and binding.state not in ('active','detached')) then
    raise exception using errcode='40001', message='Application address changed';
  end if;
  final_context:=vortex_access.validated_human_request_context();
  if final_context is distinct from checked_context
    or pg_catalog.clock_timestamp()>=(final_context ->> 'expiresAt')::timestamptz
    or (final_context ? 'delegatedContext' and pg_catalog.clock_timestamp()>=(final_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (final_context ? 'supportContext' and pg_catalog.clock_timestamp()>=(final_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='40001', message='Application address context changed';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId',checked_context -> 'organizationId','applicationRootId',selected_root,
    'definitionKey',p_application_key,'applicationReleaseRevision',installation -> 'applicationReleaseRevision');
exception when no_data_found or too_many_rows then
  raise exception using errcode='P0002', message='Application address is unavailable';
end
$function$;
alter function vortex_definition.resolve_addressed_active_application_identity(text) owner to vortex_owner;
revoke all on function vortex_definition.resolve_addressed_active_application_identity(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.resolve_addressed_active_application_identity(text) to vortex_owner, vortex_request;
comment on function vortex_definition.resolve_addressed_active_application_identity(text) is 'Returns one exact active Application address under the current HUMAN organization or matching application request, without a Page grant.';

reset role;
