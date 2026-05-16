# Runtime Local Setup

## Redis

Run Redis locally with Docker:

```bash
docker run -p 6379:6379 redis
```

## Environment

Add this to `.env.local`:

```bash
REDIS_URL=redis://localhost:6379
```

## Start Development Runtime

Start app:

```bash
npm run dev
```

Start worker:

```bash
npm run dev:worker
```

Or start both:

```bash
npm run dev:all
```

## Runtime Health

Check runtime health:

- `GET /api/health/runtime`

Expected shape:

```json
{
  "redis": "connected",
  "workers": "configured",
  "queues": [
    "planner_queue",
    "deploy_queue",
    "execution_queue",
    "retry_queue",
    "monitoring_queue",
    "recovery_queue",
    "notification_queue"
  ]
}
```

If `REDIS_URL` is missing, APIs should fail honestly and return explicit runtime configuration errors.

## Vercel Warning

BullMQ workers do not run inside Vercel serverless functions.

Use one of these production worker options:

- VPS with a dedicated Node worker process
- Railway background worker service
- Render background worker
- Fly.io worker machine
- Docker Compose with app + worker + Redis
