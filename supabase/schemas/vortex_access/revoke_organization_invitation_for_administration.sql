CREATE OR REPLACE FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  stored record; claimed jsonb;
  new_receipt_id uuid; new_accepted_at timestamptz;
  revoked record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invitation_id is null or not vortex_platform.is_non_nil_uuid(p_invitation_id::text)
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
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(stored."subjectIds") <> 2
      or not scope.organization_id = any(stored."subjectIds")
      or not p_invitation_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Invitation revocation receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'revoke_organization_invitation'::text,
      scope.organization_id, p_invitation_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", p_invitation_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
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
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := revoked.changed_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions),
      'fingerprint', command_fingerprint, 'clusterId', null));
  return query select 'accepted'::text, 'revoke_organization_invitation'::text,
    scope.organization_id, p_invitation_id, revoked.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$$;

alter function vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) IS 'Protected pending invitation revocation, including expired invitations, using the existing Identity owner.';

REVOKE ALL ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) TO vortex_request;

grant execute on function vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) to postgres;
