import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { createUploader, UploadError } from '../src/uploader';

interface Received {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

describe('uploader', () => {
  let server: http.Server;
  let baseUrl: string;
  let status = 200;
  let delayMs = 0;
  const received: Received[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(data) });
        setTimeout(() => {
          res.statusCode = status;
          res.end('{}');
        }, delayMs);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => server.close());

  const batch = {
    repo: { id: 'repo-1', remote: 'github.com/acme/app' },
    session: { id: 's1', source: 'claude-code', dir: '2026-01-01T00-00-00Z-s1', createdAt: '2026-01-01T00:00:00Z' },
    files: [{ name: 'meta.json', content: '{}' }],
  };

  it('posts the batch with auth and user agent', async () => {
    status = 200;
    const uploader = createUploader({ apiUrl: baseUrl, token: 'tok', version: '1.2.3' });
    await uploader.uploadSession(batch);
    const last = received[received.length - 1];
    expect(last.method).toBe('POST');
    expect(last.url).toBe('/v1/sessions/s1/files');
    expect(last.headers.authorization).toBe('Bearer tok');
    expect(last.headers['user-agent']).toBe('assert-cli/1.2.3');
    expect(last.body).toEqual(batch);
  });

  it('posts redactions to the session', async () => {
    status = 200;
    const uploader = createUploader({ apiUrl: baseUrl, token: 'tok', version: 'dev' });
    await uploader.uploadRedaction({ repo: batch.repo, session: batch.session, directive: { target: 'current-turn' } });
    expect(received[received.length - 1].url).toBe('/v1/sessions/s1/redactions');
  });

  it('reports non-2xx responses with their status', async () => {
    status = 503;
    const uploader = createUploader({ apiUrl: baseUrl, token: 'tok', version: 'dev' });
    await expect(uploader.uploadSession(batch)).rejects.toMatchObject({ name: 'UploadError', status: 503 });
  });

  it('times out slow servers', async () => {
    status = 200;
    delayMs = 500;
    const uploader = createUploader({ apiUrl: baseUrl, token: 'tok', version: 'dev', timeoutMs: 50 });
    const err = await uploader.uploadSession(batch).catch((e) => e);
    delayMs = 0;
    expect(err).toBeInstanceOf(UploadError);
    expect(err.message).toContain('timed out');
  });

  it('reports unreachable hosts', async () => {
    const uploader = createUploader({ apiUrl: 'http://127.0.0.1:1', token: 'tok', version: 'dev' });
    await expect(uploader.uploadSession(batch)).rejects.toBeInstanceOf(UploadError);
  });
});
