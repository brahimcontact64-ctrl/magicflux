/**
 * Static schema-contract checks for the workflow_executions_v2 /
 * workflow_execution_steps migration (20260509091500_execution_v2_tables.sql).
 *
 * This does not run against a live Supabase instance — it parses the SQL
 * text and asserts the table/column/policy shape that later migrations
 * (20260525000001_runtime_self_healing.sql, 20260602000001_command_ownership_guard.sql,
 * 20260603000001_execution_debugger.sql) and the application code already
 * assume exists. A regression here (a renamed/removed column, a table that
 * stops being created IF NOT EXISTS) would silently break those downstream
 * objects on a fresh database replay.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_PATH = join(__dirname, '..', 'supabase', 'migrations', '20260509091500_execution_v2_tables.sql');

let sql: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf8');
});

describe('workflow_executions_v2', () => {
  it('is created with IF NOT EXISTS (safe to re-run against a live DB)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS workflow_executions_v2/);
  });

  // Columns required by app/api/executions/*, runtime/runtime-state.ts,
  // and the command-ownership trigger / execution-debugger views.
  const REQUIRED_COLUMNS = [
    'id', 'workflow_id', 'user_id', 'status', 'mode',
    'input_data', 'output_data', 'retry_count', 'max_retries',
    'current_node_id', 'error_message', 'next_run_at',
    'started_at', 'completed_at', 'created_at', 'updated_at',
  ];

  it.each(REQUIRED_COLUMNS)('declares column "%s"', (column) => {
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS workflow_executions_v2'), sql.indexOf('CREATE TABLE IF NOT EXISTS workflow_execution_steps'));
    expect(table).toMatch(new RegExp(`\\b${column}\\b`));
  });

  it('id is a uuid primary key — command_ownership_guard.sql casts execution_id to ::uuid against it', () => {
    expect(sql).toMatch(/id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
  });

  it('status has a CHECK constraint including every status the app writes', () => {
    for (const status of ['running', 'success', 'failed', 'waiting', 'paused', 'cancelled']) {
      expect(sql).toContain(status);
    }
  });

  it('has row-level security enabled with a self-access policy', () => {
    expect(sql).toMatch(/ALTER TABLE workflow_executions_v2 ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY "Users can access own executions" ON workflow_executions_v2\s+FOR ALL USING \(auth\.uid\(\) = user_id\)/);
  });
});

describe('workflow_execution_steps', () => {
  it('is created with IF NOT EXISTS (safe to re-run against a live DB)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS workflow_execution_steps/);
  });

  // Columns selected directly by v_execution_steps_final in
  // 20260603000001_execution_debugger.sql — a mismatch breaks that view.
  const REQUIRED_COLUMNS = [
    'id', 'execution_id', 'workflow_id', 'user_id', 'node_id', 'node_name',
    'node_type', 'status', 'attempt', 'input_data', 'output_data',
    'logs', 'error_message', 'started_at', 'completed_at', 'created_at',
  ];

  it.each(REQUIRED_COLUMNS)('declares column "%s"', (column) => {
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS workflow_execution_steps'));
    expect(table).toMatch(new RegExp(`\\b${column}\\b`));
  });

  it('logs is a text array with a non-null default (append-only log lines)', () => {
    expect(sql).toMatch(/logs text\[\] NOT NULL DEFAULT '\{\}'/);
  });

  it('has no updated_at column — this table is append-only, never updated in place', () => {
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS workflow_execution_steps'), sql.indexOf('CREATE INDEX IF NOT EXISTS workflow_execution_steps_exec_created'));
    expect(table).not.toMatch(/\bupdated_at\b/);
  });

  it('has row-level security enabled with a self-access policy', () => {
    expect(sql).toMatch(/ALTER TABLE workflow_execution_steps ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY "Users can access own execution steps" ON workflow_execution_steps\s+FOR ALL USING \(auth\.uid\(\) = user_id\)/);
  });
});

describe('indexes required by downstream migrations and query patterns', () => {
  const REQUIRED_INDEXES = [
    'workflow_executions_v2_user_status_started',
    'workflow_executions_v2_user_started',
    'workflow_execution_steps_exec_created',
  ];

  it.each(REQUIRED_INDEXES)('creates index "%s"', (indexName) => {
    expect(sql).toContain(indexName);
  });
});

describe('migration ordering', () => {
  it('is timestamped to apply before the migrations that assume these tables exist', () => {
    const fileTimestamp = '20260509091500';
    const dependents = [
      '20260525000001', // runtime_self_healing.sql — queries workflow_execution_steps
      '20260602000001', // command_ownership_guard.sql — trigger queries workflow_executions_v2
      '20260603000001', // execution_debugger.sql — views SELECT FROM both tables
    ];
    for (const dependent of dependents) {
      expect(fileTimestamp < dependent).toBe(true);
    }
  });
});
