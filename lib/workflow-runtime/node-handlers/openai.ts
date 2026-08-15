import OpenAI from 'openai';
import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

function getParam(node: EngineNode, keys: string[]): string {
  const params = node.parameters ?? {};
  for (const key of keys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return '';
}

function getNumParam(node: EngineNode, key: string, fallback: number): number {
  const val = (node.parameters ?? {})[key];
  if (typeof val === 'number' && isFinite(val)) return val;
  const n = Number(val);
  return isFinite(n) ? n : fallback;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

export async function openaiHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext,
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);

  const prompt = getParam(node, ['prompt', 'userMessage']);
  const model = getParam(node, ['model']) || 'gpt-4o-mini';
  const systemMessage = getParam(node, ['systemMessage', 'system']);
  const temperature = getNumParam(node, 'temperature', 0.7);
  const maxTokens = getNumParam(node, 'maxTokens', 1000);

  if (!prompt) {
    return {
      status: 'failed',
      outputData: null,
      logs: ['OpenAI: prompt is required'],
      error: 'prompt is required',
    };
  }

  if (context.mode === 'test') {
    const preview = {
      model,
      prompt,
      content: `[SIMULATED] Response to: "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`,
      usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
    };
    logs.push('OpenAI call simulated in test mode.');
    return {
      status: 'simulated_success',
      outputData: { ...data, ...preview },
      logs,
    };
  }

  // Live mode — resolve API key from integrations context.
  // Cast to string: IntegrationProvider union may not yet include 'openai'.
  const integration = context.integrations.find(
    (i) => (i.provider as string) === 'openai' || (i.provider as string) === 'claude',
  );
  const apiKey = (integration?.credentials as Record<string, string> | undefined)?.api_key;

  if (!apiKey) {
    logs.push('OpenAI: API key not configured. Connect your OpenAI integration first.');
    return {
      status: 'failed',
      outputData: null,
      logs,
      error: 'OpenAI API key not configured',
    };
  }

  try {
    const client = new OpenAI({ apiKey });

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (systemMessage) messages.push({ role: 'system', content: systemMessage });
    messages.push({ role: 'user', content: prompt });

    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: Math.min(Math.max(1, maxTokens), 4096),
    });

    const content = completion.choices[0]?.message?.content ?? '';
    const usage = completion.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    logs.push(`OpenAI response received. tokens_used=${usage.total_tokens}`);

    return {
      status: 'success',
      outputData: {
        ...data,
        model,
        content,
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
        },
        finish_reason: completion.choices[0]?.finish_reason ?? 'stop',
      },
      logs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`OpenAI API error: ${msg}`);
    return { status: 'failed', outputData: null, logs, error: msg };
  }
}
