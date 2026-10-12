CREATE FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  scope record;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  created record; command_fingerprint text; target_invitation_id uuid;
  subject_ids uuid[]; subject_revisions bigint[];
  operation_at timestamptz;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_invited_email is null
    or p_invited_email <> pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or pg_catalog.char_length(p_invited_email) not between 3 and 320
    or p_invited_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or p_token_fingerprint is null
    or p_token_fingerprint !~ '^sha256:[0-9a-f]{64}$'
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
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = scope.organization_account_id
    and stored.tenant_id = scope.tenant_id
    and stored.operation_key = 'create_organization_invitation'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(receipt.subject_ids) <> 2
      or not scope.organization_id = any(receipt.subject_ids) then
      raise exception using errcode = '42501', message = 'Invitation creation receipt is unavailable';
    end if;
    target_invitation_id := case when receipt.subject_ids[1] = scope.organization_id
      then receipt.subject_ids[2] else receipt.subject_ids[1] end;
    return query select 'replayed'::text, 'create_organization_invitation'::text,
      scope.organization_id, target_invitation_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, target_invitation_id)],
      receipt.receipt_id, receipt.accepted_at,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, scope.organization_id)];
    return;
  end if;
  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at <= operation_at then
    raise exception using errcode = '40001', message = 'Invitation creation is stale or unavailable';
  end if;
  select result.* into strict created
  from vortex_identity.create_organization_invitation(
    p_invited_email, p_token_fingerprint, p_expires_at
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
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid,
    scope.organization_account_id, scope.tenant_id,
    'create_organization_invitation', p_duplicate_key, command_fingerprint,
    subject_ids, subject_revisions, created.created_at
  ) returning * into receipt;
  return query select 'accepted'::text, 'create_organization_invitation'::text,
    scope.organization_id, created.invitation_id, created.revision,
    receipt.receipt_id, receipt.accepted_at, scope.access_version;
end
$_$;


ALTER FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) IS 'Protected no-intent invitation creation; replay returns receipt evidence and never secret material.';

REVOKE ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) TO vortex_request;
