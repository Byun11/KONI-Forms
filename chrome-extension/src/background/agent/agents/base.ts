import type { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOllama } from '@langchain/ollama';
import type { AgentContext, AgentOutput } from '../types';
import type { BasePrompt } from '../prompts/base';
import type { BaseMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type { Action } from '../actions/builder';
import { convertInputMessages, extractJsonFromModelOutput, removeThinkTags } from '../messages/utils';
import { isAbortedError, ResponseParseError } from './errors';
import { ProviderTypeEnum } from '@extension/storage';
import { convertZodToJsonSchema } from '@src/background/utils';

/**
 * Extract the JSON object that ends a mixed text blob. With Ollama's native
 * `format` (constrained decoding) the real answer is always the TAIL of the
 * content, but @langchain/ollama merges the model's thinking stream into
 * `content` in front of it, so plain JSON.parse fails. Try the whole string
 * first, then every '{' onward — the first slice that parses to the end wins.
 */
function extractTailJson(text: string): unknown | undefined {
  const s = text.trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through to tail scan
  }
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    try {
      return JSON.parse(s.slice(i));
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

const logger = createLogger('agent');

/**
 * Rewrites a converted Zod schema into the subset Claude's structured output
 * accepts. The validator takes a small vocabulary and rejects the whole schema
 * on the first keyword outside it — `nullable`, `default`, `minimum` and the
 * rest of Zod's constraints all fail — so this keeps what describes the shape
 * and drops what only describes constraints, and marks every object closed,
 * which the validator requires.
 */
const SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'description',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
  '$ref',
  '$defs',
  'definitions',
]);

function sealObjects<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map(sealObjects) as unknown as T;
  }
  if (node && typeof node === 'object') {
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      // Property names live in a map and are not keywords, so the filter only
      // applies to the schema level itself.
      if (!SCHEMA_KEYS.has(k)) continue;
      out[k] = k === 'properties' || k === '$defs' || k === 'definitions' ? mapValues(v) : sealObjects(v);
    }
    if (out.type === 'object' && out.additionalProperties === undefined) {
      out.additionalProperties = false;
    }
    return out as unknown as T;
  }
  return node;
}

/** Recurse into the values of a name-to-schema map without filtering its keys. */
function mapValues(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = sealObjects(v);
  }
  return out;
}

// cumulative per-model token usage in chrome.storage.local['llm-usage'] —
// external cost accounting reads it after a run; must never break the agent
async function addLlmUsage(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  agent: string,
): Promise<void> {
  try {
    const key = 'llm-usage';
    const store = await chrome.storage.local.get(key);
    type Usage = {
      calls: number;
      prompt: number;
      completion: number;
      cached: number;
      perCall?: { agent: string; prompt: number; cached: number }[];
    };
    const cur: Record<string, Usage> = store[key] ?? {};
    const rec: Usage = cur[model] ?? { calls: 0, prompt: 0, completion: 0, cached: 0, perCall: [] };
    rec.calls += 1;
    rec.prompt += promptTokens;
    rec.completion += completionTokens;
    // cached prompt tokens bill at a tenth; without this the cost is an upper bound
    rec.cached = (rec.cached ?? 0) + cachedTokens;
    // Per-call trace. Totals cannot tell a prompt that grows every step from one
    // that repeats, nor a cache that never warms from one that keeps resetting —
    // both are answered by the shape of this series, not its sum.
    rec.perCall = [...(rec.perCall ?? []), { agent, prompt: promptTokens, cached: cachedTokens }];
    cur[model] = rec;
    await chrome.storage.local.set({ [key]: cur });
  } catch {
    // accounting only
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallOptions = Record<string, any>;

// Update options to use Zod schema
export interface BaseAgentOptions {
  chatLLM: BaseChatModel;
  context: AgentContext;
  prompt: BasePrompt;
  provider?: string;
}
export interface ExtraAgentOptions {
  id?: string;
  toolCallingMethod?: string;
  callOptions?: CallOptions;
}

/**
 * Base class for all agents
 * @param T - The Zod schema for the model output
 * @param M - The type of the result field of the agent output
 */
export abstract class BaseAgent<T extends z.ZodType, M = unknown> {
  protected id: string;
  protected chatLLM: BaseChatModel;
  protected prompt: BasePrompt;
  protected context: AgentContext;
  protected actions: Record<string, Action> = {};
  protected modelOutputSchema: T;
  protected toolCallingMethod: string | null;
  protected chatModelLibrary: string;
  protected modelName: string;
  protected provider: string;
  protected withStructuredOutput: boolean;
  /** Cached JSON Schema for the Claude 5 output_config path (see invoke). */
  private claudeJsonSchema?: Record<string, unknown>;
  protected callOptions?: CallOptions;
  protected modelOutputToolName: string;
  declare ModelOutput: z.infer<T>;

  constructor(modelOutputSchema: T, options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    // base options
    this.modelOutputSchema = modelOutputSchema;
    this.chatLLM = options.chatLLM;
    this.prompt = options.prompt;
    this.context = options.context;
    this.provider = options.provider || '';
    // TODO: fix this, the name is not correct in production environment
    this.chatModelLibrary = this.chatLLM.constructor.name;
    this.modelName = this.getModelName();
    this.withStructuredOutput = this.setWithStructuredOutput();
    // extra options
    this.id = extraOptions?.id || 'agent';
    this.toolCallingMethod = this.setToolCallingMethod(extraOptions?.toolCallingMethod);
    // token-usage callback rides every invoke via callOptions spread
    const usageCallback = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleLLMEnd: (output: any) => {
        // Two shapes carry usage and only one of them carries the cache split:
        // llmOutput.tokenUsage is totals only, usage_metadata has the details.
        // Reading them separately — an earlier `??` took tokenUsage and never
        // looked at the details, so every run reported a 0% cache hit.
        const totals = output?.llmOutput?.tokenUsage;
        const meta = output?.generations?.[0]?.[0]?.message?.usage_metadata;
        const u = totals ?? meta;
        if (u) {
          void addLlmUsage(
            this.modelName,
            // Anthropic splits input three ways and `input_tokens` is only the
            // part after the last cache breakpoint — reading it alone made a
            // 15k-token call look like 4 tokens.
            (u.promptTokens ?? u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? u.input_token_details?.cache_read ?? 0) +
              (u.cache_creation_input_tokens ?? u.input_token_details?.cache_creation ?? 0),
            u.completionTokens ?? u.output_tokens ?? 0,
            meta?.input_token_details?.cache_read ??
              totals?.promptTokensDetails?.cachedTokens ??
              totals?.cache_read_input_tokens ??
              0,
            this.id,
          );
        }
      },
    };
    this.callOptions = {
      ...(extraOptions?.callOptions ?? {}),
      callbacks: [...(extraOptions?.callOptions?.callbacks ?? []), usageCallback],
    };
    this.modelOutputToolName = `${this.id}_output`;
  }

  // Set the model name
  private getModelName(): string {
    if ('modelName' in this.chatLLM) {
      return this.chatLLM.modelName as string;
    }
    if ('model_name' in this.chatLLM) {
      return this.chatLLM.model_name as string;
    }
    if ('model' in this.chatLLM) {
      return this.chatLLM.model as string;
    }
    return 'Unknown';
  }

  // Set the tool calling method
  private setToolCallingMethod(toolCallingMethod?: string): string | null {
    if (toolCallingMethod === 'auto') {
      switch (this.chatModelLibrary) {
        case 'ChatGoogleGenerativeAI':
          return null;
        case 'ChatOpenAI':
        case 'AzureChatOpenAI':
        case 'ChatGroq':
        case 'ChatXAI':
          return 'function_calling';
        default:
          return null;
      }
    }
    return toolCallingMethod || null;
  }

  // Check if model is a Llama model (only for Llama-specific handling)
  private isLlamaModel(modelName: string): boolean {
    return modelName.includes('Llama-4') || modelName.includes('Llama-3.3') || modelName.includes('llama-3.3');
  }

  // Set whether to use structured output based on the model name
  private setWithStructuredOutput(): boolean {
    if (this.modelName === 'deepseek-reasoner' || this.modelName === 'deepseek-r1') {
      return false;
    }

    // Only the 5.1 line dropped forced tool_choice, which is how the
    // structured-output wrapper pins the answer to one tool; Fable 5, Opus 5
    // and the rest still accept it. Turning it off for the whole family would
    // have run every Claude on a weaker contract than the other providers get.
    if (/^claude-(fable|mythos)-5-1/.test(this.modelName)) {
      return false;
    }

    // Llama API models don't support json_schema response format
    if (this.provider === ProviderTypeEnum.Llama || this.isLlamaModel(this.modelName)) {
      logger.debug(`[${this.modelName}] Llama API doesn't support structured output, using manual JSON extraction`);
      return false;
    }

    return true;
  }

  // Lazily-built JSON schema for Ollama's native structured outputs.
  private ollamaFormatSchema?: Record<string, unknown>;

  /**
   * Ollama-native structured output. LangChain's withStructuredOutput is broken
   * for ChatOllama (it binds a tool named "extract" whose call never reaches
   * `parsed`, and weak local models violate the schema anyway). Ollama's own
   * `format` parameter does constrained decoding server-side — even small
   * models physically cannot emit a string where the schema says boolean.
   * Returns undefined when the response can't be recovered, so callers can
   * fall back to the generic path.
   */
  protected async invokeOllamaStructured(inputMessages: BaseMessage[]): Promise<this['ModelOutput'] | undefined> {
    this.ollamaFormatSchema ??= convertZodToJsonSchema(this.modelOutputSchema, this.modelOutputToolName, true);
    const response = await this.chatLLM.invoke(inputMessages, {
      signal: this.context.controller.signal,
      ...this.callOptions,
      // ChatOllamaCallOptions.format — typed loosely because BaseChatModel's
      // call options don't know about it.
      format: this.ollamaFormatSchema,
    } as Parameters<BaseChatModel['invoke']>[1]);

    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const extracted = extractTailJson(removeThinkTags(content));
    if (extracted === undefined) {
      logger.warning(`[${this.modelName}] Ollama format response had no parsable JSON tail`);
      return undefined;
    }
    try {
      const validated = this.modelOutputSchema.safeParse(extracted);
      if (validated.success) return validated.data;
      logger.warning(`[${this.modelName}] Ollama format JSON failed schema validation`, validated.error.issues);
    } catch (error) {
      // Some schemas contain throwing transforms; treat as validation failure.
      logger.warning(`[${this.modelName}] Ollama format JSON validation threw`, error);
    }
    return undefined;
  }

  async invoke(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    // Ollama first: use native constrained decoding instead of the broken
    // LangChain tool-calling path. Fall through to the generic path on failure.
    if (this.chatLLM instanceof ChatOllama) {
      try {
        const result = await this.invokeOllamaStructured(inputMessages);
        if (result !== undefined) return result;
      } catch (error) {
        if (isAbortedError(error)) throw error;
        logger.warning(`[${this.modelName}] Ollama structured invoke failed, falling back`, error);
      }
    }

    // Use structured output
    if (this.withStructuredOutput) {
      logger.debug(`[${this.modelName}] Preparing structured output call with schema:`, {
        schemaName: this.modelOutputToolName,
        messageCount: inputMessages.length,
        modelProvider: this.provider,
      });

      const structuredLlm = this.chatLLM.withStructuredOutput(this.modelOutputSchema, {
        includeRaw: true,
        name: this.modelOutputToolName,
      });

      let response = undefined;
      try {
        logger.debug(`[${this.modelName}] Invoking LLM with structured output...`);
        response = await structuredLlm.invoke(inputMessages, {
          signal: this.context.controller.signal,
          ...this.callOptions,
        });

        logger.debug(`[${this.modelName}] LLM response received:`, {
          hasParsed: !!response.parsed,
          hasRaw: !!response.raw,
          rawContent: response.raw?.content?.slice(0, 500) + (response.raw?.content?.length > 500 ? '...' : ''),
        });

        if (response.parsed) {
          logger.debug(`[${this.modelName}] Successfully parsed structured output`);
          return response.parsed;
        }
        // Some providers — notably ChatOllama via LangChain — return the structured
        // result as a tool call but leave `parsed` empty (the tool name the model
        // emits doesn't match what the parser expects). The data is correct, so
        // recover it from the raw tool-call args and validate against our schema.
        const rawMsg = response.raw as unknown as
          | { tool_calls?: Array<{ args?: unknown }>; content?: unknown }
          | undefined;
        const toolArgs = rawMsg?.tool_calls?.[0]?.args;
        if (toolArgs) {
          const recovered = this.modelOutputSchema.safeParse(toolArgs);
          if (recovered.success) {
            logger.debug(`[${this.modelName}] Recovered structured output from tool call`);
            return recovered.data;
          }
        }
        // Last resort: pull JSON out of the raw text (also strips <think> blocks).
        if (typeof rawMsg?.content === 'string') {
          const manual = this.manuallyParseResponse(rawMsg.content);
          if (manual) return manual;
        }
        logger.error('Failed to parse response', response);
        throw new Error('Could not parse response with structured output');
      } catch (error) {
        if (isAbortedError(error)) {
          throw error;
        }

        // Recover from whatever raw text is reachable — the response's raw
        // content (includeRaw) or LangChain's OutputParserException.llmOutput.
        // Do NOT sniff the error message: V8 phrases trailing-garbage failures
        // as "Unexpected non-whitespace character after JSON" (seen live with
        // gpt-5.5), which the old 'is not valid JSON' check silently missed.
        const errorMessage = error instanceof Error ? error.message : String(error);
        const llmOutput = (error as { llmOutput?: unknown } | null)?.llmOutput;
        const rawText =
          response?.raw?.content && typeof response.raw.content === 'string'
            ? response.raw.content
            : typeof llmOutput === 'string'
              ? llmOutput
              : undefined;
        if (rawText) {
          const parsed = this.manuallyParseResponse(rawText);
          if (parsed) {
            return parsed;
          }
        }
        logger.error(`[${this.modelName}] LLM call failed with error: \n${errorMessage}`);
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }
    }

    // Fallback: Without structured output support, need to extract JSON from model output manually
    logger.debug(`[${this.modelName}] Using manual JSON extraction fallback method`);
    const convertedInputMessages = convertInputMessages(inputMessages, this.modelName);

    try {
      // Claude 5 refuses a forced tool_choice, which was the only thing holding
      // the answer to a schema. Its own replacement is output_config.format,
      // which the client has no field for — so it goes on the instance right
      // before the call, and per call rather than per model, because the
      // planner and the navigator can share one instance and each needs its
      // own schema.
      if (/^claude-(fable|mythos)-5-1/.test(this.modelName)) {
        this.claudeJsonSchema ??= sealObjects(
          convertZodToJsonSchema(this.modelOutputSchema, this.modelOutputToolName, true) as Record<string, unknown>,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const llm = this.chatLLM as any;
        llm.invocationKwargs = {
          ...(llm.invocationKwargs ?? {}),
          output_config: { format: { type: 'json_schema', schema: this.claudeJsonSchema } },
        };
      }
      const response = await this.chatLLM.invoke(convertedInputMessages, {
        signal: this.context.controller.signal,
        ...this.callOptions,
      });

      // A thinking model answers with a list of blocks, not a string: the
      // reasoning comes first and the answer is one text block after it.
      // Reading only the string case threw away every Claude response before
      // it reached the parser.
      const text = Array.isArray(response.content)
        ? response.content
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? (b.text ?? '') : ''))
            .join(' ')
        : response.content;
      if (typeof text === 'string' && text.length > 0) {
        const parsed = this.manuallyParseResponse(text);
        if (parsed) {
          return parsed;
        }
        logger.warning(
          `[${this.modelName}] no JSON in reply: ${JSON.stringify(text.slice(0, 200))} blocks=${JSON.stringify(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (Array.isArray(response.content) ? response.content : []).map((b: any) => ({
              type: b?.type,
              keys: Object.keys(b ?? {}),
            })),
          ).slice(0, 400)}`,
        );
      }
    } catch (error) {
      logger.error(`[${this.modelName}] LLM call failed in manual extraction mode:`, error);
      throw error;
    }
    const errorMessage = `Failed to parse response from ${this.modelName}`;
    logger.error(errorMessage);
    throw new ResponseParseError('Could not parse response');
  }

  // Execute the agent and return the result
  abstract execute(): Promise<AgentOutput<M>>;

  // Helper method to validate metadata
  protected validateModelOutput(data: unknown): this['ModelOutput'] | undefined {
    if (!this.modelOutputSchema || !data) return undefined;
    try {
      return this.modelOutputSchema.parse(data);
    } catch (error) {
      logger.error('validateModelOutput', error);
      throw new ResponseParseError('Could not validate model output');
    }
  }

  // Helper method to manually parse the response content
  protected manuallyParseResponse(content: string): this['ModelOutput'] | undefined {
    const cleanedContent = removeThinkTags(content);
    try {
      const extractedJson = extractJsonFromModelOutput(cleanedContent);
      return this.validateModelOutput(extractedJson);
    } catch (error) {
      logger.warning('manuallyParseResponse failed', error);
      return undefined;
    }
  }
}
