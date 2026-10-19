import React, { useEffect, useState, useCallback } from 'react';

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
  const [context, setContext] = useState<any>(null);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [summary, setSummary] = useState<any>({});
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [audits, setAudits] = useState<AuditEntry[]>([]);

  // Filters
  const [teamFilter, setTeamFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [requiresAttentionOnly, setRequiresAttentionOnly] = useState<boolean>(false);

  // Conflict & Error State
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
      }
    },
    [apiFetch]
  );

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Execute a version-checked, idempotent mutation on the selected work item
  async function mutateWorkItem(patch: Record<string, any>) {
    if (!selectedItem) return;
    setErrorBanner(null);

    const idempotencyKey = `idem_${selectedItem.id}_v${selectedItem.version}_${ JSON.stringify(patch)}`;

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
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 font-sans">
      {/* Top Bar & Identity Switcher */}
      <header className="flex flex-wrap justify-between items-center bg-white p-4 rounded-lg shadow-sm border border-slate-200 mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Newtonite Ops Control Center</h1>
          <p className="text-xs text-slate-500">
            Real-time operational coordination with OCC, RBAC & Idempotent execution
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-xs font-semibold uppercase text-slate-500">Active Operator:</label>
          <select
            value={currentUserId}
            onChange={(e) => setCurrentUserId(e.target.value)}
            className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-slate-50 font-medium"
          >
            {context?.users?.map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Operational Triage Summary Bar */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg border border-slate-200">
          <div className="text-xs text-slate-500 uppercase font-semibold">Unassigned Open</div>
          <div className="text-2xl font-bold text-amber-600">{summary.unassigned_open || 0}</div>
        </div>
        <div className="bg-white p-4 rounded-lg border border-slate-200">
          <div className="text-xs text-slate-500 uppercase font-semibold">Awaiting Approval</div>
          <div className="text-2xl font-bold text-indigo-600">{summary.awaiting_approval || 0}</div>
        </div>
        <div className="bg-white p-4 rounded-lg border border-slate-200">
          <div className="text-xs text-slate-500 uppercase font-semibold">Active Critical</div>
          <div className="text-2xl font-bold text-red-600">{summary.active_critical || 0}</div>
        </div>
        <div className="bg-white p-4 rounded-lg border border-slate-200">
          <div className="text-xs text-slate-500 uppercase font-semibold">Blocked Items</div>
          <div className="text-2xl font-bold text-slate-700">{summary.blocked_count || 0}</div>
        </div>
      </div>

      {/* Main Split View */}
      <div className="grid grid-cols-12 gap-6">
        {/* Left Column: Search, Filters & Queue */}
        <div className="col-span-7 bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex flex-wrap gap-2 mb-4">
            <input
              type="text"
              placeholder="Search ID, title, description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="border border-slate-300 rounded px-3 py-1.5 text-sm flex-1"
            />
            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-sm"
            >
              <option value="">All Teams</option>
              {context?.teams?.map((t: any) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-sm"
            >
              <option value="">All Statuses</option>
              <option value="OPEN">OPEN</option>
              <option value="IN_PROGRESS">IN_PROGRESS</option>
              <option value="AWAITING_APPROVAL">AWAITING_APPROVAL</option>
              <option value="APPROVED">APPROVED</option>
              <option value="BLOCKED">BLOCKED</option>
              <option value="RESOLVED">RESOLVED</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs font-medium px-2 py-1 bg-amber-50 text-amber-900 rounded border border-amber-200 cursor-pointer">
              <input
                type="checkbox"
                checked={requiresAttentionOnly}
                onChange={(e) => setRequiresAttentionOnly(e.target.checked)}
              />
              Needs Attention
            </label>
          </div>

          <div className="divide-y divide-slate-200">
            {items.map((item) => (
              <div
                key={item.id}
                onClick={() => loadDetail(item.id)}
                className={`p-3 cursor-pointer hover:bg-slate-50 transition ${
                  selectedItem?.id === item.id ? 'bg-blue-50/60 border-l-4 border-blue-600' : ''
                }`}
              >
                <div className="flex justify-between items-start mb-1">
                  <span className="font-semibold text-sm text-slate-900">
                    [{item.id}] {item.title}
                  </span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                    v{item.version}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-slate-600 mb-1.5">
                  <span className="font-semibold text-red-700">{item.priority}</span>
                  <span>•</span>
                  <span className="font-medium text-indigo-700">{item.status}</span>
                  <span>•</span>
                  <span>Team: {item.team_name}</span>
                  <span>•</span>
                  <span>Owner: {item.assignee_name || 'Unassigned'}</span>
                </div>
                <div className="text-xs text-amber-800 bg-amber-50/80 px-2 py-1 rounded">
                  <strong>Next:</strong> {item.next_action_required}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Column: Detail Inspector, Concurrency Reconciliation & Audit Trail */}
        <div className="col-span-5 bg-white rounded-lg border border-slate-200 p-4">
          {!selectedItem ? (
            <div className="text-sm text-slate-500 py-12 text-center">
              Select a work item from the queue to inspect details, claim ownership, or transition workflow state.
            </div>
          ) : (
            <div>
              {errorBanner && (
                <div className="mb-4 p-3 bg-red-50 border border-red-300 text-red-800 text-xs rounded">
                  <strong>Action Rejected:</strong> {errorBanner}
                </div>
              )}

              {/* Stale Data / 409 Conflict Resolution Prompt */}
              {conflictState && (
                <div className="mb-4 p-3 bg-amber-50 border border-amber-400 text-amber-900 text-xs rounded">
                  <div className="font-bold mb-1">
                    Concurrent Modification Detected (Server is at v{conflictState.version}, your view is v{selectedItem.version})
                  </div>
                  <p className="mb-2">
                    Latest server status is <strong>{conflictState.status}</strong> (Assignee:{' '}
                    {conflictState.assignee_id || 'Unassigned'}).
                  </p>
                  <button
                    onClick={() => loadDetail(selectedItem.id)}
                    className="bg-amber-700 text-white px-3 py-1 rounded font-medium"
                  >
                    Reload Latest Server State (v{conflictState.version})
                  </button>
                </div>
              )}

              <div className="border-b border-slate-200 pb-3 mb-4">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-mono text-slate-500">
                    {selectedItem.id} • Version v{selectedItem.version}
                  </span>
                  <span className="text-xs font-semibold px-2 py-0.5 bg-slate-100 rounded">
                    {selectedItem.status}
                  </span>
                </div>
                <h2 className="text-base font-bold mt-1">{selectedItem.title}</h2>
                <p className="text-xs text-slate-600 mt-1">{selectedItem.description}</p>
              </div>

              <div className="mb-4">
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  Operational Note / Decision Rationale (Saved to Audit Trail)
                </label>
                <input
                  type="text"
                  placeholder="Why are you taking this action?"
                  value={commentInput}
                  onChange={(e) => setCommentInput(e.target.value)}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs mb-2"
                />

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() =>
                      mutateWorkItem({
                        assigneeId: currentUserId,
                        status: selectedItem.status === 'OPEN' ? 'IN_PROGRESS' : selectedItem.status,
                        actionType: 'CLAIMED',
                      })
                    }
                    className="bg-blue-600 text-white text-xs px-3 py-1.5 rounded font-medium"
                  >
                    Claim & Start Work
                  </button>

                  <button
                    onClick={() =>
                      mutateWorkItem({
                        status: 'AWAITING_APPROVAL',
                        actionType: 'REQUESTED_APPROVAL',
                      })
                    }
                    className="bg-indigo-600 text-white text-xs px-3 py-1.5 rounded font-medium"
                  >
                    Request Approval
                  </button>

                  <button
                    onClick={() =>
                      mutateWorkItem({
                        status: 'APPROVED',
                        actionType: 'APPROVED',
                      })
                    }
                    className="bg-emerald-600 text-white text-xs px-3 py-1.5 rounded font-medium"
                  >
                    Approve (Approver Role Only)
                  </button>

                  <button
                    onClick={() =>
                      mutateWorkItem({
                        status: 'RESOLVED',
                        actionType: 'RESOLVED',
                      })
                    }
                    className="bg-slate-800 text-white text-xs px-3 py-1.5 rounded font-medium"
                  >
                    Mark Resolved
                  </button>
                </div>
              </div>

              {/* Immutable Audit History */}
              <div>
                <h3 className="text-xs font-bold uppercase text-slate-500 mb-2">
                  Immutable Audit & Collaboration History ({audits.length})
                </h3>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {audits.map((a) => (
                    <div key={a.id} className="text-xs bg-slate-50 p-2 rounded border border-slate-200">
                      <div className="flex justify-between font-semibold text-slate-800">
                        <span>
                          {a.actor_name} — {a.action_type}
                        </span>
                        <span className="text-slate-400">{new Date(a.created_at).toLocaleTimeString()}</span>
                      </div>
                      {a.comment && <div className="text-slate-700 italic mt-0.5">"{a.comment}"</div>}
                      <div className="font-mono text-[11px] text-slate-500 mt-1">{a.changes_json}</div>
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