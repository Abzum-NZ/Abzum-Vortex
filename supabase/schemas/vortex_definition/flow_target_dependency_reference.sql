CREATE FUNCTION vortex_definition.flow_target_dependency_reference(p_dependency jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case p_dependency ->> 'kind'
    when 'platform_flow' then p_dependency ->> 'flowId'
    when 'application_flow' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'flowId')
    when 'application_flow_node' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'flowId')
        || ':' || (p_dependency ->> 'nodeId')
    when 'application_query' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'queryId')
    when 'module_query' then
      (p_dependency ->> 'moduleRootId') || ':' || (p_dependency ->> 'queryId')
    when 'application_form' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'formId')
    when 'application_workflow' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'workflowId')
    when 'application_action' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'actionId')
    when 'protected_operation' then
      (p_dependency #>> '{operation,owner,kind}') || ':'
        || case p_dependency #>> '{operation,owner,kind}'
          when 'application' then p_dependency #>> '{operation,owner,applicationRootId}'
          when 'module' then p_dependency #>> '{operation,owner,moduleRootId}'
          when 'platform_service' then p_dependency #>> '{operation,owner,serviceId}'
        end
        || ':' || (p_dependency #>> '{operation,operationId}')
    else null
  end
$$;


ALTER FUNCTION vortex_definition.flow_target_dependency_reference(p_dependency jsonb) OWNER TO postgres;

COMMENT ON FUNCTION vortex_definition.flow_target_dependency_reference(p_dependency jsonb) IS 'Owner-private canonical subject reference of one flow-target dependency manifest entry.';

REVOKE ALL ON FUNCTION vortex_definition.flow_target_dependency_reference(p_dependency jsonb) FROM PUBLIC;
