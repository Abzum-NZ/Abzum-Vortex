# Remaining fixture data

The shipped CRM and Service Desk definition sources live under `modules/src/crm` and `modules/src/service-desk`. Tests that need those definitions read the shipped files directly. This directory does not keep a second definition corpus or a separate fixture test command.

## Contents

- `rule-graphs/` contains authored and canonical graph examples used by the live Rule graph contracts and evaluator.
- `scenarios/cross-application-sharing.json` records cross-application sharing cases.
- `storage/record-storage-layout.json` records storage layout examples.

These files are example data. They are not a separate development acceptance gate.

## Explicit field permissions

The shipped definition sources declare field access explicitly. Native read and export permissions enumerate readable fields, form changes exclude generated values, and sharing grants limit the recipient to their declared fields and actions. New fields do not gain access through a default.

## Change rule

Update a shipped definition in `modules/src` when its contract changes. Keep graph examples here only while live Rule graph code consumes them.