import { NextRequest, NextResponse } from 'next/server';

import { processConversationTurn } from '@/lib/conversation/service';
import { createUserSafeAssistantPayload } from '@/lib/conversation/user-safe-payload';

export const dynamic = "force-dynamic";

function sseChunk(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    message?: string;
    sessionId?: string;
    mode?: 'safe_preview' | 'staging_deploy' | 'production_deploy';
  };

  const message = String(body.message ?? '').trim();
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: string, payload: unknown) => {
        if (closed || req.signal.aborted) return;
        const safeEvent = ['token', 'status', 'tool_event', 'final', 'error'].includes(event)
          ? createUserSafeAssistantPayload(event as 'token' | 'status' | 'tool_event' | 'final' | 'error', payload)
          : payload;
        controller.enqueue(encoder.encode(sseChunk(event, safeEvent)));
      };

      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      req.signal.addEventListener('abort', () => {
        close();
      });

      send('status', { message: 'Analyzing your request...' });

      try {
        const payload = await processConversationTurn({
          req,
          message,
          sessionId: body.sessionId,
          mode: body.mode,
          onProgress: async (update) => {
            send('status', { message: update.message, type: update.type });
            if (update.event || update.workflowGraph || update.toolName) {
              send('tool_event', {
                event: update.event,
                workflowGraph: update.workflowGraph,
                toolName: update.toolName,
              });
            }
          },
        });

        if (closed || req.signal.aborted) return;

        const tokens = payload.assistant.content.split(/(\s+)/).filter(Boolean);
        for (const token of tokens) {
          if (closed || req.signal.aborted) return;
          send('token', { text: token });
          await wait(14);
        }

        send('final', { payload });
        send('done', { ok: true });
        close();
      } catch (error) {
        send('error', {
          message: error instanceof Error ? error.message : 'Conversation streaming failed',
        });
        close();
      }
    },
    cancel() {
      // client disconnected
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
