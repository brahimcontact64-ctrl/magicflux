import type { AuthStrategy } from './types';

export function applyAuthStrategy(params: {
  strategy: AuthStrategy;
  credentials: Record<string, string>;
  headers?: HeadersInit;
  url: URL;
}): { headers: Headers; url: URL } {
  const headers = new Headers(params.headers ?? {});
  const credentials = params.credentials;

  if (params.strategy.type === 'bearer_token') {
    const token = credentials.api_key ?? credentials.token ?? '';
    if (token) {
      headers.set(params.strategy.headerName ?? 'Authorization', `${params.strategy.tokenPrefix ?? 'Bearer '}${token}`);
    }
    return { headers, url: params.url };
  }

  if (params.strategy.type === 'api_key_header') {
    const token = credentials.api_key ?? credentials.token ?? '';
    if (token) {
      headers.set(params.strategy.headerName ?? 'X-API-Key', token);
    }
    return { headers, url: params.url };
  }

  if (params.strategy.type === 'oauth2') {
    const token = credentials.access_token ?? credentials.api_key ?? '';
    if (token) {
      headers.set(params.strategy.headerName ?? 'Authorization', `${params.strategy.tokenPrefix ?? 'Bearer '}${token}`);
    }
    return { headers, url: params.url };
  }

  if (params.strategy.type === 'basic_auth') {
    const username = credentials[params.strategy.usernameField ?? 'username'] ?? '';
    const password = credentials[params.strategy.passwordField ?? 'password'] ?? '';
    if (username || password) {
      const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      headers.set(params.strategy.headerName ?? 'Authorization', `${params.strategy.tokenPrefix ?? 'Basic '}${encoded}`);
    }
    return { headers, url: params.url };
  }

  if (params.strategy.type === 'custom_header') {
    const token = credentials.api_key ?? credentials.token ?? '';
    if (token) {
      headers.set(params.strategy.headerName ?? 'X-Provider-Key', token);
    }
    return { headers, url: params.url };
  }

  if (params.strategy.type === 'query_key') {
    const token = credentials.api_key ?? credentials.token ?? '';
    if (token) {
      params.url.searchParams.set(params.strategy.queryParam ?? 'api_key', token);
    }
    return { headers, url: params.url };
  }

  if (params.strategy.type === 'session_cookie') {
    const cookie = credentials.session_cookie ?? '';
    if (cookie) {
      headers.set('Cookie', `${params.strategy.cookieName ?? 'session'}=${cookie}`);
    }
  }

  return { headers, url: params.url };
}
