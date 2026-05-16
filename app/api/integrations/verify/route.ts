import { NextRequest } from 'next/server';
import { verifyIntegration } from '../shared';

export async function POST(req: NextRequest) {
  return verifyIntegration(req);
}
