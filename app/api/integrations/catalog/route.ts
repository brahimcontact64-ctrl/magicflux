import { NextRequest } from 'next/server';
import { getIntegrationCatalog } from '../shared';

export async function GET(req: NextRequest) {
  return getIntegrationCatalog(req);
}
