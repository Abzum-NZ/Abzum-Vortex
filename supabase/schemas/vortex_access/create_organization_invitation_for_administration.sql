CREATE OR REPLACE FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  scope record;
  stored record; claimed jsonb;
  new_receipt_id uuid; new_accepted_at timestamptz;
  created record; command_fingerprint text; target_invitation_id uuid;
  subject_ids uuid[]; subject_revisions bigint[];
  operation_at timestamptz;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invited_email is null
    or p_invited_email <> pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or pg_catalog.char_length(p_invited_email) not between 3 and 320
    or p_invited_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or p_expires_at is null
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz) then
    raise exception using errcode = '22023', message = 'Invitation creation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'create_organization_invitation',
      scope.organization_id::text, p_invited_email, p_expires_at::text), 'UTF8'),
      'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(stored."subjectIds") <> 2
      or not scope.organization_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Invitation creation receipt is unavailable';
    end if;
    target_invitation_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'create_organization_invitation'::text,
      scope.organization_id, target_invitation_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", target_invitation_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at <= operation_at then
    raise exception using errcode = '40001', message = 'Invitation creation is stale or unavailable';
  end if;
  select result.* into strict created
  from vortex_identity.create_organization_invitation(
    p_invited_email, p_expires_at
  ) as result;
  if created.organization_id <> scope.organization_id or created.revision <> 1
    or created.invited_email <> p_invited_email or created.expires_at <> p_expires_at
    or created.invited_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation creation result is unavailable';
  end if;
  if scope.organization_id < created.invitation_id then
    subject_ids := array[scope.organization_id, created.invitation_id];
    subject_revisions := array[scope.access_version, created.revision];
  else
    subject_ids := array[created.invitation_id, scope.organization_id];
    subject_revisions := array[created.revision, scope.access_version];
  end if;
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := created.created_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions),
      'fingerprint', command_fingerprint, 'clusterId', null));
  return query select 'accepted'::text, 'create_organization_invitation'::text,
    scope.organization_id, created.invitation_id, created.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$_$;

alter function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) IS 'Protected no-intent invitation creation; replay returns receipt evidence. The invited person accepts it after signing in with that verified email.';

REVOKE ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) TO vortex_request;

grant execute on function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) to postgres;
