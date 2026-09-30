alter table vortex_definition.roots
  add column application_origin_kind text;

alter table vortex_definition.roots
  add constraint roots_application_origin_kind_valid check (
    application_origin_kind is null
    or (
      kind = 'application'
      and application_origin_kind in ('ordinary', 'platform_system_application')
    )
  );

comment on column vortex_definition.roots.application_origin_kind is
  'Nullable provenance for Definition Application roots: ordinary or platform_system_application when classified; null means unknown. Module roots remain null.';

create or replace function vortex_definition.read_builder_application_root_classification(
  p_root_id uuid
)
returns table (
  outcome text,
  application_origin_kind text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established_context jsonb;
  checked_context jsonb;
  context_organization_id uuid;
  stored_origin_kind text;
begin
  established_context := vortex_context.current_context();

  case established_context ->> 'callerKind'
    when 'human' then
      checked_context := vortex_access.validated_human_request_context();
    when 'system' then
      checked_context := vortex_definition.validated_system_context();
    else
      raise exception using
        errcode = '42501',
        message = 'Application root classification requires a validated request context';
  end case;

  context_organization_id := (checked_context ->> 'organizationId')::uuid;

  select root.application_origin_kind into stored_origin_kind
  from vortex_definition.roots as root
  where root.organization_id = context_organization_id
    and root.root_id = p_root_id
    and root.kind = 'application';

  if not found or stored_origin_kind is null then
    return query select 'unavailable'::text, null::text;
    return;
  end if;

  return query select 'available'::text, stored_origin_kind;
end
$function$;

revoke all on function vortex_definition.read_builder_application_root_classification(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_builder_application_root_classification(uuid)
  to vortex_request;

comment on function vortex_definition.read_builder_application_root_classification(uuid) is
  'Returns only the persisted classification for the exact Application root in the validated current request organisation; missing, foreign, wrong-kind and unknown roots share one unavailable result.';

alter function vortex_definition.read_builder_application_root_classification(uuid) owner to postgres;
