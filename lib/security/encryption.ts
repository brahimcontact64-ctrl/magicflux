import { decryptIntegrationCredentials, encryptIntegrationCredentials } from '@/lib/integration-crypto';

export function encryptJson(data: Record<string, unknown>): Record<string, unknown> {
  return encryptIntegrationCredentials(data);
}

export function decryptJson(data: Record<string, unknown> | null | undefined): Record<string, string> {
  return decryptIntegrationCredentials(data);
}
