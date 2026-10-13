CREATE OR REPLACE FUNCTION vortex_definition.record_application_installation_outcome(p_activity_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_state text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  authority record;
  pin_count integer;
  changed_count integer;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or p_state is null
    or p_state not in ('active', 'detached') then
    raise exception using errcode = '22023',
      message = 'Application installation outcome command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );

  -- Activity records only a change this transaction made: every pinned binding
  -- must be in the reported state for this exact release and changed since this
  -- transaction began. The fixed activate/detach operations stamp changed_at
  -- with their statement time and keep the rows locked until commit, so a
  -- binding they changed here satisfies this and an untouched one does not.
  select pg_catalog.count(*)::integer into changed_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  join vortex_definition.installation_bindings as binding
    on binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id
  where binding.state = p_state
    and binding.application_release_revision = p_application_release_revision
    and binding.module_release_revision = required.target_release_revision
    and binding.changed_at >= pg_catalog.transaction_timestamp();

  if pin_count = 0 or changed_count <> pin_count then
    raise exception using errcode = '40001',
      message = 'Application installation outcome is not a change of this transaction';
  end if;

  perform vortex_definition.append_application_installation_activity_internal(
    p_activity_id,
    p_application_root_id,
    case p_state
      when 'active' then 'activate_application_installation'
      else 'withdraw_application_installation'
    end
  );
end
$$;
alter function vortex_definition.record_application_installation_outcome(uuid,uuid,bigint,text) owner to vortex_owner;


COMMENT ON FUNCTION vortex_definition.record_application_installation_outcome(p_activity_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_state text) IS 'Appends content-free Activity for an Application activation or withdrawal made earlier in the same protected transaction.';

REVOKE ALL ON FUNCTION vortex_definition.record_application_installation_outcome(p_activity_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_state text) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_definition.record_application_installation_outcome(p_activity_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_state text) TO vortex_request;
