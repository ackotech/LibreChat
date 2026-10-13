---
id: database.fundamentals
title: Database fundamentals for architecture discovery
version: 1
status: draft
scope: shared
domain: database
task_types: [database_architecture, database_provisioning, schema_change, database_administration, data_change]
source_class: general_guidance
owner: TBD
reviewed_at: null
---

# Purpose

Shared discovery principles for database-related requests. Use this with the
task-specific playbook selected by `knowledge-base/catalog.yaml`.

# Core distinctions

- A request to create a **table, column, index, or constraint** is a schema
  change. It does not by itself imply a request for a new database or RDS
  instance.
- A request to **insert, update, delete, upsert, or backfill rows** changes
  data. Route it to the DML playbook; do not blend it into schema planning.
- A request for a **database service or instance** is a provisioning and
  architecture decision. First establish the use case and inspect available
  inventory before recommending new infrastructure.
- A table, schema, database, database instance, and database service are
  different scopes. Repeat the requested scope back when ambiguous.

# Questions to establish context

1. What user or business workflow needs this change, and what is failing or
   constrained today?
2. What evidence supports the proposed database change (traffic, latency,
   error rate, storage growth, contention, query behavior, or a product need)?
3. What existing service, database, schema, table, or migration already owns
   this data? Verify through authorized inventory or code access when
   available; do not make the user restate discoverable facts.
4. Who owns the data and the consuming service? Which environments are in
   scope?
5. What data classification, retention, residency, availability, recovery,
   and access requirements apply?
6. What failure behavior is acceptable, and how will success be measured?

# Grounding rules for the Architect agent

- Separate verified repository/platform facts from user statements and
  assumptions. Cite the source or say what could not be verified.
- Do not invent Acko service names, approved database engines, sizing rules,
  cost estimates, regions, standards, or approval requirements.
- Search connected inventory and source code within the user's authorization
  before asking questions whose answers may already be available.
- When internal policy is missing, label the decision as unresolved and ask
  for the relevant policy owner or source.

# Acko-specific content to add

- Approved database engines and managed-service patterns.
- Service/database ownership inventory and how to query it.
- Data classification, retention, residency, and access standards.
- Required availability, backup, recovery, and cost guardrails.
- Approval owners and production-change workflow.
