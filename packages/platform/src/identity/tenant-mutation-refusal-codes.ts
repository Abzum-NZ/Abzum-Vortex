import { z } from "zod";

/*
 * Why a tenant administration change is refused: the codes alone, apart from the tenant
 * governance contracts, so a flow's refusal feedback names them in the browser without loading
 * those contracts.
 */

export const tenantAdministratorMutationRefusalCodeSchema = z.enum([
  "invalid_command",
  "duplicate_conflict",
  "stale_revision",
  "multi_factor_required",
  "unavailable",
  "last_manager",
  "operation_unavailable",
]);

export const tenantOrganizationMutationRefusalCodeSchema = z.enum([
  "invalid_command",
  "duplicate_conflict",
  "stale_revision",
  "multi_factor_required",
  "unavailable",
  "operation_unavailable",
]);
