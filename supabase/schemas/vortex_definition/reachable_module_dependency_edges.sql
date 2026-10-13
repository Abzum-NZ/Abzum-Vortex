CREATE FUNCTION vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) RETURNS TABLE(target_root_id uuid, target_release_revision bigint, dependency_reference text, dependency_version text, dependency_content_fingerprint text, evidence_fingerprint text)
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  pin record;
begin
  -- UNION collapses edges that reach one target with identical evidence, so a
  -- root has one tuple exactly when every edge pins it at one revision with
  -- the same evidence. The release being resolved already pins its own root,
  -- so reaching that root again would pin it twice; this is also how a
  -- root-level cycle is refused.
  for pin in
    with recursive module_edges as (
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_reference, dependency.dependency_version,
        dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = p_root_id
        and dependency.release_revision = p_release_revision
        and dependency.dependency_kind = 'module'
      union
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_reference, dependency.dependency_version,
        dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
      from module_edges as parent
      join vortex_definition.release_dependencies as dependency
        on dependency.root_id = parent.target_root_id
        and dependency.release_revision = parent.target_release_revision
        and dependency.dependency_kind = 'module'
    )
    select edge.target_root_id, edge.target_release_revision,
      edge.dependency_reference, edge.dependency_version,
      edge.dependency_content_fingerprint, edge.evidence_fingerprint,
      pg_catalog.count(*) over (partition by edge.target_root_id) as root_pin_count,
      root.kind is distinct from 'module'
        or root.key is distinct from edge.dependency_reference
        or release.release_version is distinct from edge.dependency_version
        or release.content_fingerprint is distinct from edge.dependency_content_fingerprint
        or release.resolution_fingerprint is distinct from edge.evidence_fingerprint
        as disagrees_with_target
    from module_edges as edge
    left join vortex_definition.roots as root on root.root_id = edge.target_root_id
    left join vortex_definition.releases as release
      on release.root_id = edge.target_root_id
      and release.release_revision = edge.target_release_revision
  loop
    if pin.root_pin_count <> 1
      or pin.disagrees_with_target
      or pin.target_root_id = p_root_id then
      raise exception using errcode = '23514', message = 'Exact bound Module dependency evidence is inconsistent';
    end if;
    target_root_id := pin.target_root_id;
    target_release_revision := pin.target_release_revision;
    dependency_reference := pin.dependency_reference;
    dependency_version := pin.dependency_version;
    dependency_content_fingerprint := pin.dependency_content_fingerprint;
    evidence_fingerprint := pin.evidence_fingerprint;
    return next;
  end loop;
end
$$;

alter function vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

COMMENT ON FUNCTION vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) IS 'Owner-private Module dependency pin set of one exact release: one row per Module root; raises 23514 when a root is pinned at more than one revision or an edge disagrees with its target release.';

REVOKE ALL ON FUNCTION vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) TO vortex_owner;

grant execute on function vortex_definition.reachable_module_dependency_edges(p_root_id uuid, p_release_revision bigint) to postgres;
