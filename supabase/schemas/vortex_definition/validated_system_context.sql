CREATE FUNCTION vortex_definition.validated_system_context() RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  checked jsonb;
begin
  checked := vortex_context.current_context();

  if checked ->> 'callerKind' is distinct from 'system' then
    raise exception using
      errcode = '42501',
      message = 'Definition root and draft operations require system context';
  end if;

  if not exists (
    select 1
    from vortex_identity.organizations as organization
    where organization.organization_id = (checked ->> 'organizationId')::uuid
      and organization.tenant_id = (checked ->> 'tenantId')::uuid
  ) then
    raise exception using
      errcode = '23503',
      message = 'Vortex context organization does not exist in its tenant';
  end if;

  return checked;
end
$$;


ALTER FUNCTION vortex_definition.validated_system_context() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_definition.validated_system_context() FROM PUBLIC;
