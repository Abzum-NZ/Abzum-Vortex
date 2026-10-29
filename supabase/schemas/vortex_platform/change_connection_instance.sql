create or replace function vortex_platform.change_connection_instance(
  p_operation text, p_instance_id uuid, p_expected_revision bigint,
  p_type_id uuid, p_type_version text, p_destination_key text, p_destination_fingerprint text,
  p_secret_reference_id uuid, p_activity_id uuid, p_command_id uuid
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_value uuid;
  account_value uuid;
  instance_row vortex_platform.connection_instances%rowtype;
  reference_row vortex_platform.connection_secret_references%rowtype;
  now_value timestamptz := pg_catalog.statement_timestamp();
  new_revision bigint;
  activity_result text;
  receipt jsonb;
  result_value jsonb;
begin
  if p_operation not in ('create', 'edit', 'revoke') or p_operation is null
    or p_instance_id is null or p_activity_id is null or p_command_id is null
    or p_instance_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Connection command input is invalid';
  end if;
  if p_operation in ('create', 'edit') and (
    p_destination_key is null or p_destination_key !~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'
    or pg_catalog.char_length(p_destination_key) not between 1 and 80
    or p_destination_fingerprint is null or p_destination_fingerprint !~ '^[a-f0-9]{64}$'
  ) then
    raise exception using errcode = '22023', message = 'Connection command input is invalid';
  end if;
  if p_operation = 'create' and (p_type_id is null
    or p_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_type_version is null or p_type_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    or p_secret_reference_id is null or p_expected_revision is not null) then
    raise exception using errcode = '22023', message = 'Connection command input is invalid';
  end if;
  if p_operation = 'revoke' and p_secret_reference_id is not null then
    raise exception using errcode = '22023', message = 'Connection command input is invalid';
  end if;
  if p_operation <> 'create' and (p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990) then
    raise exception using errcode = '22023', message = 'Connection command input is invalid';
  end if;
  perform vortex_platform.assert_human_administration_request();
  context_value := vortex_platform.validated_administration_context(vortex_platform.organization_id());
  organization_value := (context_value ->> 'organizationId')::uuid;
  account_value := (context_value ->> 'organizationAccountId')::uuid;
  receipt := vortex_record.claim_scoped_command_receipt_internal(
    'connection_' || p_operation, p_command_id, organization_value,
    (context_value ->> 'tenantId')::uuid, account_value,
    'Connection command is unavailable'
  );
  if receipt is not null then return receipt; end if;

  if p_operation <> 'create' then
    select conn.* into instance_row from vortex_platform.connection_instances as conn
    where conn.organization_id = organization_value and conn.connection_instance_id = p_instance_id
    for update;
    if not found or instance_row.revision <> p_expected_revision or instance_row.state = 'revoked' then
      result_value := pg_catalog.jsonb_build_object('outcome', 'conflict');
      perform vortex_record.complete_scoped_command_receipt_internal(p_command_id, result_value);
      return result_value;
    end if;
  end if;
  if p_secret_reference_id is not null then
    select reference.* into reference_row
    from vortex_platform.connection_secret_references as reference
    where reference.secret_reference_id = p_secret_reference_id
      and reference.organization_id = organization_value and reference.account_id = account_value
      and reference.claimed_at is null and reference.vault_secret_id is not null
      and reference.expires_at > pg_catalog.clock_timestamp()
    for update;
    if not found then
      raise exception using errcode = '22023', message = 'Connection secret reference is invalid';
    end if;
  end if;
  if p_operation = 'create' then
    insert into vortex_platform.connection_instances (
      connection_instance_id, organization_id, connection_type_id, connection_type_version,
      destination_key, destination_fingerprint, state, last_health_outcome, revision,
      administrator_activity_id, created_at, updated_at
    ) values (
      p_instance_id, organization_value, p_type_id, p_type_version,
      p_destination_key, p_destination_fingerprint, 'pending', 'unknown', 1,
      p_activity_id, now_value, now_value
    );
    new_revision := 1;
  else
    update vortex_platform.connection_instances as conn
    set destination_key = case when p_operation = 'edit' then p_destination_key else conn.destination_key end,
      destination_fingerprint = case when p_operation = 'edit' then p_destination_fingerprint else conn.destination_fingerprint end,
      state = case when p_operation = 'revoke' then 'revoked' else 'pending' end,
      last_health_outcome = 'unknown', revision = conn.revision + 1,
      administrator_activity_id = p_activity_id, updated_at = now_value
    where conn.organization_id = organization_value and conn.connection_instance_id = p_instance_id
    returning conn.revision into new_revision;
  end if;
  if p_operation = 'revoke' or p_secret_reference_id is not null then
    delete from vault.secrets as secret using vortex_platform.connection_secret_references as reference
    where reference.organization_id = organization_value and reference.connection_instance_id = p_instance_id
      and reference.vault_secret_id = secret.id;
    update vortex_platform.connection_secret_references as reference
    set vault_secret_id = null, connection_instance_id = null
    where reference.organization_id = organization_value and reference.connection_instance_id = p_instance_id;
  end if;
  if p_secret_reference_id is not null then
    update vortex_platform.connection_secret_references
    set claimed_at = now_value, connection_instance_id = p_instance_id
    where secret_reference_id = p_secret_reference_id;
  end if;
  activity_result := vortex_record.append_organization_activity_entry(
    organization_value, p_activity_id, now_value, 'organization_account', account_value,
    'connection_' || p_operation, array[p_instance_id]::uuid[], array[]::uuid[],
    vortex_platform.channel(), (context_value ->> 'correlationId')::uuid, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Connection Activity is stale';
  end if;
  result_value := pg_catalog.jsonb_build_object('outcome', 'completed', 'connectionInstanceId', p_instance_id,
    'revision', new_revision);
  perform vortex_record.complete_scoped_command_receipt_internal(p_command_id, result_value);
  return result_value;
end
$function$;

revoke all on function vortex_platform.change_connection_instance(text, uuid, bigint, uuid, text, text, text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.change_connection_instance(text, uuid, bigint, uuid, text, text, text, uuid, uuid, uuid)
  to vortex_request;
alter function vortex_platform.change_connection_instance(text, uuid, bigint, uuid, text, text, text, uuid, uuid, uuid)
  owner to vortex_owner;
