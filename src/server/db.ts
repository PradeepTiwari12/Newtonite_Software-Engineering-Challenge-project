import Database from 'better-sqlite3';

export function createDb(dbPath = ':memory:'): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      is_global_admin INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_memberships (
      user_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('VIEWER', 'OPERATOR', 'APPROVER')),
      PRIMARY KEY (user_id, team_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('CUSTOMER_ISSUE', 'INCIDENT', 'PAYMENT_INVESTIGATION', 'COMPLIANCE_APPROVAL', 'OPS_TASK')),
      status TEXT NOT NULL CHECK(status IN ('OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'APPROVED', 'BLOCKED', 'RESOLVED', 'CLOSED')),
      priority TEXT NOT NULL CHECK(priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
      requires_approval INTEGER NOT NULL DEFAULT 0,
      team_id TEXT NOT NULL,
      assignee_id TEXT,
      created_by TEXT NOT NULL,
      approved_by TEXT,
      next_action_required TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (assignee_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (approved_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_work_items_team_status_priority 
      ON work_items(team_id, status, priority);
    CREATE INDEX IF NOT EXISTS idx_work_items_assignee 
      ON work_items(assignee_id, status);
    CREATE INDEX IF NOT EXISTS idx_work_items_updated_at 
      ON work_items(updated_at DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      comment TEXT,
      changes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_work_item 
      ON audit_logs(work_item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idempotency_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, user_id)
    );

    CREATE TABLE IF NOT EXISTS outbox_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'PROCESSED', 'FAILED')) DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status, created_at);
  `);

  return db;
}

export function seedDb(db: Database.Database) {
  const existing = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  if (existing.count > 0) return;

  const insertUser = db.prepare('INSERT INTO users (id, name, email, is_global_admin) VALUES (?, ?, ?, ?)');
  insertUser.run('u_alice', 'Alice Chen (Payments Lead)', 'alice@newtonite.io', 0);
  insertUser.run('u_bob', 'Bob Smith (Payments Operator)', 'bob@newtonite.io', 0);
  insertUser.run('u_charlie', 'Charlie Davis (SRE Approver)', 'charlie@newtonite.io', 0);
  insertUser.run('u_diana', 'Diana Prince (Support Viewer)', 'diana@newtonite.io', 0);

  const insertTeam = db.prepare('INSERT INTO teams (id, name, slug) VALUES (?, ?, ?)');
  insertTeam.run('t_payments', 'Payments Operations', 'payments-ops');
  insertTeam.run('t_sre', 'Platform SRE', 'platform-sre');
  insertTeam.run('t_compliance', 'Risk & Compliance', 'risk-compliance');

  const insertMember = db.prepare('INSERT INTO team_memberships (user_id, team_id, role) VALUES (?, ?, ?)');
  // Alice: Approver in Payments, Operator in Compliance
  insertMember.run('u_alice', 't_payments', 'APPROVER');
  insertMember.run('u_alice', 't_compliance', 'OPERATOR');
  // Bob: Operator in Payments, Viewer in SRE
  insertMember.run('u_bob', 't_payments', 'OPERATOR');
  insertMember.run('u_bob', 't_sre', 'VIEWER');
  // Charlie: Approver in SRE & Compliance
  insertMember.run('u_charlie', 't_sre', 'APPROVER');
  insertMember.run('u_charlie', 't_compliance', 'APPROVER');
  // Diana: Viewer in Payments
  insertMember.run('u_diana', 't_payments', 'VIEWER');

  const now = new Date().toISOString();
  const insertItem = db.prepare(`
    INSERT INTO work_items (
      id, title, description, type, status, priority, requires_approval,
      team_id, assignee_id, created_by, approved_by, next_action_required, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  insertItem.run(
    'wi_101',
    'High-value wire settlement stuck in clearing (#TX-99412)',
    'Merchant settlement of $145,000 has been pending gateway confirmation for 4 hours. Requires manual ledger verification and supervisor approval before replay.',
    'PAYMENT_INVESTIGATION',
    'AWAITING_APPROVAL',
    'CRITICAL',
    1,
    't_payments',
    'u_bob',
    'u_bob',
    null,
    'Requires APPROVER in Payments Operations to review and approve replay',
    now,
    now
  );

  insertItem.run(
    'wi_102',
    'Elevated 502 Bad Gateway rates in EU-West ingress cluster',
    'Customer API latency spiked by 350ms. Auto-scaling group hit max capacity limit.',
    'INCIDENT',
    'OPEN',
    'HIGH',
    0,
    't_sre',
    null,
    'u_charlie',
    null,
    'Unassigned HIGH priority incident — requires immediate operator claim',
    now,
    now
  );

  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (id, work_item_id, actor_id, action_type, comment, changes_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertAudit.run('al_1', 'wi_101', 'u_bob', 'CREATED', 'Initial escalation from merchant support.', JSON.stringify({ status: 'AWAITING_APPROVAL' }), now);
  insertAudit.run('al_2', 'wi_102', 'u_charlie', 'CREATED', 'Triggered by PagerDuty alert.', JSON.stringify({ status: 'OPEN' }), now);
}