export const DRAIN_CHANNEL = 'runtime:worker:drain';

const drainingWorkers = new Set<string>();

type DrainCacheEntry = { value: boolean; expiresAt: number };
const drainCache = new Map<string, DrainCacheEntry>();

export function markWorkerDraining(workerId: string): void {
  drainingWorkers.add(workerId);
  drainCache.delete(workerId);
}

export function markWorkerActive(workerId: string): void {
  drainingWorkers.delete(workerId);
  drainCache.delete(workerId);
}

export function isWorkerDrainingInMemory(workerId: string): boolean {
  return drainingWorkers.has(workerId);
}

export function getDrainCache(workerId: string): boolean | null {
  const entry = drainCache.get(workerId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    drainCache.delete(workerId);
    return null;
  }
  return entry.value;
}

export function setDrainCache(workerId: string, value: boolean, ttlMs: number): void {
  drainCache.set(workerId, { value, expiresAt: Date.now() + ttlMs });
}

export async function publishDrainSignal(workerId: string): Promise<void> {
  const { getRedisConnection, canUseRuntimeRedis } = await import('./redis');
  if (!canUseRuntimeRedis()) return;
  const redis = await getRedisConnection({ key: 'drain-signal:pub' });
  if (!redis) return;
  await redis.publish(DRAIN_CHANNEL, JSON.stringify({ workerId })).catch(() => undefined);
}

export async function subscribeDrainSignal(params: {
  workerId: string;
  onDrain: () => void;
}): Promise<(() => void) | null> {
  const { canUseRuntimeRedis } = await import('./redis');
  if (!canUseRuntimeRedis()) return null;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  const { default: Redis } = await import('ioredis');
  // Dedicated subscriber connection — subscribe mode cannot run other commands.
  const sub = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (attempt: number) => Math.min(1000 * 2 ** Math.min(attempt, 8), 30_000),
  });
  sub.on('error', () => undefined);
  await sub.subscribe(DRAIN_CHANNEL);

  sub.on('message', (channel: string, message: string) => {
    if (channel !== DRAIN_CHANNEL) return;
    try {
      const parsed = JSON.parse(message) as { workerId?: string };
      if (parsed.workerId === params.workerId) {
        params.onDrain();
      }
    } catch {
      // malformed drain message — ignore
    }
  });

  return () => {
    void sub.unsubscribe(DRAIN_CHANNEL).catch(() => undefined);
    void sub.quit().catch(() => undefined);
  };
}
