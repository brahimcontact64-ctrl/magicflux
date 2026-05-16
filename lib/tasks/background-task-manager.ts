import "server-only";

import { createServiceClient } from '@/lib/supabase-server';
import type IORedis from 'ioredis';
import { canUseRuntimeRedis, closeRedisConnection, getRedisConnection } from '@/lib/runtime/redis';

type TaskQueueJob = {
  id: string | number;
  data: {
    taskId: string;
    userId: string;
  };
  remove: () => Promise<void>;
};

type TaskQueue = {
  add: (
    name: string,
    data: {
      taskId: string;
      userId: string;
      payload: any;
    },
    options: {
      jobId: string;
      priority: number;
      delay: number;
      attempts: number;
      backoff: {
        type: 'exponential';
        delay: number;
      };
    }
  ) => Promise<TaskQueueJob>;
  getJob: (jobId: string) => Promise<TaskQueueJob | null>;
  close: () => Promise<void>;
};

type TaskWorker = {
  on: (
    event: 'completed' | 'failed',
    handler: ((job: TaskQueueJob) => Promise<void> | void) | ((job: TaskQueueJob | undefined, err: Error) => Promise<void> | void)
  ) => void;
  close: () => Promise<void>;
};

export type TaskType =
  | 'generate_workflow'
  | 'validate_integrations'
  | 'deploy_workflow'
  | 'test_execution'
  | 'monitor_runs'
  | 'retry_failed'
  | 'generate_report';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_credentials'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type BackgroundTask = {
  id: string;
  userId: string;
  sessionId: string;
  workflowId?: string;
  taskType: TaskType;
  status: TaskStatus;
  priority: number;
  queueName: string;
  jobId?: string;
  payload: any;
  result?: any;
  errorMessage?: string;
  progress: any;
  retryCount: number;
  maxRetries: number;
  timeoutMs?: number;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
};

export class BackgroundTaskManager {
  private db = createServiceClient();
  private redis: IORedis | null = null;
  private readonly redisKey: string;
  private queues: Map<string, TaskQueue> = new Map();
  private workers: Map<string, TaskWorker> = new Map();

  constructor(private readonly redisUrl?: string) {
    this.redisKey = `background-task-manager:${process.pid}`;
  }

  private async getRedis(): Promise<IORedis | null> {
    if (this.redis) return this.redis;
    if (!canUseRuntimeRedis()) return null;
    this.redis = await getRedisConnection({ key: this.redisKey, url: this.redisUrl });
    return this.redis;
  }

  // Task Creation
  async createTask(
    userId: string,
    sessionId: string,
    taskType: TaskType,
    payload: any = {},
    options: {
      workflowId?: string;
      priority?: number;
      queueName?: string;
      timeoutMs?: number;
      maxRetries?: number;
    } = {}
  ): Promise<BackgroundTask> {
    const task = {
      user_id: userId,
      session_id: sessionId,
      workflow_id: options.workflowId || null,
      task_type: taskType,
      status: 'queued',
      priority: options.priority || 0,
      queue_name: options.queueName || 'default',
      payload,
      progress: {},
      retry_count: 0,
      max_retries: options.maxRetries || 3,
      timeout_ms: options.timeoutMs || null
    };

    const { data, error } = await this.db
      .from('background_tasks')
      .insert(task)
      .select()
      .single();

    if (error) throw error;

    const queueResult = await this.queueJob(data);
    if (!queueResult.enqueued) {
      const update = {
        status: 'failed',
        error_message: queueResult.reason,
        updated_at: new Date().toISOString(),
      };
      await this.db.from('background_tasks').update(update).eq('id', data.id);
      data.status = 'failed';
      data.error_message = queueResult.reason;
    }

    return this.transformTask(data);
  }

  // Task Management
  async getTask(taskId: string, userId: string): Promise<BackgroundTask | null> {
    const { data } = await this.db
      .from('background_tasks')
      .select('*')
      .eq('id', taskId)
      .eq('user_id', userId)
      .single();

    return data ? this.transformTask(data) : null;
  }

  async getUserTasks(
    userId: string,
    status?: TaskStatus,
    limit: number = 50
  ): Promise<BackgroundTask[]> {
    let query = this.db
      .from('background_tasks')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    const { data } = await query;
    return data ? data.map(this.transformTask) : [];
  }

  async cancelTask(taskId: string, userId: string): Promise<void> {
    const { error } = await this.db
      .from('background_tasks')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId)
      .eq('user_id', userId);

    if (error) throw error;

    // Cancel the job in queue
    const task = await this.getTask(taskId, userId);
    if (task?.jobId) {
      const queue = await this.getQueue(task.queueName);
      if (!queue) return;
      const job = await queue.getJob(task.jobId);
      if (job) {
        await job.remove();
      }
    }
  }

  async updateTaskProgress(
    taskId: string,
    progress: any,
    status?: TaskStatus
  ): Promise<void> {
    const update: any = {
      progress,
      updated_at: new Date().toISOString()
    };

    if (status) {
      update.status = status;
      if (status === 'running' && !update.started_at) {
        update.started_at = new Date().toISOString();
      } else if (['completed', 'failed', 'cancelled'].includes(status)) {
        update.completed_at = new Date().toISOString();
      }
    }

    const { error } = await this.db
      .from('background_tasks')
      .update(update)
      .eq('id', taskId);

    if (error) throw error;
  }

  // Queue Management
  private async getQueue(queueName: string): Promise<TaskQueue | null> {
    const redis = await this.getRedis();
    if (!redis) return null;

    if (typeof window !== 'undefined') return null;

    if (!this.queues.has(queueName)) {
      const bullmq = await import("bullmq");
      const BullQueue = bullmq.Queue as new (
        queueName: string,
        options: {
          connection: unknown;
          defaultJobOptions: {
            removeOnComplete: number;
            removeOnFail: number;
          };
        }
      ) => TaskQueue;
      const queue = new BullQueue(queueName, {
        connection: redis,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      });
      this.queues.set(queueName, queue);
    }
    return this.queues.get(queueName) ?? null;
  }

  private async queueJob(task: any): Promise<{ enqueued: boolean; reason?: string }> {
    const queue = await this.getQueue(task.queue_name);
    if (!queue) {
      return {
        enqueued: false,
        reason: 'Redis queue unavailable in current runtime environment',
      };
    }

    const job = await queue.add(
      task.task_type,
      {
        taskId: task.id,
        userId: task.user_id,
        payload: task.payload
      },
      {
        jobId: task.id,
        priority: task.priority,
        delay: 0,
        attempts: task.max_retries + 1,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      }
    );

    // Update job_id in database
    await this.db
      .from('background_tasks')
      .update({ job_id: job.id })
      .eq('id', task.id);

    return { enqueued: true };
  }

  // Worker Setup
  async setupWorker(queueName: string, processor: (job: TaskQueueJob) => Promise<void>): Promise<void> {
    if (!canUseRuntimeRedis()) {
      return;
    }

    if (typeof window !== 'undefined') {
      return;
    }

    if (this.workers.has(queueName)) {
      return; // Already set up
    }

    const redis = await this.getRedis();
    if (!redis) return;

    const bullmq = await import("bullmq");
    const BullWorker = bullmq.Worker as new (
      queueName: string,
      processor: (job: TaskQueueJob) => Promise<void>,
      options: {
        connection: unknown;
        concurrency: number;
        limiter: {
          max: number;
          duration: number;
        };
      }
    ) => TaskWorker;

    const worker = new BullWorker(queueName, processor, {
      connection: redis,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 1000,
      },
    });

    worker.on('completed', async (job: TaskQueueJob) => {
      await this.updateTaskProgress(job.data.taskId, { completed: true }, 'completed');
    });

    worker.on('failed', async (job: TaskQueueJob | undefined, err: Error) => {
      if (!job) return;
      const task = await this.getTask(job.data.taskId, job.data.userId);
      if (task && task.retryCount < task.maxRetries) {
        await this.updateTaskProgress(job.data.taskId, { error: err.message }, 'queued');
      } else {
        await this.updateTaskProgress(job.data.taskId, { error: err.message }, 'failed');
      }
    });

    this.workers.set(queueName, worker);
  }

  // Cleanup
  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    for (const worker of this.workers.values()) {
      await worker.close();
    }
    this.redis = null;
    await closeRedisConnection(this.redisKey);
  }

  private transformTask(data: any): BackgroundTask {
    return {
      id: data.id,
      userId: data.user_id,
      sessionId: data.session_id,
      workflowId: data.workflow_id,
      taskType: data.task_type,
      status: data.status,
      priority: data.priority,
      queueName: data.queue_name,
      jobId: data.job_id,
      payload: data.payload,
      result: data.result,
      errorMessage: data.error_message,
      progress: data.progress,
      retryCount: data.retry_count,
      maxRetries: data.max_retries,
      timeoutMs: data.timeout_ms,
      startedAt: data.started_at,
      completedAt: data.completed_at,
      cancelledAt: data.cancelled_at,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }
}

export const backgroundTaskManager = new BackgroundTaskManager();