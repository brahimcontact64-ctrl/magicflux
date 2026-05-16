import type IORedis from 'ioredis';

type RedisConnectionOptions = {
  key?: string;
  url?: string;
};

const redisClients = new Map<string, IORedis>();
let shutdownHooksRegistered = false;

function isServerRuntime(): boolean {
  return typeof window === 'undefined';
}

function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build' || process.env.npm_lifecycle_event === 'build';
}

export function canUseRuntimeRedis(): boolean {
  if (!isServerRuntime()) return false;
  if (process.env.NEXT_RUNTIME === 'edge') return false;
  if (isBuildPhase()) return false;
  return Boolean(process.env.REDIS_URL);
}

function registerShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  const closeAll = async () => {
    const closing = Array.from(redisClients.values()).map((client) => client.quit().catch(() => undefined));
    await Promise.allSettled(closing);
    redisClients.clear();
  };

  process.once('SIGINT', () => {
    void closeAll();
  });
  process.once('SIGTERM', () => {
    void closeAll();
  });
  process.once('beforeExit', () => {
    void closeAll();
  });
}

export async function getRedisConnection(options?: RedisConnectionOptions): Promise<IORedis | null> {
  if (!canUseRuntimeRedis()) return null;

  const key = options?.key ?? 'default';
  const existing = redisClients.get(key);
  if (existing) return existing;

  const redisUrl = options?.url ?? process.env.REDIS_URL;
  if (!redisUrl) return null;

  const { default: Redis } = await import('ioredis');
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (attempt: number) => {
      const base = Math.min(1000 * 2 ** Math.min(attempt, 8), 30_000);
      return base;
    },
  });

  client.on('error', (error: Error) => {
    const message = error.message ?? String(error);
    if (message.includes('ECONNRESET') || message.includes('ECONNREFUSED')) {
      console.warn(`[runtime-redis:${key}] ${message}`);
    }
  });

  redisClients.set(key, client);
  registerShutdownHooks();
  return client;
}

export async function closeRedisConnection(key?: string): Promise<void> {
  if (key) {
    const client = redisClients.get(key);
    if (!client) return;
    redisClients.delete(key);
    await client.quit().catch(() => undefined);
    return;
  }

  const closing = Array.from(redisClients.values()).map((client) => client.quit().catch(() => undefined));
  await Promise.allSettled(closing);
  redisClients.clear();
}
