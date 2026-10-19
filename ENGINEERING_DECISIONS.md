# Engineering Decisions & Architecture

## 1. Optimistic Concurrency Control (OCC) Over Pessimistic Locking

**Problem:** Two operators view the same unassigned urgent incident and click "Claim" simultaneously, or one edits a work item while another updates its status based on stale screen state.
**Decision:** Every `work_items` row maintains an integer `version` column. Every mutation request (`PATCH /api/work-items/:id`) must supply `expectedVersion`. The SQL update executes atomically:
`UPDATE work_items SET ..., version = version + 1 WHERE id = ? AND version = ?`
If `changes === 0`, the server returns `409 Conflict` along with the latest server state so the UI can immediately prompt the user to reconcile changes.
**Trade-off:** Requires clients to track versions and handle `409` responses, but completely avoids database lock contention and deadlocks across stateless HTTP requests.

## 2. Transactional Request Idempotency (`Idempotency-Key`)

**Problem:** Under high operational pressure or spotty network conditions, users double-click "Create" or "Approve", or clients retry timed-out requests, creating duplicate work items or double audit logs.
**Decision:** Mutating endpoints accept an `Idempotency-Key` header. Inside the same ACID database transaction as the domain mutation, the server checks and writes the key and response payload into an `idempotency_keys` table scoped to `(key, user_id)`. Repeat requests return the cached status and payload immediately without re-executing side effects.
**Trade-off:** Adds slight storage overhead for keys (mitigated via TTL cleanup in production), but guarantees exactly-once domain execution semantics for retrying clients.

## 3. Transactional Outbox Pattern for Asynchronous Side Effects

**Problem:** Sending notifications, webhooks, or compliance alerts synchronously slows down user mutations and fails the primary operation if downstream services flake. Firing async tasks in memory loses jobs if the process crashes right after the DB commit.
**Decision:** Secondary actions are written to an `outbox_events` table _inside the exact same database transaction_ that updates the work item and writes the `audit_logs` entry. A background worker polls `PENDING` events with exponential backoff, max retry limits, and dead-letter status (`FAILED`).
**Trade-off:** Slight polling latency (1–2 seconds) compared to in-memory event emitters, in exchange for guaranteed at-least-once delivery and crash durability.

## 4. Team-Scoped Role-Based Authorization (RBAC) & Workflow State Machine

**Problem:** Not every user can perform every action (e.g., approving restricted compliance/payment tasks or modifying items belonging to unauthorized teams), and invalid state jumps corrupt operational metrics.
**Decision:** Users have global roles (`ADMIN`) and team-specific roles (`VIEWER`, `OPERATOR`, `APPROVER`) stored in `team_memberships`. Authorization is enforced strictly in the backend API middleware and mutation logic. Furthermore, work items follow a strict directed graph (`OPEN` -> `IN_PROGRESS` | `AWAITING_APPROVAL` -> `APPROVED` -> `RESOLVED` -> `CLOSED`). Moving from `AWAITING_APPROVAL` to `APPROVED` requires the `APPROVER` role on the owning team (and prevents self-approval if configured).
**Trade-off:** Rigid workflow transitions require explicit state paths rather than ad-hoc edits, ensuring compliance auditability.

## 5. Append-Only Audit Ledger & Indexed Server-Side Filtering

**Problem:** Management cannot see why decisions were made if history is overwritten, and loading tens of thousands of items into browser memory degrades performance.
**Decision:** All state transitions, assignments, handoffs, and comments write to an immutable `audit_logs` table with structured JSON diffs (`before_state`, `after_state`). List queries (`GET /api/work-items`) use composite SQLite indexes (`idx_work_items_team_status_priority`, `idx_work_items_updated_at`) with server-side pagination (`limit`, `offset`) and triage filters (`requiresAttention`).
**Trade-off:** Slightly higher write amplification per update, but provides O(log N) read performance and complete historical accountability.
