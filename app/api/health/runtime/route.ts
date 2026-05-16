import { NextResponse } from 'next/server';

import { getRedisStatus, RUNTIME_QUEUE_NAMES } from '@/lib/runtime/queue';

export async function GET() {
  const redis = await getRedisStatus();

  return NextResponse.json({
    redis,
    workers: 'configured',
    queues: RUNTIME_QUEUE_NAMES,
  });
}
