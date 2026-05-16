import { NextRequest } from 'next/server';
import { runIntegrationAction } from '../shared';

export async function POST(req: NextRequest) {
  return runIntegrationAction(req);
}
