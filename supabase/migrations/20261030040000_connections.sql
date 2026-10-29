grant usage on schema vault to vortex_owner;
grant execute on function vault.create_secret(text, text, text, uuid) to vortex_owner;
grant delete on table vault.secrets to vortex_owner;
grant select on table vault.decrypted_secrets to vortex_owner;
grant execute on function vault._crypto_aead_det_decrypt(bytea, bytea, bigint, bytea, bytea) to vortex_owner;
set local role vortex_owner;

create table vortex_platform.connection_execution_tickets (
  ticket_id uuid primary key,
  organization_id uuid not null,
  account_id uuid not null,
  correlation_id uuid not null,
  connection_instance_id uuid not null,
  command_id uuid not null,
  instance_revision bigint not null,
  operation text not null check (operation = 'health_check'),
  expires_at timestamptz not null,
  credential_read_at timestamptz,
  completed_at timestamptz,
  foreign key (connection_instance_id, organization_id)
    references vortex_platform.connection_instances(connection_instance_id, organization_id)
);
create index connection_execution_tickets_expiry on vortex_platform.connection_execution_tickets (expires_at);
revoke all on table vortex_platform.connection_execution_tickets
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
create table vortex_platform.connection_secret_references (
  secret_reference_id uuid primary key,
  vault_secret_id uuid,
  organization_id uuid not null references vortex_identity.organizations(organization_id),
  account_id uuid not null,
  connection_instance_id uuid,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  foreign key (connection_instance_id, organization_id)
    references vortex_platform.connection_instances(connection_instance_id, organization_id),
  check (expires_at > created_at),
  check ((claimed_at is null and connection_instance_id is null and vault_secret_id is not null)
    or (claimed_at is not null and ((connection_instance_id is null and vault_secret_id is null)
      or (connection_instance_id is not null and vault_secret_id is not null))))
);
create unique index connection_secret_references_instance_unique
  on vortex_platform.connection_secret_references (organization_id, connection_instance_id)
  where connection_instance_id is not null;
revoke all on table vortex_platform.connection_secret_references
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;


create or replace function vortex_platform.list_connection_instances_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb)
language plpgsql volatile security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_value text;
  after_record_id uuid;
  predicate_plan jsonb;
begin
  if p_sort_key is null or p_sort_key not in ('record_id', 'destination_key', 'state')
    or p_direction is null or p_direction not in ('ascending', 'descending')
    or (p_limit is not null and p_limit not between 1 and 500)
    or (p_limit is null and (p_record_ids is null or cardinality(p_record_ids) > 500)) then
    raise exception using errcode = '22023', message = 'Connection projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Connection projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Connection projection cursor is invalid';
    end;
    after_value := p_after -> 'sortKey' ->> 0;
  end if;
  context_value := vortex_access.validated_human_request_context();
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  perform vortex_platform.assert_connection_administration_authority(context_value);

  sort_column := case p_sort_key
    when 'destination_key' then 'conn.destination_key'
    when 'state' then 'conn.state'
    else 'conn.connection_instance_id' end;
  if p_after is not null then
    keyset_sql := case when p_sort_key = 'record_id' then
      pg_catalog.format(' and conn.connection_instance_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end)
    else pg_catalog.format(' and (%s collate "C", conn.connection_instance_id) %s ($3 collate "C", $4)',
      sort_column, case when p_direction = 'ascending' then '>' else '<' end) end;
  end if;
  order_sql := case when p_sort_key = 'record_id' then
    pg_catalog.format('conn.connection_instance_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
  else pg_catalog.format('%1$s collate "C" %2$s, conn.connection_instance_id %2$s',
    sort_column, case when p_direction = 'ascending' then 'asc' else 'desc' end) end;

  predicate_plan := vortex_record.compile_projection_predicate_internal(p_predicate,
    $declared${
      "destination_key": {"sql": "conn.destination_key", "database": "text", "filter": true, "search": true},
      "state": {"sql": "conn.state", "database": "text", "filter": true}
    }$declared$::jsonb, 6);
  return query execute $scan$
    select conn.organization_id, conn.connection_instance_id, conn.revision,
      pg_catalog.jsonb_build_object(
        'destination_key', conn.destination_key,
        'connection_type_id', conn.connection_type_id,
        'connection_type_version', conn.connection_type_version,
        'state', conn.state,
        'last_health_outcome', conn.last_health_outcome,
        'token_expires_at', conn.token_expires_at
      )
    from vortex_platform.connection_instances as conn
    where conn.organization_id = $1
      and ($2 is null or conn.connection_instance_id = any($2))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql
    || pg_catalog.format(' order by %s limit $5', order_sql)
  using visible_organization_id, p_record_ids, after_value, after_record_id,
    coalesce(p_limit, 500), predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_platform.list_connection_instances_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.list_connection_instances_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_platform.list_connection_instances_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;

alter table vortex_record.protected_read_model_views
  drop constraint protected_read_model_views_protected_read_model_key_check;
alter table vortex_record.protected_read_model_views
  add constraint protected_read_model_views_protected_read_model_key_check
  check (protected_read_model_key = any (array[
    'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
    'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
    'permissions', 'role_activations', 'delegations', 'tenants',
    'tenant_administrators', 'installed_applications', 'application_role_templates',
    'activity_entry', 'application_store_entries', 'connection_instances'
  ]));

alter table vortex_record.storage_catalogue
  drop constraint storage_catalogue_protected_read_model_key_check;
alter table vortex_record.storage_catalogue
  add constraint storage_catalogue_protected_read_model_key_check
  check (
    (physical_schema_token = 'system_projection') = (protected_read_model_key is not null)
    and (protected_read_model_key is null or protected_read_model_key = any (array[
      'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
      'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
      'permissions', 'role_activations', 'delegations', 'tenants',
      'tenant_administrators', 'installed_applications', 'application_role_templates',
      'activity_entry', 'application_store_entries', 'connection_instances'
    ]))
  );

insert into vortex_record.protected_read_model_views (
  protected_read_model_key, reader_schema, reader_function, changed_at, cursor_sort_keys
) values (
  'connection_instances', 'vortex_platform', 'list_connection_instances_projection',
  pg_catalog.statement_timestamp(), array['record_id', 'destination_key', 'state']::text[]
);

create or replace function vortex_platform.store_connection_secret(p_secret text)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_value uuid;
  account_value uuid;
  reference_value uuid := pg_catalog.gen_random_uuid();
  secret_value uuid;
  now_value timestamptz := pg_catalog.statement_timestamp();
begin
  if p_secret is null or pg_catalog.char_length(p_secret) not between 1 and 8192
    or pg_catalog.octet_length(p_secret) > 32768 then
    raise exception using errcode = '22023', message = 'Connection secret input is invalid';
  end if;
  perform vortex_platform.assert_human_administration_request();
  context_value := vortex_platform.validated_administration_context(vortex_platform.organization_id());
  organization_value := (context_value ->> 'organizationId')::uuid;
  account_value := (context_value ->> 'organizationAccountId')::uuid;
  -- Serialise this account's admissions so parallel requests cannot bypass the bound.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    organization_value::text || ':' || account_value::text, 0));

  delete from vault.secrets as secret
  using vortex_platform.connection_secret_references as reference
  where reference.organization_id = organization_value
    and reference.expires_at <= now_value and reference.claimed_at is null
    and reference.vault_secret_id = secret.id;
  delete from vortex_platform.connection_secret_references as reference
  where reference.organization_id = organization_value and reference.expires_at <= now_value
    and (reference.claimed_at is null or reference.vault_secret_id is null);
  if (select pg_catalog.count(*) from vortex_platform.connection_secret_references as reference
      where reference.organization_id = organization_value and reference.account_id = account_value
        and reference.created_at > now_value - interval '1 minute') >= 10 then
    raise exception using errcode = 'P0001', message = 'Connection secret rate limit reached';
  end if;
  secret_value := vault.create_secret(p_secret);
  insert into vortex_platform.connection_secret_references (
    secret_reference_id, vault_secret_id, organization_id, account_id, created_at, expires_at
  ) values (
    reference_value, secret_value, organization_value, account_value,
    now_value, now_value + interval '10 minutes'
  );
  return reference_value;
end
$function$;

revoke all on function vortex_platform.store_connection_secret(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.store_connection_secret(text) to vortex_request;
alter function vortex_platform.store_connection_secret(text) owner to vortex_owner;

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

create or replace function vortex_platform.issue_connection_execution_ticket(
  p_instance_id uuid, p_expected_revision bigint, p_operation text, p_command_id uuid
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  instance_row vortex_platform.connection_instances%rowtype;
  ticket_id uuid := pg_catalog.gen_random_uuid();
  now_value timestamptz := pg_catalog.clock_timestamp();
  receipt jsonb;
begin
  if p_instance_id is null or p_expected_revision is null or p_command_id is null or p_operation is distinct from 'health_check' then
    raise exception using errcode = '22023', message = 'Connection execution input is invalid';
  end if;
  perform vortex_platform.assert_human_administration_request();
  context_value := vortex_platform.validated_administration_context(vortex_platform.organization_id());
  receipt := vortex_record.claim_scoped_command_receipt_internal(
    'connection_health_check', p_command_id, (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'tenantId')::uuid, (context_value ->> 'organizationAccountId')::uuid,
    'Connection command is unavailable'
  );
  if receipt is not null then return receipt; end if;
  select conn.* into instance_row from vortex_platform.connection_instances as conn
  where conn.organization_id = (context_value ->> 'organizationId')::uuid
    and conn.connection_instance_id = p_instance_id and conn.revision = p_expected_revision
    and conn.state <> 'revoked' and conn.revision < 9007199254740991
  for update;
  if not found then
    receipt := pg_catalog.jsonb_build_object('outcome', 'conflict');
    perform vortex_record.complete_scoped_command_receipt_internal(p_command_id, receipt);
    return receipt;
  end if;
  now_value := pg_catalog.clock_timestamp();
  delete from vortex_platform.connection_execution_tickets where ticket_id in (
    select ticket.ticket_id from vortex_platform.connection_execution_tickets as ticket
    where ticket.expires_at <= now_value order by ticket.expires_at limit 500
  );
  insert into vortex_platform.connection_execution_tickets (
    ticket_id, organization_id, account_id, correlation_id, connection_instance_id, command_id,
    instance_revision, operation, expires_at
  ) values (
    ticket_id, instance_row.organization_id, (context_value ->> 'organizationAccountId')::uuid,
    (context_value ->> 'correlationId')::uuid, p_instance_id, p_command_id, p_expected_revision,
    p_operation, now_value + interval '60 seconds'
  );
  return pg_catalog.jsonb_build_object('outcome', 'available', 'ticket', ticket_id,
    'connectionTypeId', instance_row.connection_type_id,
    'connectionTypeVersion', instance_row.connection_type_version);
end
$function$;

revoke all on function vortex_platform.issue_connection_execution_ticket(uuid, bigint, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.issue_connection_execution_ticket(uuid, bigint, text, uuid) to vortex_request;
alter function vortex_platform.issue_connection_execution_ticket(uuid, bigint, text, uuid) owner to vortex_owner;

create or replace function vortex_platform.read_connection_credential_for_execution(p_ticket uuid)
returns text
language plpgsql volatile security definer
set search_path = ''
as $function$
declare
  ticket_row vortex_platform.connection_execution_tickets%rowtype;
  context_value jsonb;
  credential text;
begin
  context_value := vortex_access.validated_human_request_context();
  update vortex_platform.connection_execution_tickets as ticket
  set credential_read_at = pg_catalog.clock_timestamp()
  where ticket.ticket_id = p_ticket
    and ticket.organization_id = (context_value ->> 'organizationId')::uuid
    and ticket.account_id = (context_value ->> 'organizationAccountId')::uuid
    and ticket.correlation_id = (context_value ->> 'correlationId')::uuid
    and ticket.expires_at > pg_catalog.clock_timestamp()
    and ticket.credential_read_at is null and ticket.completed_at is null
  returning ticket.* into ticket_row;
  if not found then raise exception using errcode = '42501', message = 'Connection execution is unavailable'; end if;
  select secret.decrypted_secret into strict credential
  from vortex_platform.connection_instances as conn
  join vortex_platform.connection_secret_references as reference
    on reference.organization_id = conn.organization_id
    and reference.connection_instance_id = conn.connection_instance_id
    and reference.claimed_at is not null
  join vault.decrypted_secrets as secret on secret.id = reference.vault_secret_id
  where conn.organization_id = ticket_row.organization_id
    and conn.connection_instance_id = ticket_row.connection_instance_id
    and conn.revision = ticket_row.instance_revision and conn.state <> 'revoked';
  return credential;
end
$function$;

revoke all on function vortex_platform.read_connection_credential_for_execution(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.read_connection_credential_for_execution(uuid) to vortex_runtime;
alter function vortex_platform.read_connection_credential_for_execution(uuid) owner to vortex_owner;

create or replace function vortex_platform.record_connection_health_result(p_ticket uuid, p_outcome text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $function$
declare
  ticket_row vortex_platform.connection_execution_tickets%rowtype;
  context_value jsonb;
  activity_id uuid := pg_catalog.gen_random_uuid();
  now_value timestamptz := pg_catalog.clock_timestamp();
  new_revision bigint;
  activity_result text;
begin
  if p_outcome is null or p_outcome not in ('healthy', 'unhealthy', 'unknown', 'no_adapter') then
    raise exception using errcode = '22023', message = 'Connection health outcome is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  update vortex_platform.connection_execution_tickets as ticket
  set completed_at = now_value
  where ticket.ticket_id = p_ticket and ticket.operation = 'health_check'
    and ticket.organization_id = (context_value ->> 'organizationId')::uuid
    and ticket.account_id = (context_value ->> 'organizationAccountId')::uuid
    and ticket.correlation_id = (context_value ->> 'correlationId')::uuid
    and ticket.expires_at > now_value and ticket.completed_at is null
    and (p_outcome in ('unknown', 'no_adapter') or ticket.credential_read_at is not null)
  returning ticket.* into ticket_row;
  if not found then raise exception using errcode = '42501', message = 'Connection execution is unavailable'; end if;
  update vortex_platform.connection_instances as conn
  set last_health_outcome = case when p_outcome = 'no_adapter' then 'unknown' else p_outcome end,
    state = case p_outcome when 'healthy' then 'active' when 'unhealthy' then 'unhealthy' else 'pending' end,
    revision = conn.revision + 1, updated_at = now_value, administrator_activity_id = activity_id
  where conn.organization_id = ticket_row.organization_id
    and conn.connection_instance_id = ticket_row.connection_instance_id
    and conn.revision = ticket_row.instance_revision and conn.state <> 'revoked'
  returning conn.revision into new_revision;
  if not found then raise exception using errcode = '40001', message = 'Connection execution is stale'; end if;
  activity_result := vortex_record.append_organization_activity_entry(
    ticket_row.organization_id, activity_id, now_value, 'organization_account', ticket_row.account_id,
    'connection_health_check', array[ticket_row.connection_instance_id]::uuid[], array[]::uuid[],
    vortex_platform.channel(), ticket_row.correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Connection health Activity is stale';
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(ticket_row.command_id,
    pg_catalog.jsonb_build_object('outcome', 'completed', 'revision', new_revision, 'healthOutcome', p_outcome));
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'revision', new_revision, 'healthOutcome', p_outcome);
end
$function$;

revoke all on function vortex_platform.record_connection_health_result(uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.record_connection_health_result(uuid, text) to vortex_runtime;
alter function vortex_platform.record_connection_health_result(uuid, text) owner to vortex_owner;

reset role;
