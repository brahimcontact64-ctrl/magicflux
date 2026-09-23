/**
 * Phase 9.9.21 -- Part 4: copyable integration examples for custom-code
 * websites, built from the workflow's REAL webhook URL and REAL derived
 * fields (never a generic `{"example":"value"}` placeholder).
 *
 * Every example forwards through a server-side handler rather than calling
 * the webhook directly from public browser JavaScript with the secret
 * embedded -- per the explicit product requirement not to encourage
 * shipping MagicFlux credentials into a public bundle. The browser-facing
 * snippet posts to the site's OWN `/api/lead` (or equivalent) endpoint;
 * only the server-side snippets ever see the real secret.
 */

export type CodeSnippet = { id: string; label: string; language: string; code: string };

function samplePayloadLiteral(sample: Record<string, unknown>, indent = '  '): string {
  const lines = Object.entries(sample).map(([k, v]) => `${indent}"${k}": ${JSON.stringify(v)}`);
  return `{\n${lines.join(',\n')}\n}`;
}

export function buildCodeSnippets(params: {
  webhookUrl: string;
  method: string;
  secretHeaderName: string;
  secretValue: string;
  samplePayload: Record<string, unknown>;
}): CodeSnippet[] {
  const { webhookUrl, method, secretHeaderName, secretValue, samplePayload } = params;
  const payloadJson = samplePayloadLiteral(samplePayload);
  const fieldNames = Object.keys(samplePayload);

  return [
    {
      id: 'browser-fetch',
      // Short on purpose -- rendered as a fixed-width, non-wrapping tab
      // trigger (components/ui/tabs.tsx). A longer label here overflowed
      // the page horizontally at 320px (Phase 9.9.21 mobile-first finding);
      // the full "call this from your server, not the browser" guidance
      // lives in the code comment below instead, where it can wrap freely.
      label: 'JS (fetch)',
      language: 'javascript',
      code: [
        '// Do NOT call this from public browser JavaScript with the secret embedded --',
        '// anyone viewing your page source could read it and trigger your workflow.',
        '// Post the form to YOUR OWN server route instead (e.g. /api/lead below),',
        '// and have that server route forward to MagicFlux with the secret attached.',
        '',
        `const res = await fetch("${webhookUrl}", {`,
        `  method: "${method}",`,
        '  headers: {',
        '    "Content-Type": "application/json",',
        `    "${secretHeaderName}": process.env.MAGICFLUX_WEBHOOK_SECRET, // never hardcode this`,
        '  },',
        `  body: JSON.stringify(${payloadJson.split('\n').map((l, i) => (i === 0 ? l : `  ${l}`)).join('\n')}),`,
        '});',
      ].join('\n'),
    },
    {
      id: 'html-form',
      label: 'HTML + server',
      language: 'html',
      code: [
        `<form method="POST" action="/api/lead">`,
        ...fieldNames.map((f) => `  <input type="text" name="${f}" required />`),
        '  <button type="submit">Submit</button>',
        '</form>',
        '',
        '<!-- /api/lead is YOUR OWN server route -- it receives the form submission',
        '     and forwards it to MagicFlux server-side, where the secret is safe. -->',
      ].join('\n'),
    },
    {
      id: 'nextjs',
      label: 'Next.js',
      language: 'typescript',
      code: [
        '// app/api/lead/route.ts',
        "import { NextRequest, NextResponse } from 'next/server';",
        '',
        'export async function POST(req: NextRequest) {',
        '  const body = await req.json();',
        `  const res = await fetch("${webhookUrl}", {`,
        `    method: "${method}",`,
        '    headers: {',
        "      'Content-Type': 'application/json',",
        `      '${secretHeaderName}': process.env.MAGICFLUX_WEBHOOK_SECRET!,`,
        '    },',
        '    body: JSON.stringify(body),',
        '  });',
        '  return NextResponse.json(await res.json(), { status: res.status });',
        '}',
      ].join('\n'),
    },
    {
      id: 'nodejs',
      label: 'Node.js',
      language: 'javascript',
      code: [
        `const res = await fetch("${webhookUrl}", {`,
        `  method: "${method}",`,
        '  headers: {',
        "    'Content-Type': 'application/json',",
        `    '${secretHeaderName}': process.env.MAGICFLUX_WEBHOOK_SECRET,`,
        '  },',
        `  body: JSON.stringify(${payloadJson.split('\n').map((l, i) => (i === 0 ? l : `  ${l}`)).join('\n')}),`,
        '});',
      ].join('\n'),
    },
    {
      id: 'php',
      label: 'PHP',
      language: 'php',
      code: [
        '<?php',
        `$payload = json_encode(${JSON.stringify(samplePayload, null, 2).replace(/"/g, "'")});`,
        `$ch = curl_init("${webhookUrl}");`,
        'curl_setopt($ch, CURLOPT_POST, true);',
        'curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);',
        'curl_setopt($ch, CURLOPT_HTTPHEADER, [',
        "    'Content-Type: application/json',",
        `    '${secretHeaderName}: ' . getenv('MAGICFLUX_WEBHOOK_SECRET'),`,
        ']);',
        'curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);',
        '$response = curl_exec($ch);',
        'curl_close($ch);',
      ].join('\n'),
    },
    {
      id: 'python',
      label: 'Python',
      language: 'python',
      code: [
        'import os',
        'import requests',
        '',
        `payload = ${JSON.stringify(samplePayload, null, 4)}`,
        'response = requests.post(',
        `    "${webhookUrl}",`,
        '    json=payload,',
        '    headers={',
        `        "${secretHeaderName}": os.environ["MAGICFLUX_WEBHOOK_SECRET"],`,
        '    },',
        ')',
      ].join('\n'),
    },
  ];
}

/** Compact copy/paste developer-handoff spec (Part 7) -- never includes the real secret value unless the caller explicitly opts in. */
export function buildDeveloperHandoff(params: {
  webhookUrl: string;
  method: string;
  secretHeaderName: string;
  secretValue: string | null;
  requiredFields: string[];
  optionalFields: string[];
  samplePayload: Record<string, unknown>;
}): string {
  const { webhookUrl, method, secretHeaderName, secretValue, requiredFields, optionalFields, samplePayload } = params;
  return [
    '# MagicFlux webhook -- integration spec',
    '',
    `Endpoint: ${webhookUrl}`,
    `Method: ${method}`,
    `Content-Type: application/json`,
    '',
    'Authentication:',
    `  Header: ${secretHeaderName}`,
    `  Value: ${secretValue ?? '<ask the workflow owner for the current secret -- not included here>'}`,
    '',
    `Required fields: ${requiredFields.length ? requiredFields.join(', ') : 'none'}`,
    `Optional fields: ${optionalFields.length ? optionalFields.join(', ') : 'none'}`,
    '',
    'Example request body:',
    JSON.stringify(samplePayload, null, 2),
    '',
    'Expected behavior:',
    '  Success: HTTP 202 with a JSON body containing "executionId".',
    '  Missing/invalid auth header: HTTP 401.',
    '  Invalid JSON body: HTTP 400.',
    '  Workflow not active yet: HTTP 422.',
  ].join('\n');
}
