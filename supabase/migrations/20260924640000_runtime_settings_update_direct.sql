-- #989: the organisation runtime-settings update takes its values directly.
--
-- The original protected operation received only the expected revision; the
-- trusted runtime had to stage the contract-validated values in a separate
-- call before it dropped to the request role. That extra staging call kept the
-- operation from running through one uniform protected-operation executor.
--
-- This replaces the bigint-only operation with one that receives the expected
-- revision and the five setting values as arguments. Authority is unchanged:
-- the organisation and account still come only from the validated human
-- request context, the fixed runtime-settings.manage permission is still
-- evaluated under the organisation Access-version lock, and the private
-- Identity writer (which checks every value through
-- assert_organization_runtime_settings_values) still applies the exact
-- expected-revision check. Access version is still never changed.
--
-- SQL repeats the boundary checks only: exact BCP-47 language and pinned IANA
-- time-zone validation remain the trusted contract's, which the Access
-- runtime-settings service applies before it calls this operation.
--
-- The transaction-bound staging table and its two functions are no longer
-- reached by this operation; removing them can follow separately.

drop function vortex_access.update_organization_runtime_settings_for_administration(bigint);

create function vortex_access.update_organization_runtime_settings_for_administration(
  p_expected_revision bigint,
  p_language text,
  p_time_zone text,
  p_currency text,
  p_date_format text,
  p_number_format text
)
returns table (
  organization_id uuid,
  settings jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  decision record;
  changed record;
begin
  -- First establish the request identity, then take the same organisation
  -- Access-version lock used by governance changes.  Revalidate while the
  -- lock is held so a revocation that committed while this operation waited
  -- cannot reach permission evaluation or the settings write.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  perform 1
  from vortex_access.organization_access_versions as access_version
  where access_version.organization_id = context_organization_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization runtime settings update is unavailable';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.runtime_settings.update',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'c658c254-2884-414a-9012-512c0cfe4b34'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.runtime_settings.update'
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization runtime settings update is unavailable';
  end if;

  select updated.* into strict changed
  from vortex_identity.update_organization_runtime_settings_internal(
    context_organization_id, p_expected_revision,
    p_language, p_time_zone, p_currency, p_date_format, p_number_format
  ) as updated;

  return query select changed.organization_id,
    pg_catalog.jsonb_build_object(
      'organizationId', changed.organization_id,
      'language', changed.language,
      'timeZone', changed.time_zone,
      'currency', changed.currency,
      'dateFormat', changed.date_format,
      'numberFormat', changed.number_format,
      'revision', changed.revision
    );
end
$function$;

revoke all on function vortex_access.update_organization_runtime_settings_for_administration(
  bigint, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_access.update_organization_runtime_settings_for_administration(
  bigint, text, text, text, text, text
) to vortex_request;

comment on function vortex_access.update_organization_runtime_settings_for_administration(
  bigint, text, text, text, text, text
) is 'Fixed protected organisation settings update requiring runtime-settings.manage and an exact current revision. The values are arguments, contract-validated by the Access service and boundary-checked by the private Identity writer. It never changes Access version.';
