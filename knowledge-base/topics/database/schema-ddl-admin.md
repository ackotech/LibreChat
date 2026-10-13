---
id: database.schema-ddl-admin
title: Database schema changes and administration (DDL)
version: 1
status: draft
scope: general_guidance
domain: database
task_types: [schema_change, database_administration]
triggers: [table, schema, column, index, constraint, migration, DDL, database role, grant]
excludes: [new managed database instance, row-level data change]
source_class: general_guidance
owner: TBD
reviewed_at: null
---

# Purpose

Use for structural database changes: creating or changing tables, columns,
indexes, constraints, schemas, and database-level roles/permissions. Treat
row-level INSERT/UPDATE/DELETE requests as DML and route them to
`database.data-dml`.

# First resolve scope

- If the request says “create a table,” clarify/verify which existing database
  and schema should contain it. Do not infer a new RDS instance.
- Check the repository's migration framework, naming conventions, current
  schema, deployment order, and existing consumers before proposing SQL.
- Identify schema owner, service ownership, affected readers/writers, and
  environments. Do not assume direct database access is the deployment path.

# Discovery questions

- What entity or relationship is being represented, and which service owns it?
- What access patterns, expected cardinality, uniqueness, nullability, and
  integrity rules are required?
- Which current and previous application versions must work during rollout?
- Could the change lock or rewrite a large table? What are its size, traffic,
  and migration-time constraints?
- How will the change be validated, monitored, and reversed or repaired?
- For permissions: which principal needs which exact actions on which objects,
  and for what duration? Prefer least privilege and managed identity/secret
  patterns from approved internal policy.

# Planning guidance

- Prefer repository-managed, reviewed migrations over undocumented manual
  production SQL.
- Plan backward-compatible stages where old and new application versions may
  overlap: add compatible structure, deploy code, backfill separately if
  needed, then remove obsolete structure only after consumers are verified.
- Assess lock duration, table size, index-build behavior, replication impact,
  and deployment timeout before choosing migration statements.
- State preconditions, expected effects, validation queries/metrics, and
  rollback or forward-repair steps. Do not call a destructive DDL change
  reversible unless the recovery path is verified.
- DDL execution and production approvals must follow the organization's
  migration and change process; those internal rules are currently TBD.

# Boundary

This topic plans schema/admin changes. It does not authorize applying DDL,
changing production permissions, or modifying row data. Route any data
backfill or correction to the DML playbook as a separately reviewed step.

# General references

- PostgreSQL ALTER TABLE reference (locking and operation-specific behavior):
  https://www.postgresql.org/docs/current/sql-altertable.html
- Acko migration framework, service schema conventions, and change policy:
  **TBD — add verified internal references.**
