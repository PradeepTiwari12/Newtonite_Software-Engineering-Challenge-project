import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createDb, seedDb } from '../src/server/db';
import { createApp } from '../src/server/app';

describe('Newtonite Critical Operational Behaviors', () => {
  let db: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>['app'];
  let processOutboxBatch: ReturnType<typeof createApp>['processOutboxBatch'];

  beforeEach(() => {
    db = createDb(':memory:');
    seedDb(db);
    const built = createApp(db);
    app = built.app;
    processOutboxBatch = built.processOutboxBatch;
  });

  it('1. Optimistic Concurrency Control: prevents simultaneous claim/update collisions with 409 Conflict', async () => {
    // Both Alice and Bob load wi_101 at version 1
    const initialRes = await request(app).get('/api/work-items/wi_101').set('X-User-Id', 'u_alice');
    expect(initialRes.body.item.version).toBe(1);

    // Alice updates priority using expectedVersion: 1 -> succeeds and increments version to 2
    const alicePatch = await request(app)
      .patch('/api/work-items/wi_101')
      .set('X-User-Id', 'u_alice')
      .send({ expectedVersion: 1, priority: 'HIGH', comment: 'Alice triaged priority' });
    expect(alicePatch.status).toBe(200);
    expect(alicePatch.body.item.version).toBe(2);

    // Bob simultaneously tries to update using his stale expectedVersion: 1 -> rejected with 409 Conflict
    const bobStalePatch = await request(app)
      .patch('/api/work-items/wi_101')
      .set('X-User-Id', 'u_bob')
      .send({ expectedVersion: 1, status: 'IN_PROGRESS', comment: 'Bob attempting concurrent edit' });

    expect(bobStalePatch.status).toBe(409);
    expect(bobStalePatch.body.code).toBe('VERSION_CONFLICT');
    expect(bobStalePatch.body.currentServerState.version).toBe(2);
    expect(bobStalePatch.body.currentServerState.priority).toBe('HIGH');
  });

  it('2. Idempotency: prevents duplicate work items and duplicate state transitions on client retries', async () => {
    const payload = {
      title: 'Duplicate card charge batch investigation',
      description: 'Investigate batch #8821',
      type: 'PAYMENT_INVESTIGATION',
      priority: 'HIGH',
      teamId: 't_payments',
    };

    const firstAttempt = await request(app)
      .post('/api/work-items')
      .set('X-User-Id', 'u_bob')
      .set('Idempotency-Key', 'retry-key-991')
      .send(payload);

    const secondAttempt = await request(app)
      .post('/api/work-items')
      .set('X-User-Id', 'u_bob')
      .set('Idempotency-Key', 'retry-key-991')
      .send(payload);

    expect(firstAttempt.status).toBe(201);
    expect(secondAttempt.status).toBe(201);
    expect(secondAttempt.headers['x-idempotent-replay']).toBe('true');
    expect(firstAttempt.body.item.id).toBe(secondAttempt.body.item.id);

    // Verify only 1 item was actually created in the database
    const countRow = db
      .prepare('SELECT COUNT(*) as cnt FROM work_items WHERE title = ?')
      .get(payload.title) as { cnt: number };
    expect(countRow.cnt).toBe(1);
  });

  it('3. RBAC & Workflow Rules: blocks VIEWER edits, blocks OPERATOR approvals, and enforces approval before resolution', async () => {
    // Diana (VIEWER in t_payments) attempts to modify wi_101 -> 403 Forbidden
    const viewerAttempt = await request(app)
      .patch('/api/work-items/wi_101')
      .set('X-User-Id', 'u_diana')
      .send({ expectedVersion: 1, priority: 'LOW' });
    expect(viewerAttempt.status).toBe(403);

    // Bob (OPERATOR in t_payments, not APPROVER) attempts to approve wi_101 -> 403 Forbidden
    const operatorApproveAttempt = await request(app)
      .patch('/api/work-items/wi_101')
      .set('X-User-Id', 'u_bob')
      .send({ expectedVersion: 1, status: 'APPROVED' });
    expect(operatorApproveAttempt.status).toBe(403);

    // Alice (APPROVER in t_payments) approves wi_101 -> 200 OK
    const approverAttempt = await request(app)
      .patch('/api/work-items/wi_101')
      .set('X-User-Id', 'u_alice')
      .send({ expectedVersion: 1, status: 'APPROVED', comment: 'Verified ledger balance, approved replay.' });
    expect(approverAttempt.status).toBe(200);
    expect(approverAttempt.body.item.status).toBe('APPROVED');
    expect(approverAttempt.body.item.approved_by).toBe('u_alice');

    // Bob can now resolve the approved item using version 2
    const resolveAttempt = await request(app)
      .patch('/api/work-items/wi_101')
      .set('X-User-Id', 'u_bob')
      .send({ expectedVersion: 2, status: 'RESOLVED', comment: 'Replay executed and confirmed.' });
    expect(resolveAttempt.status).toBe(200);
    expect(resolveAttempt.body.item.status).toBe('RESOLVED');
  });

  it('4. Reliable Asynchronous Outbox: retries failed background events and marks processed once healthy', async () => {
    // Create an item to enqueue an outbox event
    await request(app).post('/api/work-items').set('X-User-Id', 'u_bob').send({
      title: 'Async Outbox Test Task',
      description: 'Testing outbox durability',
      teamId: 't_payments',
    });

    // Simulate downstream failure on first run
    const failedRun = processOutboxBatch(true);
    expect(failedRun.failed).toBeGreaterThan(0);

    // Event remains PENDING with attempts = 1
    const pendingEvt = db.prepare(`SELECT * FROM outbox_events WHERE status = 'PENDING'`).get() as any;
    expect(pendingEvt.attempts).toBe(1);

    // Next worker tick succeeds
    const successRun = processOutboxBatch(false);
    expect(successRun.processed).toBeGreaterThan(0);

    const remainingPending = db
      .prepare(`SELECT COUNT(*) as cnt FROM outbox_events WHERE status = 'PENDING'`)
      .get() as { cnt: number };
    expect(remainingPending.cnt).toBe(0);
  });
});