/**
 * Discover which models a local Ollama server has installed, filtered to the
 * vision-capable ones (KONI's browser agent needs to see images). Ollama reports
 * this via POST /api/show, whose `capabilities` array contains 'vision'.
 *
 * This runs in the background service worker on purpose: SW fetches to
 * host_permissions hosts (<all_urls> covers http://localhost:11434) bypass
 * browser CORS, so the user does NOT need to set OLLAMA_ORIGINS just to list
 * models — the same reason inference (ChatOllama) already works from here. The
 * options page asks for this over chrome.runtime messaging instead of fetching
 * itself (a page fetch would be subject to CORS).
 */

const DEFAULT_BASE_URL = 'http://localhost:11434';

/** Thrown when Ollama answers with a non-OK HTTP status. */
export class OllamaApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OllamaApiError';
    this.status = status;
  }
}

export type OllamaErrorKind = 'cors' | 'unreachable' | 'generic';

/** Collapse a thrown error into a stable kind the UI can map to a localized message. */
export function classifyOllamaError(err: unknown): OllamaErrorKind {
  if (err instanceof OllamaApiError && err.status === 403) return 'cors';
  if (err instanceof TypeError) return 'unreachable'; // fetch "Failed to fetch" — server down
  return 'generic';
}

interface OllamaTagsResponse {
  models?: Array<{ name: string; model?: string }>;
}

interface OllamaShowResponse {
  capabilities?: string[];
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Ollama ignores the key locally; a bearer only matters behind a reverse proxy.
  // Don't send the built-in placeholder ('ollama') as if it were a real token.
  if (apiKey && apiKey !== 'ollama') headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * List the vision-capable models installed on an Ollama server.
 *
 * @throws {OllamaApiError} when /api/tags returns a non-OK status.
 * @throws {TypeError} native "Failed to fetch" when the server is unreachable.
 */
export async function fetchOllamaVisionModels(baseUrl?: string, apiKey?: string): Promise<string[]> {
  const root = normalizeBaseUrl(baseUrl);
  const headers = buildHeaders(apiKey);

  const tagsRes = await fetch(`${root}/api/tags`, { headers });
  if (!tagsRes.ok) throw new OllamaApiError(tagsRes.status, `Ollama /api/tags returned ${tagsRes.status}`);
  const tags = (await tagsRes.json()) as OllamaTagsResponse;
  const names = (tags.models ?? []).map(m => m.name).filter(Boolean);

  // Ask each model for its capabilities; keep only those that can see images.
  // A failed /api/show for one model is skipped rather than failing the whole load.
  const checked = await Promise.all(
    names.map(async name => {
      try {
        const showRes = await fetch(`${root}/api/show`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ name }),
        });
        if (!showRes.ok) return null;
        const show = (await showRes.json()) as OllamaShowResponse;
        return show.capabilities?.includes('vision') ? name : null;
      } catch {
        return null;
      }
    }),
  );

  return [...new Set(checked.filter((n): n is string => n !== null))];
}
