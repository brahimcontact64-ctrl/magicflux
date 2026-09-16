/**
 * Phase 9.9.8B — Builder Persisted Workflow Identity / Airtable Editor fix.
 *
 * Root cause found: the Builder's Airtable configuration panel was rendered
 * inside ChatInterface, bound to the CONVERSATIONAL agent's own
 * persistedWorkflowId (lib/agent/executor.ts's ensurePersistedWorkflowDraft(),
 * linked via automation_conversations.workflow_id). But the real, already-
 * existing production draft the founder was looking at (id
 * ccbf722e-7843-4ba0-8874-6c96a86e41ab) was confirmed read-only to have ZERO
 * automation_conversations link -- it was produced by app/builder/page.tsx's
 * separate "planner" system (plannerResult / savedWorkflowId, saved via its
 * own POST /api/workflows call triggered by onPlannerReadyAction), which
 * never reported an id back to the conversational agent's own state at all.
 * The panel was therefore waiting on an id that could never arrive for that
 * workflow, no matter how long the founder waited -- an indefinite "Still
 * saving your workflow" with no way out.
 *
 * Fixes covered here:
 *   1. lib/builder/workflow-identity-status.ts -- the four explicit,
 *      terminating states (no_workflow / saving / persisted /
 *      persistence_failed) replacing the old, indefinite "still saving"
 *      heuristic. A recovered id (e.g. from localStorage after a refresh)
 *      is authoritative regardless of the save-lifecycle flag's own value.
 *   2. Airtable-config PATCH node isolation: configuring one of several
 *      Airtable nodes in the same workflow (Hot/Warm/Cold) must never
 *      mutate the other two.
 *   3. Duplicate workflow names never cause the wrong row to be read or
 *      written -- only the exact id in the URL/request ever matters, never
 *      a name lookup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { computeWorkflowIdentityStatus } from '../lib/builder/workflow-identity-status';

describe('computeWorkflowIdentityStatus', () => {
  it('no_workflow: nothing generated yet, no recovered id, no save attempt', () => {
    expect(computeWorkflowIdentityStatus({ hasResult: false, workflowId: null, saveState: 'idle' })).toBe('no_workflow');
  });

  it('saving: a plan exists, save is in flight, no id yet', () => {
    expect(computeWorkflowIdentityStatus({ hasResult: true, workflowId: null, saveState: 'saving' })).toBe('saving');
  });

  it('persistence_failed: the save attempt completed and failed -- a real, terminal, visible outcome (never indefinite "still saving")', () => {
    expect(computeWorkflowIdentityStatus({ hasResult: true, workflowId: null, saveState: 'failed' })).toBe('persistence_failed');
  });

  it('persisted: a real id exists', () => {
    expect(computeWorkflowIdentityStatus({ hasResult: true, workflowId: 'wf-123', saveState: 'saved' })).toBe('persisted');
  });

  it('a recovered id (e.g. restored from localStorage after a page refresh) is authoritative even while saveState is still its default "idle" -- the exact production refresh scenario', () => {
    // This is the precise state shape right after app/builder/page.tsx's
    // mount-time localStorage restore effect runs, before the save-lifecycle
    // effect has done anything at all this render.
    expect(computeWorkflowIdentityStatus({ hasResult: true, workflowId: 'wf-recovered-after-refresh', saveState: 'idle' })).toBe('persisted');
  });

  it('a recovered id always wins over a stale "failed" flag from a previous, unrelated attempt', () => {
    expect(computeWorkflowIdentityStatus({ hasResult: true, workflowId: 'wf-123', saveState: 'failed' })).toBe('persisted');
  });
});

// ─── Airtable-config PATCH: node isolation across Hot/Warm/Cold ───────────────

const OWNER_ID = '00000000-0000-4000-8000-0000000000f9';
const WORKFLOW_ID = 'wf-hot-warm-cold-isolation-test';
const WORKFLOW_ID_DUPLICATE_NAME = 'wf-duplicate-name-test';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  private matched(): Row[] { return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)); }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    if (this.pendingPatch) for (const row of m) Object.assign(row, this.pendingPatch);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  async then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    const m = this.matched();
    if (this.pendingPatch) for (const row of m) Object.assign(row, this.pendingPatch);
    return resolve({ data: m.map((r) => ({ ...r })), error: null });
  }
}

function hotWarmColdNode(suffix: 'Hot' | 'Warm' | 'Cold', id: string) {
  return {
    id,
    name: `Save to Airtable (${suffix})`,
    type: 'n8n-nodes-base.airtable',
    parameters: {
      operation: 'create',
      fields: { Name: '={{$json["name"]}}', Email: '={{$json["email"]}}', Classification: '={{$json["classification"]}}' },
    },
  };
}

function freshTables(): Record<string, Row[]> {
  return {
    workflows: [
      {
        id: WORKFLOW_ID,
        user_id: OWNER_ID,
        name: 'Lead Classification and Notification',
        workflow_json: {
          nodes: [
            hotWarmColdNode('Hot', 'hot-1'),
            hotWarmColdNode('Warm', 'warm-1'),
            hotWarmColdNode('Cold', 'cold-1'),
          ],
          connections: {},
        },
      },
      // Phase 9.9.8B -- a SECOND, separate workflow row sharing the exact
      // same display name (the real production scenario: multiple
      // "Lead Classification and Notification" drafts). Only the id in the
      // request/URL may ever select which row is read or written.
      {
        id: WORKFLOW_ID_DUPLICATE_NAME,
        user_id: OWNER_ID,
        name: 'Lead Classification and Notification',
        workflow_json: {
          nodes: [hotWarmColdNode('Hot', 'other-hot-1')],
          connections: {},
        },
      },
    ],
  };
}

let tables: Record<string, Row[]>;
let connectedAirtableToken: string | null;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])) })),
  getUserFromRequest: vi.fn(),
}));

vi.mock('@/lib/user-integrations', () => ({
  getConnectedAirtableToken: vi.fn(async () => connectedAirtableToken),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const LEADS_TABLE_RESPONSE = {
  tables: [
    {
      id: 'tblLeadsAAAAAAAA', name: 'Leads',
      fields: [
        { id: 'f1', name: 'Name', type: 'singleLineText' },
        { id: 'f2', name: 'Email', type: 'email' },
        { id: 'f3', name: 'Classification', type: 'singleSelect' },
        { id: 'f4', name: 'Confidence', type: 'number' },
      ],
    },
  ],
};

beforeEach(async () => {
  tables = freshTables();
  connectedAirtableToken = 'pat-fake-token';
  fetchMock.mockReset();
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockReset();
  vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
});

function makeReq(workflowId: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(`http://localhost/api/workflows/${workflowId}/airtable-config`), {
    method: 'PATCH', body: JSON.stringify(body),
  });
}

function nodesOf(workflowId: string) {
  const row = tables.workflows.find((w) => w.id === workflowId)!;
  return (row.workflow_json as { nodes: Array<Record<string, unknown>> }).nodes;
}

describe('PATCH /api/workflows/[id]/airtable-config -- Hot/Warm/Cold node isolation', () => {
  it('configuring the Hot node does not mutate the Warm or Cold nodes in the same workflow', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LEADS_TABLE_RESPONSE));
    const { PATCH } = await import('../app/api/workflows/[id]/airtable-config/route');

    const before = JSON.parse(JSON.stringify(nodesOf(WORKFLOW_ID).slice(1))); // Warm + Cold, deep copy

    const res = await PATCH(
      makeReq(WORKFLOW_ID, { nodeId: 'hot-1', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblLeadsAAAAAAAA', fieldMapping: { Name: 'Name', Email: 'Email', Classification: 'Classification' } }),
      { params: { id: WORKFLOW_ID } },
    );
    expect(res.status).toBe(200);

    const after = nodesOf(WORKFLOW_ID);
    const hotNode = after.find((n) => n.id === 'hot-1')!;
    expect((hotNode.parameters as Record<string, unknown>).baseId).toBe('appAAAAAAAAAAAAAA');

    // Warm and Cold: byte-identical to before the Hot save.
    expect(after.slice(1)).toEqual(before);
  });

  it('each of Hot, Warm, and Cold can be configured independently, ending in three distinct, correct configurations', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/airtable-config/route');

    fetchMock.mockResolvedValueOnce(jsonResponse(LEADS_TABLE_RESPONSE));
    await PATCH(makeReq(WORKFLOW_ID, { nodeId: 'hot-1', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblLeadsAAAAAAAA', fieldMapping: { Name: 'Name', Email: 'Email', Classification: 'Classification' } }), { params: { id: WORKFLOW_ID } });

    fetchMock.mockResolvedValueOnce(jsonResponse(LEADS_TABLE_RESPONSE));
    await PATCH(makeReq(WORKFLOW_ID, { nodeId: 'warm-1', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblLeadsAAAAAAAA', fieldMapping: { Name: 'Name', Email: 'Email' } }), { params: { id: WORKFLOW_ID } });

    fetchMock.mockResolvedValueOnce(jsonResponse(LEADS_TABLE_RESPONSE));
    await PATCH(makeReq(WORKFLOW_ID, { nodeId: 'cold-1', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblLeadsAAAAAAAA', fieldMapping: { Name: 'Name' } }), { params: { id: WORKFLOW_ID } });

    const nodes = nodesOf(WORKFLOW_ID);
    const hotFields = Object.keys((nodes.find((n) => n.id === 'hot-1')!.parameters as Record<string, unknown>).fields as Record<string, unknown>);
    const warmFields = Object.keys((nodes.find((n) => n.id === 'warm-1')!.parameters as Record<string, unknown>).fields as Record<string, unknown>);
    const coldFields = Object.keys((nodes.find((n) => n.id === 'cold-1')!.parameters as Record<string, unknown>).fields as Record<string, unknown>);

    expect(hotFields.sort()).toEqual(['Classification', 'Email', 'Name']);
    expect(warmFields.sort()).toEqual(['Email', 'Name']);
    expect(coldFields.sort()).toEqual(['Name']);
  });

  it('two workflows sharing the exact same display name never cross-contaminate -- only the id in the URL selects the row', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LEADS_TABLE_RESPONSE));
    const { PATCH } = await import('../app/api/workflows/[id]/airtable-config/route');

    const otherBefore = JSON.parse(JSON.stringify(nodesOf(WORKFLOW_ID_DUPLICATE_NAME)));

    const res = await PATCH(
      makeReq(WORKFLOW_ID, { nodeId: 'hot-1', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblLeadsAAAAAAAA', fieldMapping: { Name: 'Name' } }),
      { params: { id: WORKFLOW_ID } },
    );
    expect(res.status).toBe(200);

    // The second, identically-named workflow's own nodes are untouched.
    expect(nodesOf(WORKFLOW_ID_DUPLICATE_NAME)).toEqual(otherBefore);
  });

  it('a request naming the wrong node id for this workflow id 404s rather than silently touching a different workflow', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/airtable-config/route');
    // 'other-hot-1' only exists in WORKFLOW_ID_DUPLICATE_NAME, not WORKFLOW_ID.
    const res = await PATCH(
      makeReq(WORKFLOW_ID, { nodeId: 'other-hot-1', baseId: 'appAAAAAAAAAAAAAA', tableId: 'tblLeadsAAAAAAAA', fieldMapping: { Name: 'Name' } }),
      { params: { id: WORKFLOW_ID } },
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
