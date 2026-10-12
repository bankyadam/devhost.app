import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
export function createCollectorServer(ingest: Ingestor, log: (msg: string) => void = () => undefined): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, '{"ok":true}');
      if (req.method !== 'POST') return reply(res, 405);

      const route = url.pathname;
      if (route !== '/v1/metrics' && route !== '/v1/logs' && route !== '/hooks') return reply(res, 404);
      if (!/json/i.test(req.headers['content-type'] ?? '')) {
        // protobuf is not supported; Claude Code is configured for http/json (A10.2).
        return reply(res, 415, '{"error":"only application/json is supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json"}');
      }
      let raw = await readBody(req);
      if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
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
