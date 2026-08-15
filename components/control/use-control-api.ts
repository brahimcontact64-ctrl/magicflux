'use client';

import { useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiRequest } from '@/lib/api/client';
import { toast } from 'sonner';

export function useControlApi() {
  const { session } = useAuth();

  const getHeaders = useCallback((): HeadersInit | null => {
    const token = session?.access_token;
    if (!token) {
      toast.error('Session expired. Please sign in again.');
      return null;
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }, [session?.access_token]);

  const get = useCallback(async <T>(url: string): Promise<T | null> => {
    const headers = getHeaders();
    if (!headers) return null;
    try {
      return await apiRequest<T>(url, { headers, cache: 'no-store' }, 'Request failed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed');
      return null;
    }
  }, [getHeaders]);

  const post = useCallback(async <T>(url: string, body: unknown): Promise<T | null> => {
    const headers = getHeaders();
    if (!headers) return null;
    try {
      return await apiRequest<T>(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        'Action failed'
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
      return null;
    }
  }, [getHeaders]);

  return { get, post };
}
