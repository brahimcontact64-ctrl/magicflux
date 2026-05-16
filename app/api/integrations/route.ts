import { NextRequest } from 'next/server';
import { disconnectIntegration, listIntegrations, saveIntegration } from './shared';

export async function GET(req: NextRequest) {
  return listIntegrations(req);
}

export async function POST(req: NextRequest) {
  return saveIntegration(req);
}

export async function DELETE(req: NextRequest) {
  return disconnectIntegration(req);
}
