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
