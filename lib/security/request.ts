import { DkpIntegrityError } from '../dkpAccounting.ts';

/** Safe, bounded parsing and same-origin checks for cookie-authenticated mutations. */
export class RequestValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RequestValidationError';
    this.status = status;
  }
}

export function guardMutationRequest(request: Request): Response | null {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  let expected: string;
  try { expected = new URL(process.env.APP_ORIGIN || request.url).origin; }
  catch { return Response.json({ error: 'The application origin is not configured correctly.' }, { status: 503 }); }
  // Sibling subdomains are untrusted too. Configure APP_ORIGIN behind proxies
  // instead of trusting arbitrary forwarded-host headers.
  if ((origin && origin !== expected) || (!origin && fetchSite !== 'same-origin')) {
    return Response.json({ error: 'This request must come from this website.' }, { status: 403 });
  }
  return null;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new RequestValidationError('The request is too large.', 413);
  }
  if (!request.body) throw new RequestValidationError('A request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RequestValidationError('The request is too large.', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export async function readJsonObject(request: Request, options: { maxBytes?: number } = {}): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestValidationError('Send a JSON request.', 415);
  const bytes = await readBoundedBody(request, options.maxBytes ?? 32 * 1024);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RequestValidationError('The request contains invalid JSON.'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RequestValidationError('Send a JSON object.');
  return value as Record<string, unknown>;
}

export async function readFormDataLimited(request: Request, maxBytes = 3 * 1024 * 1024): Promise<FormData> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
    throw new RequestValidationError('Send a multipart form.', 415);
  }
  const bytes = await readBoundedBody(request, maxBytes);
  try {
    return await new Response(bytes.buffer as ArrayBuffer, {
      headers: { 'content-type': request.headers.get('content-type')! },
    }).formData();
  } catch { throw new RequestValidationError('The uploaded form could not be read.'); }
}

export function requestErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof DkpIntegrityError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof RequestValidationError) return Response.json({ error: error.message }, { status: error.status });
  // Never log request bodies, credentials, database URLs or provider responses.
  console.error(fallback, error instanceof Error ? error.name : 'UnknownError');
  return Response.json({ error: fallback }, { status: 500 });
}
