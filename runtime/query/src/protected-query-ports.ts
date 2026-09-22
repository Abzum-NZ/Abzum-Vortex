import "server-only";

import type { FieldId, JsonValue, RecordId } from "@vortex/contracts";
import type { ProtectedQueryScope } from "./protected-query-contracts";

/**
 * The readable-field bounds this service must intersect every requested,
 * filtered and sorted field against before it builds a predicate or returns a
 * value. Resolved once per request from the SQL-owned bounds owner
 * (`vortex_access.resolve_record_field_bounds_internal` and the decision that
 * feeds it), never derived, cached across requests or widened here.
 */
export type ProtectedQueryFieldBounds = Readonly<{
  readableFieldIds: ReadonlySet<FieldId>;
}>;

/**
 * Calls the existing SQL-owned readable field bounds resolver once per
 * request for the query's exact organisation, installed application and
 * record type.
 *
 * Deliberately a port rather than a concrete implementation in this package:
 * `vortex_access.resolve_record_field_bounds_internal` only accepts a
 * `matchedContributions` decision produced by
 * `vortex_access.evaluate_organization_record_access_internal`, which itself
 * requires one already-existing target record and its own ownership/sharing
 * facts (supabase/migrations/20260923050000_remove_legacy_team_values.sql).
 * There is no scope-level (record-type-wide, no specific record) variant of
 * either function today, so this bounded change cannot call the existing
 * bounds owner directly without either reusing a real record's decision (not
 * meaningful for a multi-row query) or re-deriving the permission-eligibility
 * matching those functions already own. Recreating that matching here, un-run
 * and unreviewed against a live database, would risk exactly the tenant- and
 * field-isolation defects the existing engine already closes. The concrete
 * adapter therefore belongs with a forward migration that extends the bounds
 * owner itself, reviewed with real database execution.
 */
export interface ProtectedQueryFieldBoundsResolver {
  resolveReadableFieldBounds(input: {
    scope: ProtectedQueryScope;
    recordType: Readonly<{ moduleRootId: string; recordTypeId: string }>;
  }): Promise<ProtectedQueryFieldBounds>;
}

/** One row this engine may filter, sort, paginate and project; visibility is already decided. */
export type ProtectedQueryCandidateRecord = Readonly<{
  recordId: RecordId;
  /** Every field this row source is willing to expose, keyed by field id, in canonical JSON form. */
  values: Readonly<Record<string, JsonValue>>;
}>;

/**
 * Loads every currently visible candidate row for the query's record type,
 * within organisation, installed application, ownership and sharing scope.
 * This service owns filtering by the descriptor's fixed condition tree,
 * deterministic sort, keyset pagination and field projection entirely from
 * the returned candidates: the source must apply row-level visibility only,
 * never a partial sort, limit or field allowlist of its own, so the engine's
 * order and page boundaries stay reproducible.
 *
 * Deliberately a port rather than a concrete implementation in this package:
 * the physical storage for a record type is a dynamically provisioned,
 * per-release table (`vortex_record.provision_exact_module_storage`) whose
 * only granted multi-row-safe reader today does not exist -- the sole
 * existing reader, `vortex_record.read_record`, is scoped to one exact
 * record id, and row-level ownership/sharing visibility for many rows at
 * once has no reviewed SQL surface yet. Building that bulk, RLS-parity-safe
 * reader blind, without the database execution or review this bounded
 * assignment excludes, is out of proportion and out of scope for #572; it
 * belongs with a forward migration reviewed against the live schema.
 */
export interface ProtectedQueryCandidateSource {
  loadVisibleCandidates(input: {
    scope: ProtectedQueryScope;
    recordType: Readonly<{ moduleRootId: string; recordTypeId: string }>;
    /** The exact fields this call needs projected: bounds ∩ requested ∩ filter/sort references. */
    fieldIds: ReadonlySet<FieldId>;
  }): Promise<readonly ProtectedQueryCandidateRecord[]>;
}
