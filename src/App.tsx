import { useEffect, useState, useCallback, FormEvent } from 'react';
import './App.css';

interface WorkItem {
  id: string;
  title: string;
  description: string;
  type: string;
  status: string;
  priority: string;
  requires_approval: number;
  team_id: string;
  team_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  approved_by: string | null;
  approver_name: string | null;
  next_action_required: string;
  version: number;
  updated_at: string;
}

interface AuditEntry {
  id: string;
  actor_name: string;
  action_type: string;
  comment: string | null;
  changes_json: string;
  created_at: string;
}

export default function App() {
  const [currentUserId, setCurrentUserId] = useState<string>('u_alice');
  const [context, setContext] = useState<{
    currentUser: { id: string; name: string; rolesByTeam: Record<string, string> };
    users: { id: string; name: string }[];
    teams: { id: string; name: string }[];
  } | null>(null);

  const [items, setItems] = useState<WorkItem[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [audits, setAudits] = useState<AuditEntry[]>([]);

  // Filters
  const [teamFilter, setTeamFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [requiresAttentionOnly, setRequiresAttentionOnly] = useState<boolean>(false);

  // Create Form State
  const [showCreate, setShowCreate] = useState<boolean>(false);
  const [newTitle, setNewTitle] = useState<string>('');
  const [newDesc, setNewDesc] = useState<string>('');
  const [newType, setNewType] = useState<string>('INCIDENT');
  const [newPriority, setNewPriority] = useState<string>('HIGH');
  const [newTeamId, setNewTeamId] = useState<string>('t_payments');

  // Concurrency Conflict & Feedback State
  const [conflictState, setConflictState] = useState<WorkItem | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [commentInput, setCommentInput] = useState<string>('');

  const apiFetch = useCallback(
    async (url: string, options: RequestInit = {}) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-User-Id': currentUserId,
        ...((options.headers as Record<string, string>) || {}),
      };
      return fetch(url, { ...options, headers });
    },
    [currentUserId]
  );

  const loadList = useCallback(async () => {
    const params = new URLSearchParams();
    if (teamFilter) params.set('teamId', teamFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (searchQuery) params.set('search', searchQuery);
    if (requiresAttentionOnly) params.set('requiresAttention', 'true');

    const [ctxRes, listRes] = await Promise.all([
      apiFetch('/api/context'),
      apiFetch(`/api/work-items?${params.toString()}`),
    ]);
    const ctxData = await ctxRes.json();
    const listData = await listRes.json();
    setContext(ctxData);
    setItems(listData.items || []);
    setSummary(listData.summary || {});
  }, [apiFetch, teamFilter, statusFilter, searchQuery, requiresAttentionOnly]);

  const loadDetail = useCallback(
    async (id: string) => {
      const res = await apiFetch(`/api/work-items/${id}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedItem(data.item);
        setAudits(data.audits || []);
        setConflictState(null);
        setErrorBanner(null);
      }
    },
    [apiFetch]
  );

  useEffect(() => {
    loadList();
  }, [loadList]);

  async function handleCreateItem(e: FormEvent) {
    e.preventDefault();
    setErrorBanner(null);
    const idempotencyKey = `create_${currentUserId}_${newTitle.trim()}`;

    const res = await apiFetch('/api/work-items', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        title: newTitle,
        description: newDesc,
        type: newType,
        priority: newPriority,
        teamId: newTeamId,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      setErrorBanner(data.error || 'Failed to create work item');
      return;
    }

    setNewTitle('');
    setNewDesc('');
    setShowCreate(false);
    await loadList();
    if (data.item?.id) {
      await loadDetail(data.item.id);
    }
  }

  async function mutateWorkItem(patch: Record<string, unknown>) {
    if (!selectedItem) return;
    setErrorBanner(null);

    const idempotencyKey = `idem_${selectedItem.id}_v${selectedItem.version}_${JSON.stringify(patch)}`;

    const res = await apiFetch(`/api/work-items/${selectedItem.id}`, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        expectedVersion: selectedItem.version,
        comment: commentInput || undefined,
        ...patch,
      }),
    });

    const data = await res.json();

    if (res.status === 409 && data.code === 'VERSION_CONFLICT') {
      setConflictState(data.currentServerState);
      setErrorBanner(data.error);
      return;
    }

    if (!res.ok) {
      setErrorBanner(data.error || 'Operation failed');
      return;
    }

    setCommentInput('');
    await Promise.all([loadList(), loadDetail(selectedItem.id)]);
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: 24 }}>
      {/* Header */}
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: '#fff',
          padding: 16,
          borderRadius: 8,
          border: '1px solid #e2e8f0',
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Newtonite Operational Command</h1>
          <span style={{ fontSize: 12, color: '#64748b' }}>
            Active Roles:{' '}
            {context?.currentUser?.rolesByTeam
              ? Object.entries(context.currentUser.rolesByTeam)
                  .map(([team, role]) => `${team}: ${role}`)
                  .join(' | ')
              : 'Loading...'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            onClick={() => setShowCreate(!showCreate)}
            style={{
              background: '#0f172a',
              color: '#fff',
              padding: '8px 14px',
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            + New Work Item
          </button>

          <select
            value={currentUserId}
            onChange={(e) => setCurrentUserId(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13 }}
          >
            {context?.users?.map((u) => (
              <option key={u.id} value={u.id}>
                Switch User: {u.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Create Work Item Drawer */}
      {showCreate && (
        <form
          onSubmit={handleCreateItem}
          style={{
            background: '#fff',
            padding: 16,
            borderRadius: 8,
            border: '1px solid #cbd5e1',
            marginBottom: 20,
            display: 'grid',
            gap: 10,
          }}
        >
          <strong style={{ fontSize: 14 }}>Create Operational Work Item</strong>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              required
              placeholder="Title (e.g., Wire settlement stuck in queue)"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              style={{ flex: 2, padding: 8, borderRadius: 4, border: '1px solid #cbd5e1' }}
            />
            <select
              value={newTeamId}
              onChange={(e) => setNewTeamId(e.target.value)}
              style={{ padding: 8, borderRadius: 4, border: '1px solid #cbd5e1' }}
            >
              {context?.teams?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              style={{ padding: 8, borderRadius: 4, border: '1px solid #cbd5e1' }}
            >
              <option value="INCIDENT">INCIDENT</option>
              <option value="PAYMENT_INVESTIGATION">PAYMENT_INVESTIGATION (Requires Approval)</option>
              <option value="COMPLIANCE_APPROVAL">COMPLIANCE_APPROVAL (Requires Approval)</option>
              <option value="CUSTOMER_ISSUE">CUSTOMER_ISSUE</option>
              <option value="OPS_TASK">OPS_TASK</option>
            </select>
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value)}
              style={{ padding: 8, borderRadius: 4, border: '1px solid #cbd5e1' }}
            >
              <option value="CRITICAL">CRITICAL</option>
              <option value="HIGH">HIGH</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="LOW">LOW</option>
            </select>
          </div>
          <textarea
            required
            placeholder="Detailed context and investigation steps..."
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            style={{ padding: 8, borderRadius: 4, border: '1px solid #cbd5e1', minHeight: 60 }}
          />
          <div>
            <button
              type="submit"
              style={{ background: '#2563eb', color: '#fff', padding: '8px 16px', borderRadius: 4, fontWeight: 600 }}
            >
              Submit Work Item
            </button>
          </div>
        </form>
      )}

      {/* Triage Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Unassigned Open', value: summary.unassigned_open || 0, color: '#d97706' },
          { label: 'Awaiting Approval', value: summary.awaiting_approval || 0, color: '#4f46e5' },
          { label: 'Active Critical', value: summary.active_critical || 0, color: '#dc2626' },
          { label: 'Blocked Items', value: summary.blocked_count || 0, color: '#475569' },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{ background: '#fff', padding: 14, borderRadius: 8, border: '1px solid #e2e8f0' }}
          >
            <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#64748b', fontWeight: 600 }}>
              {stat.label}
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Main Split Interface */}
      <div style={{ display: 'grid', gridTemplateColumns: '7fr 5fr', gap: 20 }}>
        {/* Left: Queue */}
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0', padding: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <input
              placeholder="Search ID, title, description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 13 }}
            />
            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 13 }}
            >
              <option value="">All Teams</option>
              {context?.teams?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 13 }}
            >
              <option value="">All Statuses</option>
              <option value="OPEN">OPEN</option>
              <option value="IN_PROGRESS">IN_PROGRESS</option>
              <option value="AWAITING_APPROVAL">AWAITING_APPROVAL</option>
              <option value="APPROVED">APPROVED</option>
              <option value="BLOCKED">BLOCKED</option>
              <option value="RESOLVED">RESOLVED</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={requiresAttentionOnly}
                onChange={(e) => setRequiresAttentionOnly(e.target.checked)}
              />
              Needs Attention
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((item) => (
              <div
                key={item.id}
                onClick={() => loadDetail(item.id)}
                style={{
                  padding: 12,
                  borderRadius: 6,
                  border: selectedItem?.id === item.id ? '2px solid #2563eb' : '1px solid #e2e8f0',
                  background: selectedItem?.id === item.id ? '#eff6ff' : '#fff',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <strong style={{ fontSize: 14 }}>
                    [{item.id}] {item.title}
                  </strong>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', background: '#f1f5f9', padding: '2px 6px' }}>
                    v{item.version}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#475569', marginBottom: 6 }}>
                  <strong style={{ color: '#dc2626' }}>{item.priority}</strong> • <strong>{item.status}</strong> • Team:{' '}
                  {item.team_name} • Owner: {item.assignee_name || 'Unassigned'}
                </div>
                <div style={{ fontSize: 12, background: '#fffbeb', color: '#92400e', padding: '4px 8px', borderRadius: 4 }}>
                  <strong>Next:</strong> {item.next_action_required}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Inspector & Audit History */}
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0', padding: 16 }}>
          {errorBanner && (
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #f87171',
                color: '#991b1b',
                padding: 10,
                borderRadius: 6,
                fontSize: 12,
                marginBottom: 12,
              }}
            >
              <strong>Operational Guardrail:</strong> {errorBanner}
            </div>
          )}

          {conflictState && selectedItem && (
            <div
              style={{
                background: '#fffbeb',
                border: '1px solid #fbbf24',
                color: '#92400e',
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                marginBottom: 12,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                Stale View Detected (Server is at v{conflictState.version}, your screen had v{selectedItem.version})
              </div>
              <div style={{ marginBottom: 8 }}>
                Another operator updated this item to status <strong>{conflictState.status}</strong>.
              </div>
              <button
                onClick={() => loadDetail(selectedItem.id)}
                style={{ background: '#b45309', color: '#fff', padding: '6px 12px', borderRadius: 4, fontSize: 12 }}
              >
                Reload Latest Server State (v{conflictState.version})
              </button>
            </div>
          )}

          {!selectedItem ? (
            <div style={{ color: '#64748b', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>
              Select a work item from the list to inspect or execute workflow transitions.
            </div>
          ) : (
            <div>
              <div style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {selectedItem.id} • Version v{selectedItem.version} • {selectedItem.type}
                </div>
                <h2 style={{ margin: '4px 0', fontSize: 17 }}>{selectedItem.title}</h2>
                <p style={{ margin: 0, fontSize: 13, color: '#334155' }}>{selectedItem.description}</p>
              </div>

              <div style={{ marginBottom: 16 }}>
                <input
                  placeholder="Decision rationale / handoff note (recorded in immutable audit log)..."
                  value={commentInput}
                  onChange={(e) => setCommentInput(e.target.value)}
                  style={{
                    width: '100%',
                    padding: 8,
                    borderRadius: 4,
                    border: '1px solid #cbd5e1',
                    fontSize: 12,
                    marginBottom: 8,
                  }}
                />

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <button
                    onClick={() =>
                      mutateWorkItem({
                        assigneeId: currentUserId,
                        status: selectedItem.status === 'OPEN' ? 'IN_PROGRESS' : selectedItem.status,
                        actionType: 'CLAIMED',
                      })
                    }
                    style={{ background: '#2563eb', color: '#fff', padding: '6px 10px', borderRadius: 4, fontSize: 12 }}
                  >
                    Claim & Start Work
                  </button>
                  <button
                    onClick={() => mutateWorkItem({ status: 'AWAITING_APPROVAL', actionType: 'REQUESTED_APPROVAL' })}
                    style={{ background: '#4f46e5', color: '#fff', padding: '6px 10px', borderRadius: 4, fontSize: 12 }}
                  >
                    Request Approval
                  </button>
                  <button
                    onClick={() => mutateWorkItem({ status: 'APPROVED', actionType: 'APPROVED' })}
                    style={{ background: '#059669', color: '#fff', padding: '6px 10px', borderRadius: 4, fontSize: 12 }}
                  >
                    Approve (Approver Only)
                  </button>
                  <button
                    onClick={() => mutateWorkItem({ status: 'BLOCKED', actionType: 'BLOCKED' })}
                    style={{ background: '#d97706', color: '#fff', padding: '6px 10px', borderRadius: 4, fontSize: 12 }}
                  >
                    Mark Blocked
                  </button>
                  <button
                    onClick={() => mutateWorkItem({ status: 'RESOLVED', actionType: 'RESOLVED' })}
                    style={{ background: '#0f172a', color: '#fff', padding: '6px 10px', borderRadius: 4, fontSize: 12 }}
                  >
                    Resolve
                  </button>
                </div>
              </div>

              <div>
                <strong style={{ fontSize: 12, textTransform: 'uppercase', color: '#64748b' }}>
                  Audit History ({audits.length})
                </strong>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, maxHeight: 280, overflowY: 'auto' }}>
                  {audits.map((a) => (
                    <div
                      key={a.id}
                      style={{ background: '#f8fafc', padding: 8, borderRadius: 4, border: '1px solid #e2e8f0', fontSize: 12 }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                        <span>
                          {a.actor_name} — {a.action_type}
                        </span>
                        <span style={{ color: '#94a3b8', fontSize: 11 }}>
                          {new Date(a.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                      {a.comment && <div style={{ fontStyle: 'italic', marginTop: 2 }}>"{a.comment}"</div>}
                      <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748b', marginTop: 4 }}>
                        {a.changes_json}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}