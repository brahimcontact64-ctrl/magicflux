import { NextRequest } from 'next/server';
import { reasonIntegrationProvider } from '../shared';

export async function POST(req: NextRequest) {
  return reasonIntegrationProvider(req);
}
