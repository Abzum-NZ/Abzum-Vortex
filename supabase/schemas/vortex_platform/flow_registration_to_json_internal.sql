CREATE OR REPLACE FUNCTION vortex_platform.flow_registration_to_json_internal(r vortex_platform.flow_registrations) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select pg_catalog.jsonb_build_object(
    'environment', r.environment,
    'organizationId', r.organization_id,
    'applicationRootId', r.application_root_id,
    'applicationVersion', r.application_version,
    'installationRevision', r.installation_revision,
    'workflowRevision', r.workflow_revision,
    'namespace', r.namespace,
    'flowId', r.flow_id,
    'candidateFingerprint', r.candidate_fingerprint,
    'status', r.status,
    'registeredAt', pg_catalog.to_char(r.registered_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )
$$;

alter function vortex_platform.flow_registration_to_json_internal(r vortex_platform.flow_registrations) owner to vortex_owner;

COMMENT ON FUNCTION vortex_platform.flow_registration_to_json_internal(r vortex_platform.flow_registrations) IS 'Canonical private projection of one inactive flow registration; never granted above the owning runtime.';

REVOKE ALL ON FUNCTION vortex_platform.flow_registration_to_json_internal(r vortex_platform.flow_registrations) FROM PUBLIC;

grant execute on function vortex_platform.flow_registration_to_json_internal(r vortex_platform.flow_registrations) to postgres;
