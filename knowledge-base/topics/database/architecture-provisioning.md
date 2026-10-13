---
id: database.architecture-provisioning
title: Database architecture and provisioning discovery
version: 1
status: draft
scope: general_guidance
domain: database
task_types: [database_architecture, database_provisioning]
triggers: [new database, RDS, Aurora, database engine, datastore, reuse database]
excludes: [table-only schema change, row-level data change]
source_class: general_guidance
owner: TBD
reviewed_at: null
---

# Purpose

Use when a request proposes a new database, managed database instance, or a
change to a service's data-store architecture. This is discovery guidance,
not an infrastructure execution procedure.

# Challenge the proposed solution

Ask what capability or measurable problem requires persistence and why the
proposed database is the right boundary. Establish whether the need is for a
new database/schema on an existing approved instance, an existing service/API,
a new managed database instance, or a different storage pattern. Do not assume
that a separate RDS instance is needed because a ticket says “add a database.”

Inspect authorized service and platform inventory for existing databases,
ownership, engine/version, environment, connectivity, and capacity signals.
Reuse is a candidate only when ownership, isolation, scaling, security,
availability, and operational constraints are compatible; do not recommend
sharing simply to avoid provisioning cost.

# Required discovery before a recommendation

- **Use case:** data being stored, source of truth, read/write flows, required
  relationships and transaction boundaries.
- **Evidence:** current limitation and observed/requested volume, concurrency,
  latency, growth, or product requirement. Ask which metric or outcome led to
  the proposal.
- **Data:** classification, retention/deletion, residency, encryption, and
  access boundaries.
- **Workload:** engine-specific features, query patterns, peak load, storage,
  connection count, and growth assumptions.
- **Resilience:** availability target, recovery point objective (RPO), recovery
  time objective (RTO), backup retention, restore expectations, and failover
  behavior.
- **Operations:** owner, migrations, monitoring, patching, credentials,
  maintenance window, and support model.
- **Economics:** expected steady and peak cost, environment count, and who owns
  the ongoing cost. Do not fabricate a price without region and sizing inputs.
- **Alternatives:** existing database/service, a separate logical database,
  managed instance, or another persistence pattern. Explain trade-offs using
  verified constraints.

# Decision output

Return: verified current state; stated need and evidence; options including
reuse and new infrastructure; unresolved questions; recommended direction and
trade-offs; operational/security requirements; rough cost inputs still
needed; and a proposed validation/rollback approach. Do not provision or
change infrastructure during architecture discovery.

# General references

- AWS describes an RDS DB instance as an isolated database environment that
  can contain one or more user-created databases. Multi-AZ instance standby is
  for availability/failover and does not serve read traffic:
  https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html
- Database-per-service is an architectural boundary with autonomy and
  isolation trade-offs; it is not a blanket rule to create a separate physical
  instance for every service:
  https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-data-persistence/database-per-service.html

# Acko-specific content to add

Populate approved engine/version matrix, service ownership lookup, instance
reuse criteria, standard network/secret patterns, environment conventions,
costing source, and approval path from internal sources. Until then, mark
these items unresolved rather than treating the general references as Acko
policy.
