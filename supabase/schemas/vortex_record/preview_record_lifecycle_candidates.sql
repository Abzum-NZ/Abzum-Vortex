CREATE FUNCTION vortex_record.preview_record_lifecycle_candidates(p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_record_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  authority record;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  policy_row vortex_record.record_type_lifecycle_policies%rowtype;
  candidate_page jsonb;
begin
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_application_root_id is not null
      and p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or p_limit is null
    or p_limit not between 1 and 500
    or ((p_after_created_at is null) <> (p_after_record_id is null))
    or (p_after_record_id is not null
      and p_after_record_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle preview command is invalid';
  end if;

  select checked.* into strict authority
  from vortex_access.check_record_lifecycle_preview_authority() as checked;

  -- The resolved request scope must be application-bound exactly when the
  -- target is application-contained, and bound to the exact same application.
  if (p_application_root_id is null) <> (authority.application_root_id is null)
    or (p_application_root_id is not null
      and authority.application_root_id <> p_application_root_id) then
    raise exception using errcode = '42501',
      message = 'Record lifecycle preview is unavailable';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.state = 'active'
  for share;
  if not found
    or (catalogue_row.storage_scope = 'organization_shared')
      <> (p_application_root_id is null) then
    raise exception using errcode = '42501',
      message = 'Record lifecycle preview target is unavailable';
  end if;

  if not vortex_module.record_lifecycle_target_is_installed_internal(
    authority.organization_id, p_application_root_id, p_storage_contract_id
  ) then
    raise exception using errcode = '42501',
      message = 'Record lifecycle preview target is unavailable';
  end if;

  select stored.* into policy_row
  from vortex_record.record_type_lifecycle_policies as stored
  where stored.organization_id = authority.organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.application_root_id is not distinct from p_application_root_id
  for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'policyStatus', 'unavailable',
      'policy', null,
      'totalRetainedCount', 0,
      'records', '[]'::jsonb,
      'hasMore', false
    );
  end if;

  candidate_page := vortex_record.read_record_lifecycle_preview_candidates_internal(
    catalogue_row.physical_table_token,
    authority.organization_id,
    p_storage_contract_id,
    p_application_root_id,
    p_after_created_at,
    p_after_record_id,
    p_limit
  );

  return pg_catalog.jsonb_build_object(
    'policyStatus', 'available',
    'policy', policy_row.policy_body
  ) || candidate_page;
end
$$;

COMMENT ON FUNCTION vortex_record.preview_record_lifecycle_candidates(p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone, p_after_record_id uuid, p_limit integer) IS 'Protected read-only preview of record lifecycle policy and deterministic candidate records for #117 handoff; performs no mutation or deletion.';

REVOKE ALL ON FUNCTION vortex_record.preview_record_lifecycle_candidates(p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone, p_after_record_id uuid, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.preview_record_lifecycle_candidates(p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone, p_after_record_id uuid, p_limit integer) TO vortex_request;
