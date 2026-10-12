CREATE FUNCTION vortex_module.read_current_active_installation() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  checked_context jsonb;
begin
  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId' then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  return vortex_module.read_active_installation_for_scope_internal(
    (checked_context ->> 'organizationId')::uuid,
    (checked_context ->> 'applicationRootId')::uuid
  );
end
$$;

COMMENT ON FUNCTION vortex_module.read_current_active_installation() IS 'Returns the complete exact active Module binding set selected from validated human Application context.';

REVOKE ALL ON FUNCTION vortex_module.read_current_active_installation() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_module.read_current_active_installation() TO vortex_request;
GRANT ALL ON FUNCTION vortex_module.read_current_active_installation() TO vortex_record_adapter;
GRANT ALL ON FUNCTION vortex_module.read_current_active_installation() TO postgres;
GRANT ALL ON FUNCTION vortex_module.read_current_active_installation() TO vortex_page_owner;
