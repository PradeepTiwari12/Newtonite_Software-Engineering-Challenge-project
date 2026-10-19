import express, { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';

export type WorkStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'BLOCKED'
  | 'RESOLVED'
  | 'CLOSED';

export type TeamRole = 'VIEWER' | 'OPERATOR' | 'APPROVER';

const ALLOWED_TRANSITIONS: Record<WorkStatus, WorkStatus[]> = {
  OPEN: ['IN_PROGRESS', 'AWAITING_APPROVAL', 'BLOCKED', 'CLOSED'],
  IN_PROGRESS: ['AWAITING_APPROVAL', 'BLOCKED', 'RESOLVED', 'OPEN'],
  AWAITING_APPROVAL: ['APPROVED', 'IN_PROGRESS', 'BLOCKED'],
  APPROVED: ['IN_PROGRESS', 'RESOLVED'],
  BLOCKED: ['IN_PROGRESS', 'OPEN', 'AWAITING_APPROVAL'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: ['IN_PROGRESS'], // Reopen
};

function computeNextAction(status: WorkStatus, assigneeId: string | null, requiresApproval: boolean, approvedBy: string | null): string {
  if (status === 'CLOSED') return 'No action required (Closed)';
  if (status === 'RESOLVED') return 'Verify resolution and close item';
  if (status === 'AWAITING_APPROVAL') return 'Requires team APPROVER sign-off before execution';
  if (status === 'BLOCKED') return 'Unblock dependency or hand off to another team';
  if (!assigneeId) return 'Unassigned — needs an operator to claim ownership';
  if (requiresApproval && !approvedBy && status !== 'APPROVED') {
    return 'Investigate and submit for approval before resolving';
  }
  return 'Assigned operator investigating / executing task';
}

export function createApp(db: Database.Database) {
  const app = express();
  app.use(express.json());

  // Authentication Middleware (Simulates authenticated session via X-User-Id header)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const userId = (req.header('X-User-Id') || 'u_alice').trim();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    if (!user) {
      return res.status(401).json({ error: 'Invalid user identity' });
    }
    const memberships = db
      .prepare('SELECT team_id, role FROM team_memberships WHERE user_id = ?')
      .all(userId) as { team_id: string; role: TeamRole }[];

    const roleMap: Record<string, TeamRole> = {};
    for (const m of memberships) {
      roleMap[m.team_id] = m.role;
    }

    (req as any).user = {
      ...user,
      rolesByTeam: roleMap,
    };
    next();
  });

  // Helper: Check Team Permission
  function hasTeamPermission(user: any, teamId: string, minRole: TeamRole): boolean {
    if (user.is_global_admin) return true;
    const role = user.rolesByTeam[teamId];
    if (!role) return false;
    const rank: Record<TeamRole, number> = { VIEWER: 1, OPERATOR: 2, APPROVER: 3 };
    return rank[role] >= rank[minRole];
  }

  // Helper: Transactional Idempotency Wrapper
  function executeIdempotent(req: Request, res: Response, handler: () => { status: number; body: any }) {
    const idempotencyKey = req.header('Idempotency-Key');
    const userId = (req as any).user.id;

    const runTx = db.transaction(() => {
      if (idempotencyKey) {
        const cached = db
          .prepare('SELECT status_code, response_json FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?')
          .get(idempotencyKey, userId) as { status_code: number; response_json: string } | undefined;

        if (cached) {
          return {
            status: cached.status_code,
            body: JSON.parse(cached.response_json),
            replayed: true,
          };
        }
      }

      const result = handler();

      // Cache successful or deterministic client outcomes (2xx)
      if (idempotencyKey && result.status >= 200 && result.status < 300) {
        db.prepare(
          'INSERT INTO idempotency_keys (idempotency_key, user_id, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(idempotencyKey, userId, result.status, JSON.stringify(result.body), new Date().toISOString());
      }

      return { ...result, replayed: false };
    });

    try {
      const outcome = runTx();
      if (outcome.replayed) {
        res.setHeader('X-Idempotent-Replay', 'true');
      }
      return res.status(outcome.status).json(outcome.body);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  }

  // GET /api/context - Returns current user, all users (for demo switcher), and teams
  app.get('/api/context', (req: Request, res: Response) => {
    const users = db.prepare('SELECT id, name, email FROM users').all();
    const teams = db.prepare('SELECT id, name, slug FROM teams').all();
    res.json({
      currentUser: (req as any).user,
      users,
      teams,
    });
  });

  // GET /api/work-items - Paginated, filtered, and searched list with summary metrics
  app.get('/api/work-items', (req: Request, res: Response) => {
    const {
      teamId,
      status,
      priority,
      assigneeId,
      search,
      requiresAttention,
      limit = '25',
      offset = '0',
    } = req.query as Record<string, string>;

    const whereClauses: string[] = [];
    const params: any[] = [];

    if (teamId) {
      whereClauses.push('w.team_id = ?');
      params.push(teamId);
    }
    if (status) {
      whereClauses.push('w.status = ?');
      params.push(status);
    }
    if (priority) {
      whereClauses.push('w.priority = ?');
      params.push(priority);
    }
    if (assigneeId === 'UNASSIGNED') {
      whereClauses.push('w.assignee_id IS NULL');
    } else if (assigneeId) {
      whereClauses.push('w.assignee_id = ?');
      params.push(assigneeId);
    }
    if (search && search.trim() !== '') {
      whereClauses.push('(w.title LIKE ? OR w.description LIKE ? OR w.id LIKE ?)');
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }
    if (requiresAttention === 'true') {
      whereClauses.push(
        `((w.status = 'OPEN' AND w.assignee_id IS NULL) OR w.status = 'AWAITING_APPROVAL' OR w.status = 'BLOCKED' OR (w.priority = 'CRITICAL' AND w.status NOT IN ('RESOLVED', 'CLOSED')))`
      );
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const pageLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
    const pageOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const totalRow = db
      .prepare(`SELECT COUNT(*) as total FROM work_items w ${whereSql}`)
      .get(...params) as { total: number };

    const items = db
      .prepare(
        `
        SELECT 
          w.*,
          t.name as team_name,
          u_assign.name as assignee_name,
          u_create.name as creator_name,
          u_approve.name as approver_name
        FROM work_items w
        LEFT JOIN teams t ON w.team_id = t.id
        LEFT JOIN users u_assign ON w.assignee_id = u_assign.id
        LEFT JOIN users u_create ON w.created_by = u_create.id
        LEFT JOIN users u_approve ON w.approved_by = u_approve.id
        ${whereSql}
        ORDER BY 
          CASE w.priority 
            WHEN 'CRITICAL' THEN 1 
            WHEN 'HIGH' THEN 2 
            WHEN 'MEDIUM' THEN 3 
            ELSE 4 
          END ASC,
          w.updated_at DESC
        LIMIT ? OFFSET ?
      `
      )
      .all(...params, pageLimit, pageOffset);

    // Quick operational summary counts
    const summary = db
      .prepare(
        `
        SELECT
          SUM(CASE WHEN status = 'OPEN' AND assignee_id IS NULL THEN 1 ELSE 0 END) as unassigned_open,
          SUM(CASE WHEN status = 'AWAITING_APPROVAL' THEN 1 ELSE 0 END) as awaiting_approval,
          SUM(CASE WHEN priority = 'CRITICAL' AND status NOT IN ('RESOLVED', 'CLOSED') THEN 1 ELSE 0 END) as active_critical,
          SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) as blocked_count
        FROM work_items
      `
      )
      .get();

    res.json({
      items,
      total: totalRow.total,
      limit: pageLimit,
      offset: pageOffset,
      summary,
    });
  });

  // GET /api/work-items/:id - Detailed view with immutable audit log
  app.get('/api/work-items/:id', (req: Request, res: Response) => {
    const item = db
      .prepare(
        `
        SELECT 
          w.*,
          t.name as team_name,
          u_assign.name as assignee_name,
          u_create.name as creator_name,
          u_approve.name as approver_name
        FROM work_items w
        LEFT JOIN teams t ON w.team_id = t.id
        LEFT JOIN users u_assign ON w.assignee_id = u_assign.id
        LEFT JOIN users u_create ON w.created_by = u_create.id
        LEFT JOIN users u_approve ON w.approved_by = u_approve.id
        WHERE w.id = ?
      `
      )
      .get(req.params.id);

    if (!item) {
      return res.status(404).json({ error: 'Work item not found' });
    }

    const audits = db
      .prepare(
        `
        SELECT a.*, u.name as actor_name
        FROM audit_logs a
        LEFT JOIN users u ON a.actor_id = u.id
        WHERE a.work_item_id = ?
        ORDER BY a.created_at DESC
      `
      )
      .all(req.params.id);

    res.json({ item, audits });
  });

  // POST /api/work-items - Create work item (Idempotent + RBAC checked)
  app.post('/api/work-items', (req: Request, res: Response) => {
    return executeIdempotent(req, res, () => {
      const user = (req as any).user;
      const {
        title,
        description,
        type = 'OPS_TASK',
        priority = 'MEDIUM',
        teamId,
        requiresApproval = false,
      } = req.body;

      if (!title || !description || !teamId) {
        return { status: 400, body: { error: 'title, description, and teamId are required' } };
      }

      if (!hasTeamPermission(user, teamId, 'OPERATOR')) {
        return {
          status: 403,
          body: { error: 'Forbidden: You must have at least OPERATOR role in the target team to create items.' },
        };
      }

      const id = `wi_${crypto.randomBytes(4).toString('hex')}`;
      const now = new Date().toISOString();
      const mustApprove = requiresApproval || type === 'COMPLIANCE_APPROVAL' || type === 'PAYMENT_INVESTIGATION' ? 1 : 0;
      const nextAction = computeNextAction('OPEN', null, Boolean(mustApprove), null);

      db.prepare(
        `
        INSERT INTO work_items (
          id, title, description, type, status, priority, requires_approval,
          team_id, assignee_id, created_by, approved_by, next_action_required, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, NULL, ?, NULL, ?, 1, ?, ?)
      `
      ).run(id, title.trim(), description.trim(), type, priority, mustApprove, teamId, user.id, nextAction, now, now);

      db.prepare(
        `INSERT INTO audit_logs (id, work_item_id, actor_id, action_type, comment, changes_json, created_at)
         VALUES (?, ?, ?, 'CREATED', 'Work item created', ?, ?)`
      ).run(`al_${crypto.randomUUID()}`, id, user.id, JSON.stringify({ status: 'OPEN', priority, teamId }), now);

      db.prepare(
        `INSERT INTO outbox_events (id, event_type, payload_json, status, created_at)
         VALUES (?, 'WORK_ITEM_CREATED', ?, 'PENDING', ?)`
      ).run(`ob_${crypto.randomUUID()}`, JSON.stringify({ workItemId: id, priority, teamId }), now);

      const created = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      return { status: 201, body: { item: created } };
    });
  });

  // PATCH /api/work-items/:id - Atomic update with Optimistic Concurrency Control, State Machine, RBAC, and Handoffs
  app.patch('/api/work-items/:id', (req: Request, res: Response) => {
    return executeIdempotent(req, res, () => {
      const user = (req as any).user;
      const itemId = req.params.id;
      const {
        expectedVersion,
        status,
        priority,
        assigneeId,
        teamId,
        comment,
        actionType = 'UPDATED',
      } = req.body;

      if (typeof expectedVersion !== 'number') {
        return { status: 400, body: { error: 'expectedVersion (number) is required for concurrency control' } };
      }

      const current = db.prepare('SELECT * FROM work_items WHERE id = ?').get(itemId) as any;
      if (!current) {
        return { status: 404, body: { error: 'Work item not found' } };
      }

      // 1. Authorization Check on current owning team
      if (!hasTeamPermission(user, current.team_id, 'OPERATOR')) {
        return {
          status: 403,
          body: { error: `Forbidden: Requires OPERATOR or APPROVER role in team '${current.team_id}'` },
        };
      }

      // 2. Optimistic Concurrency Check (Fast check before validation, enforced again in SQL UPDATE)
      if (current.version !== expectedVersion) {
        return {
          status: 409,
          body: {
            error: 'Conflict: This work item was modified by another user since you loaded it.',
            code: 'VERSION_CONFLICT',
            currentServerState: current,
          },
        };
      }

      const nextStatus: WorkStatus = status ?? current.status;
      const nextPriority: string = priority ?? current.priority;
      const nextAssigneeId: string | null = assigneeId !== undefined ? assigneeId : current.assignee_id;
      const nextTeamId: string = teamId ?? current.team_id;
      let nextApprovedBy: string | null = current.approved_by;

      // 3. Workflow State Machine Validation
      if (nextStatus !== current.status) {
        const allowed = ALLOWED_TRANSITIONS[current.status as WorkStatus] || [];
        if (!allowed.includes(nextStatus)) {
          return {
            status: 422,
            body: {
              error: `Invalid workflow state transition from '${current.status}' to '${nextStatus}'. Allowed: ${allowed.join(', ')}`,
            },
          };
        }

        // Approving an item requires APPROVER role in the owning team
        if (nextStatus === 'APPROVED') {
          if (!hasTeamPermission(user, current.team_id, 'APPROVER')) {
            return {
              status: 403,
              body: { error: 'Forbidden: Only a team APPROVER can transition an item to APPROVED.' },
            };
          }
          nextApprovedBy = user.id;
        }

        // Items requiring approval cannot be resolved until approved
        if (nextStatus === 'RESOLVED' && current.requires_approval === 1 && !nextApprovedBy) {
          return {
            status: 422,
            body: { error: 'Workflow rule violation: This item requires formal approval before it can be resolved.' },
          };
        }
      }

      // 4. Atomic Update guarded by version
      const now = new Date().toISOString();
      const nextAction = computeNextAction(
        nextStatus,
        nextAssigneeId,
        Boolean(current.requires_approval),
        nextApprovedBy
      );

      const updateResult = db
        .prepare(
          `
          UPDATE work_items
          SET status = ?,
              priority = ?,
              assignee_id = ?,
              team_id = ?,
              approved_by = ?,
              next_action_required = ?,
              version = version + 1,
              updated_at = ?
          WHERE id = ? AND version = ?
        `
        )
        .run(
          nextStatus,
          nextPriority,
          nextAssigneeId,
          nextTeamId,
          nextApprovedBy,
          nextAction,
          now,
          itemId,
          expectedVersion
        );

      if (updateResult.changes === 0) {
        const latest = db.prepare('SELECT * FROM work_items WHERE id = ?').get(itemId);
        return {
          status: 409,
          body: {
            error: 'Concurrent update detected during commit.',
            code: 'VERSION_CONFLICT',
            currentServerState: latest,
          },
        };
      }

      // 5. Compute Diff & Record Immutable Audit Log
      const diff: Record<string, { from: any; to: any }> = {};
      if (current.status !== nextStatus) diff.status = { from: current.status, to: nextStatus };
      if (current.priority !== nextPriority) diff.priority = { from: current.priority, to: nextPriority };
      if (current.assignee_id !== nextAssigneeId) diff.assignee_id = { from: current.assignee_id, to: nextAssigneeId };
      if (current.team_id !== nextTeamId) diff.team_id = { from: current.team_id, to: nextTeamId };

      db.prepare(
        `INSERT INTO audit_logs (id, work_item_id, actor_id, action_type, comment, changes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `al_${crypto.randomUUID()}`,
        itemId,
        user.id,
        actionType,
        comment || null,
        JSON.stringify(diff),
        now
      );

      // 6. Enqueue Asynchronous Notification / Escalation Event in Transactional Outbox
      db.prepare(
        `INSERT INTO outbox_events (id, event_type, payload_json, status, created_at)
         VALUES (?, 'WORK_ITEM_UPDATED', ?, 'PENDING', ?)`
      ).run(
        `ob_${crypto.randomUUID()}`,
        JSON.stringify({ workItemId: itemId, actorId: user.id, diff }),
        now
      );

      const updated = db.prepare('SELECT * FROM work_items WHERE id = ?').get(itemId);
      return { status: 200, body: { item: updated } };
    });
  });

  // Background Outbox Processor (Retry-safe & Idempotent)
  function processOutboxBatch(simulateFailure = false) {
    const pending = db
      .prepare(
        `SELECT * FROM outbox_events WHERE status = 'PENDING' AND attempts < 3 ORDER BY created_at ASC LIMIT 20`
      )
      .all() as any[];

    const results = { processed: 0, failed: 0 };

    for (const evt of pending) {
      try {
        if (simulateFailure) {
          throw new Error('Simulated downstream notification timeout');
        }
        // In production: dispatch Slack webhook / email / PagerDuty event with evt.id as deduplication key
        db.prepare(
          `UPDATE outbox_events SET status = 'PROCESSED', attempts = attempts + 1, processed_at = ? WHERE id = ? AND status = 'PENDING'`
        ).run(new Date().toISOString(), evt.id);
        results.processed++;
      } catch (err: any) {
        const nextAttempts = evt.attempts + 1;
        const nextStatus = nextAttempts >= 3 ? 'FAILED' : 'PENDING';
        db.prepare(
          `UPDATE outbox_events SET status = ?, attempts = ?, last_error = ? WHERE id = ?`
        ).run(nextStatus, nextAttempts, err.message, evt.id);
        results.failed++;
      }
    }
    return results;
  }

  app.post('/api/outbox/process', (_req: Request, res: Response) => {
    const stats = processOutboxBatch(false);
    const queueCounts = db
      .prepare(`SELECT status, COUNT(*) as count FROM outbox_events GROUP BY status`)
      .all();
    res.json({ stats, queueCounts });
  });

  return { app, processOutboxBatch };
}