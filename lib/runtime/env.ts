export type RuntimeEnvValidationResult = {
  ok: boolean;
  missing: string[];
};

export const REQUIRED_RUNTIME_ENV_VARS = [
  'OPENAI_API_KEY',
  'REDIS_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'N8N_API_URL',
  'N8N_API_KEY',
] as const;

export function validateRuntimeEnv(required: readonly string[] = REQUIRED_RUNTIME_ENV_VARS): RuntimeEnvValidationResult {
  const missing = required.filter((name) => {
    const value = process.env[name];
    return !value || value.trim().length === 0;
  });

  return {
    ok: missing.length === 0,
    missing,
  };
}

export function assertRuntimeEnv(required?: readonly string[]): void {
  const check = validateRuntimeEnv(required);
  if (!check.ok) {
    throw new Error(`Missing required runtime env vars: ${check.missing.join(', ')}`);
  }
}
