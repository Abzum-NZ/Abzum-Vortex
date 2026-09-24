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
-- * The stored `expires_at` is capped at the grantor's earliest validity. For a
--   tenant assignment that is the earliest, over every capability being granted
--   plus `platform.tenant.administrators.manage` itself, of the latest expiry
--   among the actor's current assignments carrying that capability (no expiry
--   means unbounded). For a record share it is the earliest `validUntil` of the
--   fresh share/read/update decisions the function already evaluates. A missing
--   or later requested expiry is clamped to that bound; a bound that leaves no
--   window after `p_starts_at` refuses with 42501. A grantor with no expiring
--   authority is not affected.
-- * The two tenant commands compute their command fingerprint in the database
--   from the command's own inputs (the same `sha256:` + digest shape other
--   administration commands use, timestamps rendered in UTC). The
--   `p_command_fingerprint` parameter stays in the signature so callers do not
--   change, keeps its format check, and is otherwise ignored. It is computed
--   from the requested values, before the cap, so a replay matches on what the
--   caller asked for.
--
-- Who may grant is unchanged. The live bodies are patched in place
-- (pg_get_functiondef) because `change_tenant_administrator` was already
-- rewritten by 20260914160000; each fragment must match exactly once.

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

create function pg_temp.patch_once(definition text, old_text text, new_text text)
returns text
language plpgsql
as $function$
begin
  if (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_text, '')))
      <> pg_catalog.length(old_text) then
    raise exception using errcode = '55000',
      message = 'Granted authority bounds patch does not match exactly once',
      detail = old_text;
  end if;
  return pg_catalog.replace(definition, old_text, new_text);
end
$function$;

do $migration$
declare
  definition text;
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
begin
  -- grant_tenant_administrator
  definition := pg_catalog.pg_get_functiondef(
    'vortex_identity.grant_tenant_administrator(uuid,uuid,text,uuid,uuid,jsonb,timestamptz,timestamptz)'::pg_catalog.regprocedure);
  definition := pg_temp.patch_once(definition,
    'declare capabilities text[]; evaluated_at timestamptz;',
    'declare capabilities text[]; computed_fingerprint text; expiry_cap timestamptz; evaluated_at timestamptz;');
  definition := pg_temp.patch_once(definition,
    $q$perform vortex_identity.require_current_tenant_capability(p_actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at);$q$,
    $q$perform vortex_identity.require_current_tenant_capability(p_actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at);
  if p_subject_identity_id = p_actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  $q$ || pg_catalog.format(fingerprint_sql, 'grant_tenant_administrator', 'p_subject_identity_id::text'));
  definition := pg_temp.patch_once(definition,
    'if receipt.command_fingerprint <> p_command_fingerprint then',
    'if receipt.command_fingerprint <> computed_fingerprint then');
  definition := pg_temp.patch_once(definition,
    'insert into vortex_identity.tenant_administrator_assignments values (',
    clamp_sql || 'insert into vortex_identity.tenant_administrator_assignments values (');
  definition := pg_temp.patch_once(definition,
    'p_command_fingerprint,array[new_assignment_id]',
    'computed_fingerprint,array[new_assignment_id]');
  -- The signature and its format check are the only remaining uses.
  if (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, 'p_command_fingerprint', '')))
      <> 3 * pg_catalog.length('p_command_fingerprint') then
    raise exception using errcode = '55000',
      message = 'Granted authority bounds patch left a caller fingerprint in use';
  end if;
  execute definition;

  -- change_tenant_administrator (live body: 20260914160000)
  definition := pg_catalog.pg_get_functiondef(
    'vortex_identity.change_tenant_administrator(uuid,uuid,text,uuid,uuid,bigint,jsonb,timestamptz,timestamptz)'::pg_catalog.regprocedure);
  definition := pg_temp.patch_once(definition,
    'declare capabilities text[]; evaluated_at timestamptz; target_identity_id uuid;',
    'declare capabilities text[]; computed_fingerprint text; expiry_cap timestamptz; evaluated_at timestamptz; target_identity_id uuid;');
  definition := pg_temp.patch_once(definition,
    'select a.revision, a.revoked_at into current_revision, current_revoked_at',
    $q$if target_identity_id = p_actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  $q$ || pg_catalog.format(fingerprint_sql, 'change_tenant_administrator',
      'p_assignment_id::text, p_expected_revision::text')
    || 'select a.revision, a.revoked_at into current_revision, current_revoked_at');
  definition := pg_temp.patch_once(definition,
    'if receipt.command_fingerprint <> p_command_fingerprint then',
    'if receipt.command_fingerprint <> computed_fingerprint then');
  definition := pg_temp.patch_once(definition,
    'if current_revision is null or current_revoked_at is not null then',
    clamp_sql || 'if current_revision is null or current_revoked_at is not null then');
  definition := pg_temp.patch_once(definition,
    $q$'change_tenant_administrator', p_duplicate_key, p_command_fingerprint,$q$,
    $q$'change_tenant_administrator', p_duplicate_key, computed_fingerprint,$q$);
  if (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, 'p_command_fingerprint', '')))
      <> 3 * pg_catalog.length('p_command_fingerprint') then
    raise exception using errcode = '55000',
      message = 'Granted authority bounds patch left a caller fingerprint in use';
  end if;
  execute definition;

  -- grant_record_share_for_administration
  definition := pg_catalog.pg_get_functiondef(
    'vortex_access.grant_record_share_for_administration(uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,text,uuid,jsonb)'::pg_catalog.regprocedure);
  definition := pg_temp.patch_once(definition,
    E'  granted record;\nbegin',
    E'  granted record;\n  earliest_valid_until timestamptz;\n  decision_valid_until timestamptz;\nbegin');
  definition := pg_temp.patch_once(definition,
    E'message = ''Protected record-share recipient is unavailable'';\n  end if;\n',
    E'message = ''Protected record-share recipient is unavailable'';\n  end if;\n'
    || E'  if p_recipient_kind = ''organization_account''\n'
    || E'    and p_organization_account_id = context_account_id then\n'
    || E'    raise exception using errcode = ''42501'',\n'
    || E'      message = ''Protected record-share grant cannot target the grantor''''s own account'';\n'
    || E'  end if;\n');
  definition := pg_temp.patch_once(definition,
    E'      declaration, p_record_id, p_facts\n    );\n',
    E'      declaration, p_record_id, p_facts\n    );\n'
    || E'    if decision ->> ''outcome'' = ''allowed'' and decision ->> ''validUntil'' is not null then\n'
    || E'      decision_valid_until := (decision ->> ''validUntil'')::timestamptz;\n'
    || E'      earliest_valid_until := least(coalesce(earliest_valid_until, decision_valid_until), decision_valid_until);\n'
    || E'    end if;\n');
  definition := pg_temp.patch_once(definition,
    'select result.* into strict granted',
    E'-- The share never outlasts the earliest authority it was granted under.\n'
    || E'  if earliest_valid_until is not null\n'
    || E'    and (p_expires_at is null or p_expires_at > earliest_valid_until) then\n'
    || E'    p_expires_at := earliest_valid_until;\n'
    || E'  end if;\n'
    || E'  if p_expires_at is not null and p_expires_at <= p_starts_at then\n'
    || E'    raise exception using errcode = ''42501'',\n'
    || E'      message = ''Protected record-share grant cannot outlast your own authority'';\n'
    || E'  end if;\n'
    || E'  select result.* into strict granted');
  execute definition;
end
$migration$;
