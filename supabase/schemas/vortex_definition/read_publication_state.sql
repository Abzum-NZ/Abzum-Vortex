create or replace function vortex_definition.read_publication_state(
  p_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  context_organization_id uuid;
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  history_latest_release_revision bigint;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Definition publication state requires a non-nil root identifier';
  end if;
  select root.* into root_row from vortex_definition.roots as root where root.root_id = p_root_id;
  if not found then return null; end if;
  if root_row.organization_id <> context_organization_id then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;
  select draft.* into draft_row from vortex_definition.drafts as draft where draft.root_id = p_root_id;
  if not found then
    raise exception using errcode = '23503', message = 'A Definition root requires its current draft';
  end if;
  select release.release_revision into history_latest_release_revision
  from vortex_definition.releases as release
  where release.root_id = p_root_id
  order by release.release_revision desc
  limit 1;
  return pg_catalog.jsonb_build_object(
    'root', pg_catalog.jsonb_build_object(
      'rootId', root_row.root_id, 'organizationId', root_row.organization_id,
      'kind', root_row.kind, 'key', root_row.key,
      'currentReleaseRevision', root_row.current_release_revision,
      'createdAt', root_row.created_at, 'createdBy', root_row.created_by
    ),
    'historyLatestReleaseRevision', history_latest_release_revision,
    'draft', pg_catalog.jsonb_build_object(
      'rootId', draft_row.root_id, 'organizationId', root_row.organization_id,
      'kind', root_row.kind, 'key', root_row.key, 'draftRevision', draft_row.draft_revision,
      'publishedRevision', root_row.current_release_revision, 'source', draft_row.draft_source,
      'sourceContractVersion', draft_row.source_contract_version,
      'sourceFingerprint', draft_row.source_fingerprint, 'createdAt', root_row.created_at,
      'createdBy', root_row.created_by, 'updatedAt', draft_row.updated_at,
      'updatedBy', draft_row.updated_by
    ),
    'identities', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'definitionKey', root_row.key, 'scope', requirement.value ->> 'scope',
        'kind', requirement.value ->> 'kind', 'componentOwner', requirement.value ->> 'componentOwner',
        'alias', current_alias.value, 'identifier', identity.identity_id
      ) order by requirement.value ->> 'scope', requirement.value ->> 'kind', current_alias.value)
      from pg_catalog.jsonb_array_elements(draft_row.identity_requirements) as requirement(value)
      cross join lateral pg_catalog.jsonb_array_elements_text(requirement.value -> 'aliases') as current_alias(value)
      join vortex_definition.source_identities as identity on identity.root_id = p_root_id
        and identity.owner_scope = requirement.value ->> 'ownerScope'
        and identity.kind = requirement.value ->> 'kind'
        and identity.component_owner = requirement.value ->> 'componentOwner'
      join vortex_definition.source_identity_aliases as alias on alias.root_id = p_root_id
        and alias.owner_scope = requirement.value ->> 'ownerScope'
        and alias.scope = requirement.value ->> 'scope' and alias.kind = requirement.value ->> 'kind'
        and alias.component_owner = requirement.value ->> 'componentOwner'
        and alias.alias = current_alias.value and alias.identity_id = identity.identity_id
    ), '[]'::jsonb)
  );
end
$function$;

revoke execute on function vortex_definition.read_publication_state(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.read_publication_state(uuid) to vortex_request;

comment on function vortex_definition.read_publication_state(uuid) is
  'Returns one organisation-scoped Definition draft, permanent identity aliases and immutable publication evidence for server-side compilation.';
