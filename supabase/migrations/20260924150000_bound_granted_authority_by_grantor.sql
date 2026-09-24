-- #840: granted authority never outlives, and is never granted to, the grantor.
--
-- Three defects, one rule (a grant is bounded by the grantor's own authority):
--
-- 1. `grant_tenant_administrator` and `change_tenant_administrator` accepted any
--    `p_expires_at` -- including none -- from an administrator whose own
--    authority expires, and allowed the subject to be the actor. A time-limited
--    administrator could therefore hand themselves, or anyone, authority that
--    outlasted their own.
-- 2. `grant_record_share_for_administration` allowed a share to the grantor's
--    own account with no expiry, which kept record access after the
--    time-limited role that justified it lapsed. The same unbounded expiry
--    applied to every other recipient.
-- 3. `grant_tenant_administrator` and `change_tenant_administrator` matched
--    duplicate-key replays against a caller-supplied `p_command_fingerprint`.
--
-- What changes:
--
-- * A subject equal to the actor (tenant assignments) or a recipient account
--   equal to the granting account (record shares) is refused with 42501.
-- * The stored `expires_at` is capped at the grantor's earliest authority
--   expiry. A missing or later requested expiry is clamped to that bound; a
--   bound that leaves no window after `p_starts_at` refuses with 42501. A
--   grantor whose authority does not expire is not affected.
--   - Tenant assignment: the earliest, over every capability being granted
--     plus `platform.tenant.administrators.manage` itself, of the latest expiry
--     among the actor's current assignments carrying that capability.
--   - Record share: the earliest `validUntil` of the grantor's admitted
--     share/read/update decisions. The decision's own `validUntil` is always
--     capped by the grantor's request-context (access token) expiry, which is
--     a session horizon rather than authority, so the same decision is
--     re-derived by `record_share_grantor_authority_until_internal` with only
--     that session horizon lifted. Admission is still the real decision the
--     function already makes; the re-derivation only measures how long the
--     admitted authority lasts (role assignment, Group membership, role
--     activation, the grantor's own direct share and relationship routes).
-- * The two tenant commands compute their command fingerprint in the database
--   from the command's own inputs (the same `sha256:` + digest shape other
--   administration commands use, timestamps rendered in UTC). The
--   `p_command_fingerprint` parameter stays in the signature so callers do not
--   change, keeps its format check, and is otherwise ignored. It is computed
--   from the requested values, before the cap, so a replay matches on what the
--   caller asked for.
--
-- Who may grant is unchanged. The live bodies are patched in place from
-- `pg_get_functiondef` (`change_tenant_administrator` was already rewritten by
-- 20260914160000): each reviewed fragment must occur exactly once or the
-- migration aborts, and each function is re-created under its own current
-- owner so its OID, grants, comment, security and search_path stay put.

begin;

create function vortex_identity.tenant_administrator_grant_expiry_cap(
  p_actor_identity_id uuid,
  p_tenant_id uuid,
  p_capabilities text[],
  p_evaluated_at timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select case when pg_catalog.min(bound.latest_expiry) = 'infinity'::timestamptz
      then null else pg_catalog.min(bound.latest_expiry) end
  from (
    select (
      select pg_catalog.max(coalesce(assignment.expires_at, 'infinity'::timestamptz))
      from vortex_identity.tenant_administrator_assignments as assignment
      where assignment.tenant_id = p_tenant_id
        and assignment.identity_id = p_actor_identity_id
        and assignment.revoked_at is null
        and assignment.starts_at <= p_evaluated_at
        and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
        and required.capability_key = any(assignment.capability_keys)
    ) as latest_expiry
    from pg_catalog.unnest(
      pg_catalog.array_append(p_capabilities, 'platform.tenant.administrators.manage')
    ) as required(capability_key)
  ) as bound
$function$;

revoke execute on function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamptz)
  from public,anon,authenticated,service_role,vortex_runtime,vortex_request,vortex_record_owner,vortex_record_adapter,vortex_module_owner;

comment on function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamptz) is
  'Private: the earliest time the actor loses any of the given tenant capabilities or platform.tenant.administrators.manage, from current assignments; null when none of them expires.';

-- How long a grantor's admitted record authority lasts, ignoring only the
-- request context's own expiry. The same eligibility and row-scope evaluators
-- the exact-record decision composes are called with the verified context's
-- `expiresAt` replaced by a far, finite horizon (they render validity with
-- `to_char`, which has no infinite form), so every remaining bound is real
-- authority. The earliest contribution wins, as in the decision itself. Null
-- means the authority does not expire. It never admits anything: the caller
-- has already been admitted by the real decision, and a re-derivation that no
-- longer admits refuses rather than guessing.
create function vortex_access.record_share_grantor_authority_until_internal(
  p_declaration jsonb,
  p_record_id uuid,
  p_facts jsonb,
  p_context jsonb
)
returns timestamptz
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  horizon constant timestamptz := '9999-01-01T00:00:00Z';
  horizon_context jsonb := p_context
    || pg_catalog.jsonb_build_object('expiresAt', '9999-01-01T00:00:00.000000Z');
  checked_at timestamptz := pg_catalog.clock_timestamp();
  eligibility jsonb;
  auth_deadline timestamptz;
  earliest timestamptz;
begin
  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, horizon_context, checked_at
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant authority is unavailable';
  end if;
  auth_deadline := vortex_access.recent_authentication_deadline_internal(
    horizon_context, checked_at, p_declaration -> 'recentAuthentication'
  );
  select pg_catalog.min((contribution.value ->> 'validUntil')::timestamptz)
  into earliest
  from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions')
    as alt(value)
  cross join lateral pg_catalog.jsonb_array_elements(
    vortex_access.evaluate_record_permission_row_scope_internal(
      horizon_context,
      checked_at,
      auth_deadline,
      (p_declaration -> 'target' ->> 'applicationRootId')::uuid,
      p_declaration -> 'action',
      alt.value,
      p_record_id,
      p_facts,
      array[(alt.value -> 'permission' ->> 'permissionId')::uuid]
    )
  ) as contribution(value);
  if earliest is null then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant authority is unavailable';
  end if;
  if earliest >= horizon then
    return null;
  end if;
  return earliest;
end
$function$;

revoke execute on function
  vortex_access.record_share_grantor_authority_until_internal(jsonb, uuid, jsonb, jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;

comment on function
  vortex_access.record_share_grantor_authority_until_internal(jsonb, uuid, jsonb, jsonb) is
  'Private: when an already-admitted grantor''s exact-record authority for the declaration ends, excluding the request context''s own expiry; null when it does not expire. Never admits.';

do $migration$
declare
  fingerprint_sql constant text := $q$computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
      pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', %L,
        p_tenant_id::text, %s, pg_catalog.array_to_string(capabilities, ','),
        pg_catalog.to_char(pg_catalog.timezone('UTC', p_starts_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        coalesce(pg_catalog.to_char(pg_catalog.timezone('UTC', p_expires_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '')),
        'UTF8'), 'sha256'), 'hex');
  $q$;
  clamp_sql constant text := $q$expiry_cap := vortex_identity.tenant_administrator_grant_expiry_cap(
    p_actor_identity_id, p_tenant_id, capabilities, evaluated_at);
  if expiry_cap is not null and (p_expires_at is null or p_expires_at > expiry_cap) then
    p_expires_at := expiry_cap;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501', message = 'Tenant assignment cannot outlast your own authority';
  end if;
  $q$;
  self_tenant_sql constant text := $q$if %s = p_actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  $q$;

  target record;
  patch jsonb;
  old_text text;
  definition text;
  owner_name name;
begin
  for target in
    select candidate.procedure_id, candidate.patches, candidate.caller_fingerprint_uses
    from (values
      ('vortex_identity.grant_tenant_administrator(uuid,uuid,text,uuid,uuid,jsonb,timestamptz,timestamptz)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(
            'declare capabilities text[]; evaluated_at timestamptz;',
            'declare capabilities text[]; computed_fingerprint text; expiry_cap timestamptz; evaluated_at timestamptz;'),
          pg_catalog.jsonb_build_array(
            $q$perform vortex_identity.require_current_tenant_capability(p_actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at);$q$,
            $q$perform vortex_identity.require_current_tenant_capability(p_actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at);
  $q$ || pg_catalog.format(self_tenant_sql, 'p_subject_identity_id')
              || pg_catalog.format(fingerprint_sql, 'grant_tenant_administrator', 'p_subject_identity_id::text')),
          pg_catalog.jsonb_build_array(
            'if receipt.command_fingerprint <> p_command_fingerprint then',
            'if receipt.command_fingerprint <> computed_fingerprint then'),
          pg_catalog.jsonb_build_array(
            'insert into vortex_identity.tenant_administrator_assignments values (',
            clamp_sql || 'insert into vortex_identity.tenant_administrator_assignments values ('),
          pg_catalog.jsonb_build_array(
            'p_command_fingerprint,array[new_assignment_id]',
            'computed_fingerprint,array[new_assignment_id]')
        ),
        3),
      -- Live body: 20260914160000.
      ('vortex_identity.change_tenant_administrator(uuid,uuid,text,uuid,uuid,bigint,jsonb,timestamptz,timestamptz)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(
            'declare capabilities text[]; evaluated_at timestamptz; target_identity_id uuid;',
            'declare capabilities text[]; computed_fingerprint text; expiry_cap timestamptz; evaluated_at timestamptz; target_identity_id uuid;'),
          pg_catalog.jsonb_build_array(
            'select a.revision, a.revoked_at into current_revision, current_revoked_at',
            pg_catalog.format(self_tenant_sql, 'target_identity_id')
              || pg_catalog.format(fingerprint_sql, 'change_tenant_administrator',
                'p_assignment_id::text, p_expected_revision::text')
              || 'select a.revision, a.revoked_at into current_revision, current_revoked_at'),
          pg_catalog.jsonb_build_array(
            'if receipt.command_fingerprint <> p_command_fingerprint then',
            'if receipt.command_fingerprint <> computed_fingerprint then'),
          pg_catalog.jsonb_build_array(
            'if current_revision is null or current_revoked_at is not null then',
            clamp_sql || 'if current_revision is null or current_revoked_at is not null then'),
          pg_catalog.jsonb_build_array(
            $q$'change_tenant_administrator', p_duplicate_key, p_command_fingerprint,$q$,
            $q$'change_tenant_administrator', p_duplicate_key, computed_fingerprint,$q$)
        ),
        3),
      ('vortex_access.grant_record_share_for_administration(uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,text,uuid,jsonb)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(
            E'  granted record;\nbegin',
            E'  granted record;\n  grantor_authority_until timestamptz;\n  earliest_authority_until timestamptz;\nbegin'),
          pg_catalog.jsonb_build_array(
            E'message = ''Protected record-share recipient is unavailable'';\n  end if;\n',
            E'message = ''Protected record-share recipient is unavailable'';\n  end if;\n'
            || E'  if p_recipient_kind = ''organization_account''\n'
            || E'    and p_organization_account_id = context_account_id then\n'
            || E'    raise exception using errcode = ''42501'',\n'
            || E'      message = ''Protected record-share grant cannot target the grantor''''s own account'';\n'
            || E'  end if;\n'),
          pg_catalog.jsonb_build_array(
            E'      declaration, p_record_id, p_facts\n    );\n',
            E'      declaration, p_record_id, p_facts\n    );\n'
            || E'    -- How long this admitted authority lasts, beyond the session; null\n'
            || E'    -- does not expire and so does not lower the bound.\n'
            || E'    if decision ->> ''outcome'' = ''allowed'' then\n'
            || E'      grantor_authority_until := vortex_access.record_share_grantor_authority_until_internal(\n'
            || E'        declaration, p_record_id, p_facts, context_value\n'
            || E'      );\n'
            || E'      earliest_authority_until := least(earliest_authority_until, grantor_authority_until);\n'
            || E'    end if;\n'),
          pg_catalog.jsonb_build_array(
            'select result.* into strict granted',
            E'-- The share never outlasts the earliest authority it was granted under.\n'
            || E'  if earliest_authority_until is not null\n'
            || E'    and (p_expires_at is null or p_expires_at > earliest_authority_until) then\n'
            || E'    p_expires_at := earliest_authority_until;\n'
            || E'  end if;\n'
            || E'  if p_expires_at is not null and p_expires_at <= p_starts_at then\n'
            || E'    raise exception using errcode = ''42501'',\n'
            || E'      message = ''Protected record-share grant cannot outlast your own authority'';\n'
            || E'  end if;\n'
            || E'  select result.* into strict granted')
        ),
        null::integer)
    ) as candidate(procedure_id, patches, caller_fingerprint_uses)
  loop
    definition := pg_catalog.pg_get_functiondef(target.procedure_id);
    for patch in select value from pg_catalog.jsonb_array_elements(target.patches)
    loop
      old_text := patch ->> 0;
      if (pg_catalog.length(definition)
          - pg_catalog.length(pg_catalog.replace(definition, old_text, '')))
          <> pg_catalog.length(old_text) then
        raise exception using errcode = '55000',
          message = 'Granted authority bounds patch does not match exactly once',
          detail = target.procedure_id::text || ': ' || old_text;
      end if;
      definition := pg_catalog.replace(definition, old_text, patch ->> 1);
    end loop;

    -- The signature and its format check are the only remaining uses of the
    -- caller's fingerprint.
    if target.caller_fingerprint_uses is not null
      and (pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, 'p_command_fingerprint', '')))
        <> target.caller_fingerprint_uses * pg_catalog.length('p_command_fingerprint') then
      raise exception using errcode = '55000',
        message = 'Granted authority bounds patch left a caller fingerprint in use',
        detail = target.procedure_id::text;
    end if;

    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = target.procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    reset role;
  end loop;
end
$migration$;

commit;
