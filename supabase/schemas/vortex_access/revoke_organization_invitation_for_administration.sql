CREATE FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  revoked record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_invitation_id is null or not vortex_context.is_non_nil_uuid(p_invitation_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Invitation revocation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_organization_invitation',
      scope.organization_id::text, p_invitation_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = scope.organization_account_id
    and stored.tenant_id = scope.tenant_id
    and stored.operation_key = 'revoke_organization_invitation'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(receipt.subject_ids) <> 2
      or not scope.organization_id = any(receipt.subject_ids)
      or not p_invitation_id = any(receipt.subject_ids) then
      raise exception using errcode = '42501', message = 'Invitation revocation receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'revoke_organization_invitation'::text,
      scope.organization_id, p_invitation_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, p_invitation_id)],
      receipt.receipt_id, receipt.accepted_at,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, scope.organization_id)];
    return;
  end if;
  if p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Invitation revocation is stale or unavailable';
  end if;
  select result.* into strict revoked
  from vortex_identity.revoke_organization_invitation(
    p_invitation_id, p_expected_revision
  ) as result;
  if revoked.organization_id <> scope.organization_id
    or revoked.invitation_id <> p_invitation_id
    or revoked.revision <> p_expected_revision + 1
    or revoked.accepted_at is not null or revoked.revoked_at is null
    or revoked.revoked_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation revocation result is unavailable';
  end if;
  if scope.organization_id < p_invitation_id then
    subject_ids := array[scope.organization_id, p_invitation_id];
    subject_revisions := array[scope.access_version, revoked.revision];
  else
    subject_ids := array[p_invitation_id, scope.organization_id];
    subject_revisions := array[revoked.revision, scope.access_version];
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid,
    scope.organization_account_id, scope.tenant_id,
    'revoke_organization_invitation', p_duplicate_key, command_fingerprint,
    subject_ids, subject_revisions, revoked.changed_at
  ) returning * into receipt;
  return query select 'accepted'::text, 'revoke_organization_invitation'::text,
    scope.organization_id, p_invitation_id, revoked.revision,
    receipt.receipt_id, receipt.accepted_at, scope.access_version;
end
$$;


ALTER FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) IS 'Protected pending invitation revocation, including expired invitations, using the existing Identity owner.';

REVOKE ALL ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) TO vortex_request;
