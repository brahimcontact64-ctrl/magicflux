import { executeWithProviderAdapter } from './generic-provider-runtime';
import type {
  ProviderAdapter,
  ProviderValidationReport,
} from './types';

export async function validateProviderAdapter(params: {
  adapter: ProviderAdapter;
  baseUrl: string;
  credentials: Record<string, string>;
  sampleInput?: Record<string, unknown>;
}): Promise<ProviderValidationReport> {
  const startedAt = Date.now();

  try {
    const sampleInput = params.sampleInput ?? {
      prompt: 'ping',
      input: 'ping',
      messages: [{ role: 'user', content: 'ping' }],
      model: 'auto',
    };

    const result = await executeWithProviderAdapter({
      adapter: params.adapter,
      baseUrl: params.baseUrl,
      credentials: params.credentials,
      input: sampleInput,
    });

    const latencyMs = Date.now() - startedAt;

    return {
      ok: true,
      authSuccess: true,
      endpointReachable: true,
      sampleExecution: true,
      quotaHealthy: result.status !== 429,
      latencyMs,
      statusCode: result.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const quotaIssue = /429|quota|rate limit/i.test(message);

    return {
      ok: false,
      authSuccess: !/401|403|auth|unauthorized/i.test(message),
      endpointReachable: !/dns|network|enotfound|timeout|fetch failed/i.test(message),
      sampleExecution: false,
      quotaHealthy: !quotaIssue,
      latencyMs: Date.now() - startedAt,
      error: message,
    };
  }
}
