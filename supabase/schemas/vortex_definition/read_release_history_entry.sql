create or replace function vortex_definition.read_release_history_entry(
  p_kind text,
  p_root_id uuid,
  p_release_revision bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  history_entry jsonb;
begin
  checked_context := vortex_definition.validated_system_context();

  if p_kind is null
    or p_kind not in ('module', 'application')
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_release_revision is null
    or p_release_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Definition release history entry has an invalid selector';
  end if;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'kind', root.kind,
    'definitionKey', root.key,
    'rootId', root.root_id,
    'currentReleaseRevision', root.current_release_revision,
    'entry', pg_catalog.jsonb_build_object(
      'releaseRevision', release.release_revision,
      'releaseVersion', release.release_version,
      'sourceFingerprint', release.authored_source_fingerprint,
      'contentFingerprint', release.content_fingerprint,
      'releaseNote', release.release_note,
      'publishedAt', release.published_at,
      'publishedBy', release.published_by,
      'isCurrent', release.release_revision = root.current_release_revision
    )
  ))
  into history_entry
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = p_release_revision
  where root.root_id = p_root_id
    and root.kind = p_kind
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;

  return history_entry;
end
$function$;

revoke execute on function vortex_definition.read_release_history_entry(text, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_release_history_entry(text, uuid, bigint) to vortex_request;

comment on function vortex_definition.read_release_history_entry(text, uuid, bigint) is
  'Returns one exact same-organization immutable Definition release metadata entry.';
