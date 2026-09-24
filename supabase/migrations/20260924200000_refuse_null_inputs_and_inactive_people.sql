-- #854: refuse null inputs and inactive people in the record and offboarding
-- functions.
--
-- `x not in (...)` and `x not between a and b` evaluate to null for a null `x`,
-- and an `if` or a chained `or` treats null as not-true, so a null selector
-- slipped past several guards: the offboarding inventory classified a null
-- target kind as transferable and a null limit as no limit; the ownership
-- transfers, the named-action set-fields writer and the record facts loader
-- accepted a null expected revision, target kind, owner kind, release revision
-- or action kind; the field-bounds resolver accepted a decision with no
-- outcome; and the recent-authentication helper treated a requirement it could
-- not evaluate (unknown kind, no maximum age) as satisfied. Each guard now
-- refuses null explicitly.
--
-- Three further defects are corrected in the same functions:
--
-- * The transfer target check accepted any `active` account, so a record could
--   be transferred to a person whose identity was suspended or closed. It now
--   applies the identity, organisation and tenant conditions of
--   `vortex_identity.is_active_organization_account_reference_internal`
--   (20260915040000) while keeping the share lock on the rows it checked.
-- * Retrying a completed offboarding transfer reported `refused` instead of the
--   original result. The completed receipt now returns the same `transferred`
--   outcome, record and revision the first call returned, marked replayed.
-- * Money-typed calculation and total fields are stored as `json`, so the
--   canonical value check accepted any JSON for them. They are now held to the
--   canonical money shape a money field already requires.
--
-- Transfer and offboarding rules are otherwise unchanged.
--
-- Main rewrites several of these functions in place, so every live body is
-- patched from its current `pg_get_functiondef` with an exactly-once guard:
-- ownership, grants, comments and dependencies are untouched, and drift fails
-- the migration instead of silently editing an unexpected body.

begin;

do $migration$
declare
  targets constant jsonb := pg_catalog.jsonb_build_array(
    -- Recent-authentication helper: a null (unevaluable) requirement is not
    -- satisfied, so it must return null rather than fall through to the
    -- context expiry.
    pg_catalog.jsonb_build_array(
      'vortex_access.recent_authentication_deadline_internal(jsonb,timestamptz,jsonb)',
      $p$  if not satisfied then$p$,
      $p$  if satisfied is not true then$p$
    ),

    -- Field-bounds resolver: a decision without an outcome is not allowed.
    pg_catalog.jsonb_build_array(
      'vortex_access.resolve_record_field_bounds_internal(jsonb)',
      $p$  if p_decision ->> 'outcome' <> 'allowed' then$p$,
      $p$  if p_decision ->> 'outcome' is distinct from 'allowed' then$p$
    ),

    -- Transfer target: a null kind is refused, and an account target must have
    -- an active identity in an active organisation and tenant.
    pg_catalog.jsonb_build_array(
      'vortex_access.lock_active_record_ownership_target_internal(text,uuid)',
      $p$  if p_kind not in ('organization_account', 'group')$p$,
      $p$  if p_kind is null
    or p_kind not in ('organization_account', 'group')$p$,
      $p$    from vortex_identity.organization_accounts as account
    where account.organization_id = (context_value ->> 'organizationId')::uuid
      and account.organization_account_id = p_target_id
      and account.state = 'active'
    for share of account;$p$,
      $p$    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as projection
      on projection.identity_id = account.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where account.organization_id = (context_value ->> 'organizationId')::uuid
      and account.organization_account_id = p_target_id
      and account.state = 'active'
      and projection.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
    for share of account, projection;$p$
    ),

    -- Ordinary single-record ownership transfer.
    pg_catalog.jsonb_build_array(
      'vortex_record.transfer_record_ownership(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid)',
      $p$    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind not in ('organization_account', 'group')$p$,
      $p$    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind is null
    or p_target_kind not in ('organization_account', 'group')$p$
    ),

    -- Offboarding ownership transfer: null refusals and the original result on
    -- retry of a completed transfer.
    pg_catalog.jsonb_build_array(
      'vortex_record.transfer_record_ownership_for_offboarding_internal(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid)',
      $p$    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind <> 'organization_account' or p_target_id is null$p$,
      $p$    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind is distinct from 'organization_account' or p_target_id is null$p$,
      $p$    end if;
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  loaded := vortex_record.load_offboarding_ownership_transfer_facts_internal($p$,
      $p$    end if;
    return pg_catalog.jsonb_build_object('outcome','transferred','recordId',receipt.record_id,
      'concurrencyNumber',receipt.concurrency_number,'correlationId',context_value -> 'correlationId','replayed',true);
  end if;
  loaded := vortex_record.load_offboarding_ownership_transfer_facts_internal($p$
    ),

    -- Offboarding inventory, application-contained section.
    pg_catalog.jsonb_build_array(
      'vortex_record.list_offboarding_owned_records_internal(uuid,text,uuid,uuid,uuid,integer)',
      $p$    or p_target_kind not in ('organization_account', 'group')
    or p_limit not between 1 and 50$p$,
      $p$    or p_target_kind is null
    or p_target_kind not in ('organization_account', 'group')
    or p_limit is null
    or p_limit not between 1 and 50$p$
    ),

    -- Offboarding inventory, organisation-shared section.
    pg_catalog.jsonb_build_array(
      'vortex_record.list_offboarding_owned_shared_records_internal(uuid,text,uuid,uuid,uuid,integer)',
      $p$    or p_target_kind not in ('organization_account', 'group')
    or p_limit not between 1 and 50$p$,
      $p$    or p_target_kind is null
    or p_target_kind not in ('organization_account', 'group')
    or p_limit is null
    or p_limit not between 1 and 50$p$
    ),

    -- Offboarding inventory entry: a null section is invalid, not the
    -- application section.
    pg_catalog.jsonb_build_array(
      'vortex_record.list_offboarding_owned_records(uuid,text,uuid,text,uuid,uuid,integer)',
      $p$  if p_section_kind <> 'application' then$p$,
      $p$  if p_section_kind is distinct from 'application' then$p$
    ),

    -- Named-action set-fields writer.
    pg_catalog.jsonb_build_array(
      'vortex_record.save_named_action_set_fields_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,text,uuid,bigint,uuid,jsonb)',
      $p$    or p_action_owner_kind not in ('application', 'module')$p$,
      $p$    or p_action_owner_kind is null
    or p_action_owner_kind not in ('application', 'module')$p$,
      $p$    or p_action_release_revision not between 1 and 9007199254740991$p$,
      $p$    or p_action_release_revision is null
    or p_action_release_revision not between 1 and 9007199254740991$p$,
      $p$      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990$p$,
      $p$      p_record_id is null
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990$p$
    ),

    -- Record facts loader: a null action kind is not a valid selector.
    pg_catalog.jsonb_build_array(
      'vortex_record.load_record_access_facts_internal(uuid,text,uuid,bigint)',
      $p$    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore')$p$,
      $p$    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore')$p$
    ),

    -- Canonical value check: a money-typed calculation or total (stored as
    -- json, the only calculation/total result type that is) must be a canonical
    -- money value exactly as a money field must.
    pg_catalog.jsonb_build_array(
      'vortex_record.canonical_record_value_matches(jsonb,text,text)',
      $p$  if p_field_type = 'money' then$p$,
      $p$  if p_field_type = 'money'
    or (p_field_type in ('calculation', 'total') and p_database_value_type = 'json') then$p$
    )
  );

  target jsonb;
  procedure_id pg_catalog.regprocedure;
  patch_index integer;
  old_text text;
  new_text text;
  occurrences integer;
  definition text;
begin
  for target in
    select item.value
    from pg_catalog.jsonb_array_elements(targets) as item(value)
  loop
    procedure_id := (target ->> 0)::pg_catalog.regprocedure;
    definition := pg_catalog.pg_get_functiondef(procedure_id);
    if definition is null then
      raise exception using errcode = '55000',
        message = 'Null-refusal patch target is unavailable',
        detail = procedure_id::text;
    end if;
    definition := pg_catalog.replace(definition, E'\r\n', E'\n');
    patch_index := 1;
    while patch_index < pg_catalog.jsonb_array_length(target) loop
      old_text := target ->> patch_index;
      new_text := target ->> (patch_index + 1);
      occurrences := (
        pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, old_text, ''))
      ) / pg_catalog.length(old_text);
      if occurrences <> 1 then
        raise exception using errcode = '55000',
          message = 'Null-refusal patch does not match exactly once',
          detail = procedure_id::text;
      end if;
      definition := pg_catalog.replace(definition, old_text, new_text);
      patch_index := patch_index + 2;
    end loop;

    -- CREATE OR REPLACE keeps the function's owner, grants, comment and OID.
    execute definition;
  end loop;
end
$migration$;

commit;
