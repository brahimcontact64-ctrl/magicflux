import {
  inferCapabilitiesFromText,
} from './capability-inference-engine';
import type {
  AuthStrategy,
  OpenApiDiscovery,
  ProviderDiscoveryResult,
} from './types';

function withTimeout<T>(promise: Promise<T>, timeoutMs = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(id);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(id);
        reject(err);
      });
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCandidateUrls(providerHint: string): string[] {
  const clean = providerHint.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const candidates = new Set<string>();

  if (providerHint.startsWith('http://') || providerHint.startsWith('https://')) {
    candidates.add(providerHint);
    return Array.from(candidates);
  }

  candidates.add(`https://${clean}.com`);
  candidates.add(`https://${clean}.ai`);
  candidates.add(`https://${clean}.io`);
  candidates.add(`https://api.${clean}.com`);
  candidates.add(`https://docs.${clean}.com`);
  candidates.add(`https://platform.${clean}.com`);

  return Array.from(candidates);
}

function detectAuthStrategiesFromText(text: string): AuthStrategy[] {
  const lower = text.toLowerCase();
  const strategies: AuthStrategy[] = [];

  if (lower.includes('authorization: bearer') || lower.includes('bearer token')) {
    strategies.push({ type: 'bearer_token', headerName: 'Authorization', tokenPrefix: 'Bearer ' });
  }
  if (lower.includes('x-api-key') || lower.includes('api key header')) {
    strategies.push({ type: 'api_key_header', headerName: 'X-API-Key' });
  }
  if (lower.includes('oauth2') || lower.includes('oauth 2')) {
    strategies.push({ type: 'oauth2' });
  }
  if (lower.includes('basic auth')) {
    strategies.push({ type: 'basic_auth', tokenPrefix: 'Basic ' });
  }
  if (lower.includes('api_key=') || lower.includes('apikey=')) {
    strategies.push({ type: 'query_key', queryParam: 'api_key' });
  }
  if (lower.includes('cookie') && lower.includes('session')) {
    strategies.push({ type: 'session_cookie', cookieName: 'session' });
  }

  if (strategies.length === 0) {
    strategies.push({ type: 'bearer_token', headerName: 'Authorization', tokenPrefix: 'Bearer ' });
  }

  return strategies;
}

function detectEndpointHintsFromText(text: string): string[] {
  const matches = text.match(/\/(v\d+\/)?[a-z0-9/_-]{3,60}/gi) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    if (match.length < 4) continue;
    unique.add(match);
    if (unique.size >= 25) break;
  }
  return Array.from(unique);
}

function parseOpenApiSecuritySchemes(spec: Record<string, unknown>): OpenApiDiscovery['securitySchemes'] {
  const components = (spec.components ?? {}) as Record<string, unknown>;
  const securitySchemes = (components.securitySchemes ?? {}) as Record<string, Record<string, unknown>>;

  return Object.entries(securitySchemes).map(([key, value]) => ({
    key,
    type: String(value.type ?? 'unknown'),
    in: typeof value.in === 'string' ? value.in : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    scheme: typeof value.scheme === 'string' ? value.scheme : undefined,
  }));
}

function authStrategiesFromOpenApi(discovery: OpenApiDiscovery): AuthStrategy[] {
  const strategies: AuthStrategy[] = [];
  for (const scheme of discovery.securitySchemes) {
    if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      strategies.push({ type: 'bearer_token', headerName: 'Authorization', tokenPrefix: 'Bearer ' });
      continue;
    }
    if (scheme.type === 'apiKey' && scheme.in === 'header') {
      strategies.push({ type: 'api_key_header', headerName: scheme.name ?? 'X-API-Key' });
      continue;
    }
    if (scheme.type === 'apiKey' && scheme.in === 'query') {
      strategies.push({ type: 'query_key', queryParam: scheme.name ?? 'api_key' });
      continue;
    }
    if (scheme.type === 'oauth2') {
      strategies.push({ type: 'oauth2' });
    }
  }
  return strategies;
}

export async function parseOpenApiDocument(url: string): Promise<OpenApiDiscovery | null> {
  try {
    const res = await withTimeout(fetch(url, { method: 'GET', headers: { Accept: 'application/json' } }), 10_000);
    if (!res.ok) return null;
    const raw = await res.json() as Record<string, unknown>;

    const title = String((raw.info as Record<string, unknown> | undefined)?.title ?? '');
    const description = String((raw.info as Record<string, unknown> | undefined)?.description ?? '');
    const version = String((raw.info as Record<string, unknown> | undefined)?.version ?? '');

    const servers = Array.isArray(raw.servers)
      ? raw.servers
          .map((item) => String((item as Record<string, unknown>).url ?? ''))
          .filter(Boolean)
      : [];

    const pathObj = (raw.paths ?? {}) as Record<string, unknown>;
    const paths = Object.keys(pathObj);

    const securitySchemes = parseOpenApiSecuritySchemes(raw);
    const endpointHints = paths.slice(0, 25);

    return {
      title,
      description,
      version,
      servers,
      paths,
      securitySchemes,
      endpointHints,
    };
  } catch {
    return null;
  }
}

export async function discoverProvider(params: {
  providerHint: string;
  docsUrl?: string;
  homepageUrl?: string;
  openApiUrl?: string;
}): Promise<ProviderDiscoveryResult> {
  const signals: string[] = [];
  const candidateUrls = [
    ...(params.homepageUrl ? [params.homepageUrl] : []),
    ...(params.docsUrl ? [params.docsUrl] : []),
    ...buildCandidateUrls(params.providerHint),
  ];

  let homepageUrl = params.homepageUrl;
  let docsUrl = params.docsUrl;
  let rawText = '';

  for (const url of candidateUrls) {
    try {
      const res = await withTimeout(fetch(url, { method: 'GET' }), 6000);
      if (!res.ok) continue;
      const html = await res.text();
      const text = stripHtml(html).slice(0, 80_000);
      if (!text) continue;
      rawText = text;
      homepageUrl = homepageUrl ?? url;
      if (text.toLowerCase().includes('api reference') || text.toLowerCase().includes('developer')) {
        docsUrl = docsUrl ?? url;
      }
      signals.push(`Fetched:${url}`);
      break;
    } catch {
      continue;
    }
  }

  const openApiCandidates = [
    params.openApiUrl,
    docsUrl ? `${docsUrl.replace(/\/$/, '')}/openapi.json` : undefined,
    docsUrl ? `${docsUrl.replace(/\/$/, '')}/swagger.json` : undefined,
    homepageUrl ? `${homepageUrl.replace(/\/$/, '')}/openapi.json` : undefined,
    homepageUrl ? `${homepageUrl.replace(/\/$/, '')}/swagger.json` : undefined,
  ].filter(Boolean) as string[];

  let openApi: OpenApiDiscovery | null = null;
  for (const candidate of openApiCandidates) {
    openApi = await parseOpenApiDocument(candidate);
    if (openApi) {
      signals.push(`OpenAPI:${candidate}`);
      break;
    }
  }

  const capabilityText = [rawText, openApi?.title ?? '', openApi?.description ?? ''].join(' ');
  const discoveredCapabilities = inferCapabilitiesFromText(capabilityText);

  const authFromText = detectAuthStrategiesFromText(rawText);
  const authFromOpenApi = openApi ? authStrategiesFromOpenApi(openApi) : [];
  const discoveredAuthStrategies = [...authFromOpenApi, ...authFromText].filter(
    (strategy, idx, list) => idx === list.findIndex((other) => other.type === strategy.type && other.headerName === strategy.headerName)
  );

  const endpointHints = Array.from(new Set([
    ...(openApi?.endpointHints ?? []),
    ...detectEndpointHintsFromText(rawText),
  ])).slice(0, 30);

  const resolvedProviderName = (openApi?.title || params.providerHint || 'unknown').trim();

  const confidence = Math.max(
    20,
    Math.min(
      95,
      (rawText ? 30 : 0) + (openApi ? 35 : 0) + (discoveredCapabilities.length > 0 ? 15 : 0) + (discoveredAuthStrategies.length > 0 ? 15 : 0)
    )
  );

  return {
    providerHint: params.providerHint,
    resolvedProviderName,
    docsUrl,
    homepageUrl,
    openApiUrl: openApiCandidates[0],
    discoveredCapabilities,
    discoveredAuthStrategies,
    endpointHints,
    openApi: openApi ?? undefined,
    rawSignals: signals,
    confidence,
  };
}
