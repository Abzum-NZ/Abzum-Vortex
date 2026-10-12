CREATE FUNCTION vortex_context.application_root_id(required boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  value text;
begin
  value := vortex_context.current_context() ->> 'applicationRootId';
  if required and value is null then
    raise exception using errcode = '55000', message = 'Vortex application context is required';
  end if;
  return value::uuid;
end
$$;


ALTER FUNCTION vortex_context.application_root_id(required boolean) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_context.application_root_id(required boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_context.application_root_id(required boolean) TO vortex_request;
GRANT ALL ON FUNCTION vortex_context.application_root_id(required boolean) TO vortex_record_adapter;
