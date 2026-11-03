import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { Ingestor } from './ingest.js';

const MAX_BODY = 8 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, body = ''): void {
  res.writeHead(status, body ? { 'Content-Type': 'application/json' } : {});
  res.end(body);
}

/**
 * OTLP/HTTP (JSON only) and Claude Code hook receiver. Bind address is always
 * 127.0.0.1: remote access is via SSH only (spec A10).
 */
export interface ServerOptions {
  /**
   * Per-install bearer token for /v1/* and /hooks: `Authorization: Bearer <token>` (OTLP:
   * OTEL_EXPORTER_OTLP_HEADERS) or `?token=` (hook URL). Not enforced when unset.
   */
  token?: string;
}

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createCollectorServer(ingest: Ingestor, log: (msg: string) => void = () => undefined, opts: ServerOptions = {}): Server {
  return createServer((req, res) => {
    void (async () => {
      // A browser page can reach 127.0.0.1 (CSRF, DNS rebinding): refuse anything that is not a plain local client.
      if (req.headers['origin'] !== undefined) return reply(res, 403, '{"error":"browser requests are not accepted"}');
      if (req.headers['host'] !== `127.0.0.1:${req.socket.localPort ?? 0}`) return reply(res, 403, '{"error":"unexpected Host"}');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, '{"ok":true}');
      if (req.method !== 'POST') return reply(res, 405);

      const route = url.pathname;
      if (route !== '/v1/metrics' && route !== '/v1/logs' && route !== '/hooks') return reply(res, 404);
      if (opts.token !== undefined) {
        const given = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '')?.[1] ?? url.searchParams.get('token') ?? '';
        if (!sameToken(given, opts.token)) return reply(res, 401, '{"error":"missing or wrong token"}');
      }
      if ((req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') {
        // protobuf is not supported; Claude Code is configured for http/json (A10.2).
        return reply(res, 415, '{"error":"only application/json is supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json"}');
      }
      let raw = await readBody(req);
      if (req.headers['content-encoding'] === 'gzip') {
        try {
          raw = gunzipSync(raw, { maxOutputLength: MAX_BODY });
        } catch (err) {
          return reply(res, /maxOutputLength|larger than/i.test((err as Error).message) ? 413 : 400, '{"error":"bad or too large gzip body"}');
        }
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return reply(res, 400, '{"error":"invalid JSON"}');
      }

      if (route === '/hooks') {
        ingest.hook(body, url.searchParams.get('account') ?? '');
        return reply(res, 200);
      }
      if (route === '/v1/metrics') ingest.metrics(body);
      else ingest.logs(body);
      return reply(res, 200, '{"partialSuccess":{}}');
    })().catch((err: Error) => {
      log(`request failed: ${err.message}`);
      if (!res.headersSent) reply(res, 500);
    });
  });
}

export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}
