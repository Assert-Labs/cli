/**
 * HTTP client for publishing captured sessions to Assert. One request carries
 * every pending immutable file of one session (meta, per-turn, lifecycle), so
 * the server can store them under the same layout the local mirror uses.
 *
 * Failures are reported, never swallowed: the outbox decides what to retry.
 */

import type { RedactionDirective } from './sanitizer';

export interface UploadRepo {
  /** Assert's stable per-clone id (see repo-identity). */
  id: string;
  /** `host/owner/repo` from the origin remote, when the repo has one. */
  remote: string | null;
}

export interface UploadSession {
  id: string;
  source: string;
  /** The session's directory name in the mirror (`<time>-<id8>`). */
  dir: string;
  createdAt: string;
}

export interface SessionUploadBatch {
  repo: UploadRepo;
  session: UploadSession;
  files: Array<{ name: string; content: string }>;
}

export interface RedactionUpload {
  repo: UploadRepo;
  session: UploadSession;
  directive: RedactionDirective;
}

export interface Uploader {
  uploadSession(batch: SessionUploadBatch): Promise<void>;
  uploadRedaction(upload: RedactionUpload): Promise<void>;
}

export class UploadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

export interface UploaderOptions {
  apiUrl: string;
  /** Optional: uploads are keyed by repo and verified against the pull
   * request server-side; a token only adds a bearer header. */
  token?: string;
  /** CLI version, sent as the user agent. */
  version: string;
  /** Per-request timeout; hooks run on a budget. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function createUploader(options: UploaderOptions): Uploader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  async function post(route: string, body: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${options.apiUrl}${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `assert-cli/${options.version}`,
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const reason = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : (e as Error).message;
      throw new UploadError(`POST ${route} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new UploadError(`POST ${route} returned ${response.status}`, response.status);
    }
  }

  return {
    uploadSession(batch) {
      return post(`/v1/sessions/${encodeURIComponent(batch.session.id)}/files`, batch);
    },
    uploadRedaction(upload) {
      return post(`/v1/sessions/${encodeURIComponent(upload.session.id)}/redactions`, upload);
    },
  };
}
