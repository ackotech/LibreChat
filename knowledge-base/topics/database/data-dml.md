---
id: database.data-dml
title: Database row changes (DML)
version: 1
status: draft
scope: general_guidance
domain: database
task_types: [data_change]
triggers: [INSERT, UPDATE, DELETE, UPSERT, modify records, backfill, correct data]
excludes: [schema-only change, database provisioning]
source_class: general_guidance
owner: TBD
reviewed_at: null
---

# Purpose

Use for changes to stored rows: INSERT, UPDATE, DELETE, UPSERT, bulk correction,
or data backfill. Keep this separate from database provisioning and DDL.
This playbook is for discovery and planning; it does not grant permission to
execute data changes.

# Hard discovery gate

Before proposing a write, establish:

1. Exact environment, database, schema, table, and data owner.
2. Business reason and source of truth for the requested values.
3. Precise row-selection predicate and expected affected-row count.
4. Whether the operation is one-time, repeatable, or a backfill; required
   idempotency and handling of partial failure.
5. Data classification, retention, and impact on downstream consumers.
6. Transaction/batch strategy, load/lock impact, and execution window.
7. Verified backup/restore or compensating repair path, validation, monitoring,
   and required approver under internal policy.

If target, predicate, scope, or expected impact is ambiguous, ask questions and
do not generate an executable write as if the facts were known.

# Safe planning checklist

- Inspect the actual schema and application/repository usage when authorized.
- Prefer a read-only preview/count using the exact predicate before a write.
- State expected rows and stop conditions; check that the observed count agrees
  before proceeding.
- Use a transaction where appropriate, with explicit commit/rollback behavior;
  for large jobs, design bounded batches and restart-safe checkpoints.
- Make retries safe where possible and define how partial completion is found
  and repaired.
- Validate postconditions and relevant application/business metrics.
- Treat production writes, destructive changes, regulated/sensitive rows, and
  broad predicates as requiring the organization's explicit approval path.

# Boundary

Do not combine row updates with schema changes in one unreviewed plan. If a
change needs both, split into separately described DDL and DML steps with
their own owners, validation, and rollback/recovery plan. A request to add a
table belongs to the DDL topic, not here.

# Acko-specific content to add

Add approved data-change tooling, production protections, required reviewers,
backup/restore expectations, data classification rules, and audit fields from
verified internal policy. Until then, do not claim a specific Acko approval
rule or execute DML.
