import { waitUntil } from '@vercel/functions';
import { healthReport } from '../src/health.js';
import { handleHttpRequest } from '../src/http.js';

// The Vercel function for the App's webhook URL (/api/webhook). A thin shim: all
// behavior is in src/ and tested there.

export function POST(request: Request): Promise<Response> {
  return handleHttpRequest(request, { env: process.env, waitUntil });
}

export function GET(): Response {
  return Response.json(healthReport());
}
