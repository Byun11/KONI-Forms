/**
 * Options-page side of "load my installed Ollama models (vision-only)".
 *
 * The actual /api/tags + /api/show fetch runs in the background service worker
 * (see chrome-extension/src/background/services/ollama.ts), because a fetch from
 * this page would be subject to CORS and need OLLAMA_ORIGINS. The SW bypasses
 * CORS via host_permissions, so listing models "just works". Here we only send
 * the request and surface the result/error kind.
 */

export type OllamaErrorKind = 'cors' | 'unreachable' | 'generic';

/** Thrown when the background reports a failure; `kind` maps to a localized message. */
export class OllamaLoadError extends Error {
  kind: OllamaErrorKind;
  constructor(kind: OllamaErrorKind) {
    super(`Ollama load failed: ${kind}`);
    this.name = 'OllamaLoadError';
    this.kind = kind;
  }
}

/** Ask the background worker for the installed vision-capable Ollama models. */
export async function fetchOllamaVisionModels(baseUrl?: string, apiKey?: string): Promise<string[]> {
  let res: { models?: string[]; error?: OllamaErrorKind } | undefined;
  try {
    res = await chrome.runtime.sendMessage({ type: 'ollama_list_vision_models', baseUrl, apiKey });
  } catch {
    // The service worker was unavailable / the channel closed.
    throw new OllamaLoadError('generic');
  }
  if (res?.error) throw new OllamaLoadError(res.error);
  return res?.models ?? [];
}
