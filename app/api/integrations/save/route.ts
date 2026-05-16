import { NextRequest } from 'next/server';
import { saveIntegration } from '../shared';

export async function POST(req: NextRequest) {
  return saveIntegration(req);
}
