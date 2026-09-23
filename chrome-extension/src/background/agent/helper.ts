import { type ProviderConfig, type ModelConfig, ProviderTypeEnum } from '@extension/storage';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatXAI } from '@langchain/xai';
import { ChatGroq } from '@langchain/groq';
import { ChatCerebras } from '@langchain/cerebras';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOllama } from '@langchain/ollama';
import { ChatDeepSeek } from '@langchain/deepseek';
import { MODEL_CONTEXT_TOKENS } from './types';

// Older builds stored 'minimal' here, and one build stored the literal string
// 'minimal/none'. Newer gpt-5.x models reject both, so anything that is not
// medium or high is sent as low.
function normalizeReasoningEffort(effort: string): 'low' | 'medium' | 'high' {
  return effort === 'medium' || effort === 'high' ? effort : 'low';
}

const maxTokens = 1024 * 4;

// Custom ChatLlama class to handle Llama API response format
class ChatLlama extends ChatOpenAI {
  constructor(args: any) {
    super(args);
  }

  // Override the completionWithRetry method to intercept and transform the response
  async completionWithRetry(request: any, options?: any): Promise<any> {
    try {
      // Make the request using the parent's implementation
      const response = await super.completionWithRetry(request, options);

      // Check if this is a Llama API response format
      if (response?.completion_message?.content?.text) {
        // Transform Llama API response to OpenAI format
        const transformedResponse = {
          id: response.id || 'llama-response',
          object: 'chat.completion',
          created: Date.now(),
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: response.completion_message.content.text,
              },
              finish_reason: response.completion_message.stop_reason || 'stop',
            },
          ],
          usage: {
            prompt_tokens: response.metrics?.find((m: any) => m.metric === 'num_prompt_tokens')?.value || 0,
            completion_tokens: response.metrics?.find((m: any) => m.metric === 'num_completion_tokens')?.value || 0,
            total_tokens: response.metrics?.find((m: any) => m.metric === 'num_total_tokens')?.value || 0,
          },
        };

        return transformedResponse;
      }

      return response;
    } catch (error: any) {
      console.error(`[ChatLlama] Error during API call:`, error);
      throw error;
    }
  }
}

// O series models or GPT-5 models that support reasoning
function isOpenAIReasoningModel(modelName: string): boolean {
  let modelNameWithoutProvider = modelName;
  if (modelName.startsWith('openai/')) {
    modelNameWithoutProvider = modelName.substring(7);
  }
  return (
    modelNameWithoutProvider.startsWith('o') ||
    (modelNameWithoutProvider.startsWith('gpt-5') && !modelNameWithoutProvider.startsWith('gpt-5-chat'))
  );
}

// Function to check if a model is an Anthropic Opus model
function isAnthropicOpusModel(modelName: string): boolean {
  // Extract the model name without provider prefix if present
  let modelNameWithoutProvider = modelName;
  if (modelName.startsWith('anthropic/')) {
    modelNameWithoutProvider = modelName.substring(10);
  }
  return modelNameWithoutProvider.startsWith('claude-opus');
}

// check if a model is sonnet-4-5 or haiku-4-5
function isAnthropic4_5Model(modelName: string): boolean {
  let modelNameWithoutProvider = modelName;
  if (modelName.startsWith('anthropic/')) {
    modelNameWithoutProvider = modelName.substring(10);
  }
  return (
    modelNameWithoutProvider.startsWith('claude-sonnet-4-5') || modelNameWithoutProvider.startsWith('claude-haiku-4-5')
  );
}

function createOpenAIChatModel(
  providerConfig: ProviderConfig,
  modelConfig: ModelConfig,
  // Add optional extra fetch options for headers etc.
  extraFetchOptions: { headers?: Record<string, string> } | undefined,
): BaseChatModel {
  const args: {
    model: string;
    apiKey?: string;
    // Configuration should align with ClientOptions from @langchain/openai
    configuration?: Record<string, unknown>;
    modelKwargs?: {
      max_completion_tokens: number;
      reasoning_effort?: 'low' | 'medium' | 'high';
      prompt_cache_key?: string;
    };
    topP?: number;
    temperature?: number;
    maxTokens?: number;
  } = {
    model: modelConfig.modelName,
    apiKey: providerConfig.apiKey,
  };

  const configuration: Record<string, unknown> = {};
  if (providerConfig.baseUrl) {
    configuration.baseURL = providerConfig.baseUrl;
  }
  if (extraFetchOptions?.headers) {
    configuration.defaultHeaders = extraFetchOptions.headers;
  }
  args.configuration = configuration;

  // custom provider may have no api key
  if (providerConfig.apiKey) {
    args.apiKey = providerConfig.apiKey;
  }

  // O series models have different parameters
  if (isOpenAIReasoningModel(modelConfig.modelName)) {
    args.modelKwargs = {
      max_completion_tokens: maxTokens,
      // Every call in a run repeats the same tool schema and system prompt, so
      // they all want the same cache. The key only influences which machine a
      // request lands on — it cannot force a hit — but without it the routing
      // is free to scatter requests that share a prefix, and a measured 1.8%
      // hit rate is what scattering looks like.
      prompt_cache_key: 'koni',
    };

    // Add reasoning_effort parameter for o-series models if specified
    if (modelConfig.reasoningEffort) {
      args.modelKwargs.reasoning_effort = normalizeReasoningEffort(modelConfig.reasoningEffort);
    }
  } else {
    args.topP = (modelConfig.parameters?.topP ?? 0.1) as number;
    args.temperature = (modelConfig.parameters?.temperature ?? 0.1) as number;
    args.maxTokens = maxTokens;
  }
  return new ChatOpenAI(args);
}

// Function to extract instance name from Azure endpoint URL
function extractInstanceNameFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    const hostnameParts = parsedUrl.hostname.split('.');
    // Expecting format like instance-name.openai.azure.com
    if (hostnameParts.length >= 4 && hostnameParts[1] === 'openai' && hostnameParts[2] === 'azure') {
      return hostnameParts[0];
    }
  } catch (e) {
    console.error('Error parsing Azure endpoint URL:', e);
  }
  return null;
}

// Function to check if a provider ID is an Azure provider
function isAzureProvider(providerId: string): boolean {
  return providerId === ProviderTypeEnum.AzureOpenAI || providerId.startsWith(`${ProviderTypeEnum.AzureOpenAI}_`);
}

// Function to create an Azure OpenAI chat model
function createAzureChatModel(providerConfig: ProviderConfig, modelConfig: ModelConfig): BaseChatModel {
  const temperature = (modelConfig.parameters?.temperature ?? 0.1) as number;
  const topP = (modelConfig.parameters?.topP ?? 0.1) as number;

  // Validate necessary fields first
  if (
    !providerConfig.baseUrl ||
    !providerConfig.azureDeploymentNames ||
    providerConfig.azureDeploymentNames.length === 0 ||
    !providerConfig.azureApiVersion ||
    !providerConfig.apiKey
  ) {
    throw new Error(
      'Azure configuration is incomplete. Endpoint, Deployment Name, API Version, and API Key are required. Please check settings.',
    );
  }

  // Instead of always using the first deployment name, use the model name from modelConfig
  // which contains the actual model selected in the UI
  const deploymentName = modelConfig.modelName;

  // Validate that the selected model exists in the configured deployments
  if (!providerConfig.azureDeploymentNames.includes(deploymentName)) {
    console.warn(
      `[createChatModel] Selected deployment "${deploymentName}" not found in available deployments. ` +
        `Available: ${JSON.stringify(providerConfig.azureDeploymentNames)}. Using the model anyway.`,
    );
  }

  // Extract instance name from the endpoint URL
  const instanceName = extractInstanceNameFromUrl(providerConfig.baseUrl);
  if (!instanceName) {
    throw new Error(
      `Could not extract Instance Name from Azure Endpoint URL: ${providerConfig.baseUrl}. Expected format like https://<your-instance-name>.openai.azure.com/`,
    );
  }

  // Check if the Azure deployment is using an "o" series model (GPT-4o, etc.)
  const isOSeriesModel = isOpenAIReasoningModel(deploymentName);

  // Use AzureChatOpenAI with specific parameters
  const args = {
    azureOpenAIApiInstanceName: instanceName, // Derived from endpoint
    azureOpenAIApiDeploymentName: deploymentName,
    azureOpenAIApiKey: providerConfig.apiKey,
    azureOpenAIApiVersion: providerConfig.azureApiVersion,
    // For Azure, the model name should be the deployment name itself
    model: deploymentName, // Set model = deployment name to fix Azure requests
    // For O series models, use modelKwargs instead of temperature/topP
    ...(isOSeriesModel
      ? {
          modelKwargs: {
            max_completion_tokens: maxTokens,
            // Add reasoning_effort parameter for Azure o-series models if specified
            ...(modelConfig.reasoningEffort
              ? { reasoning_effort: normalizeReasoningEffort(modelConfig.reasoningEffort) }
              : {}),
          },
        }
      : {
          temperature,
          topP,
          maxTokens,
        }),
    // DO NOT pass baseUrl or configuration here
  };
  // console.log('[createChatModel] Azure args passed to AzureChatOpenAI:', args);
  return new AzureChatOpenAI(args);
}

// create a chat model based on the agent name, the model name and provider
export function createChatModel(providerConfig: ProviderConfig, modelConfig: ModelConfig): BaseChatModel {
  const temperature = (modelConfig.parameters?.temperature ?? 0.1) as number;
  const topP = (modelConfig.parameters?.topP ?? 0.1) as number;

  // Check if the provider is an Azure provider with a custom ID (e.g. azure_openai_2)
  const isAzure = isAzureProvider(modelConfig.provider);

  // If this is any type of Azure provider, handle it with the dedicated function
  if (isAzure) {
    return createAzureChatModel(providerConfig, modelConfig);
  }

  switch (modelConfig.provider) {
    case ProviderTypeEnum.OpenAI: {
      // Call helper without extra options
      return createOpenAIChatModel(providerConfig, modelConfig, undefined);
    }
    case ProviderTypeEnum.Anthropic: {
      // For Opus models, only support temperature, not topP
      // For 4.5 models, only support either temperature or topP, not both, so we only use temperature to align with Opus
      //
      // The Claude 5 family takes neither of the older thinking settings: the
      // client sends `{type: 'disabled'}` when none is configured and the API
      // rejects it, and `{type: 'enabled', budget_tokens}` is rejected too.
      // These models think adaptively and want to be told so. Thinking also
      // pins temperature at 1, so it is left unset for them.
      const thinks = /^claude-(fable|opus|sonnet|haiku)-5/.test(modelConfig.modelName);
      const args: Record<string, unknown> = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        // max_tokens has to cover the thinking tokens as well as the answer
        maxTokens: thinks ? maxTokens * 2 : maxTokens,
        clientOptions: {},
      };
      if (thinks) {
        // Adaptive thinking is always on for this family and needs no config,
        // but display defaults to 'omitted', which returns the narration as a
        // thinking block and leaves the text block empty — the reply parsed as
        // one space. 'summarized' puts readable text back in the answer.
        args.thinking = { type: 'adaptive', display: 'summarized' };
        // top_p is deprecated on these models and the client sends whatever it
        // holds, so it has to be removed rather than adjusted. null is the
        // client's own way of spelling "unset" (it stores undefined, and the
        // key then drops out of the request body); temperature goes the same
        // way, since thinking pins it at 1 regardless.
        // Automatic prompt caching: one top-level field and the API keeps the
        // breakpoint on the last cacheable block, moving it forward as the
        // history grows — which is exactly the shape of an agent run, where
        // every step appends and nothing before it changes. A cache read on
        // this model bills at a fortieth of base input, so on a 40-call run
        // this is the difference between most of the cost and little of it.
        // invocationKwargs is spread over the request last, which is the only
        // place these two can be removed: the client always emits top_p and
        // temperature from its own defaults, and this model rejects both when
        // thinking is on. Undefined keys drop out when the body is serialized.
        args.invocationKwargs = {
          cache_control: { type: 'ephemeral' },
          top_p: undefined,
          temperature: undefined,
        };
      } else {
        args.temperature = temperature;
      }
      return new ChatAnthropic(args as ConstructorParameters<typeof ChatAnthropic>[0]);
    }
    case ProviderTypeEnum.DeepSeek: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
      };
      return new ChatDeepSeek(args) as BaseChatModel;
    }
    case ProviderTypeEnum.Gemini: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
      };
      return new ChatGoogleGenerativeAI(args);
    }
    case ProviderTypeEnum.Grok: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
        maxTokens,
        configuration: {},
      };
      return new ChatXAI(args) as BaseChatModel;
    }
    case ProviderTypeEnum.Groq: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
        maxTokens,
      };
      return new ChatGroq(args);
    }
    case ProviderTypeEnum.Cerebras: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
        maxTokens,
      };
      return new ChatCerebras(args);
    }
    case ProviderTypeEnum.Ollama: {
      const args: {
        model: string;
        apiKey?: string;
        baseUrl: string;
        modelKwargs?: { max_completion_tokens: number };
        topP?: number;
        temperature?: number;
        maxTokens?: number;
        numCtx: number;
      } = {
        model: modelConfig.modelName,
        // required but ignored by ollama
        apiKey: providerConfig.apiKey === '' ? 'ollama' : providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl ?? 'http://localhost:11434',
        topP,
        temperature,
        maxTokens,
        // Ollama defaults to a small window, and num_ctx sent per request wins
        // over the Modelfile — so this is the real window, whatever the model
        // tag claims. Keep it paired with MAX_PROMPT_TOKENS (see types.ts): the
        // trimmer has to fire before the window fills, or the run stalls.
        numCtx: MODEL_CONTEXT_TOKENS,
      };
      return new ChatOllama(args);
    }
    case ProviderTypeEnum.OpenRouter: {
      // Call the helper function, passing OpenRouter headers via the third argument
      console.log('[createChatModel] Calling createOpenAIChatModel for OpenRouter');
      return createOpenAIChatModel(providerConfig, modelConfig, {
        headers: {
          'X-Title': 'KONI Forms',
        },
      });
    }
    case ProviderTypeEnum.Llama: {
      // Llama API has a different response format, use custom ChatLlama class
      const args: {
        model: string;
        apiKey?: string;
        configuration?: Record<string, unknown>;
        topP?: number;
        temperature?: number;
        maxTokens?: number;
      } = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        topP: (modelConfig.parameters?.topP ?? 0.1) as number,
        temperature: (modelConfig.parameters?.temperature ?? 0.1) as number,
        maxTokens,
      };

      const configuration: Record<string, unknown> = {};
      if (providerConfig.baseUrl) {
        configuration.baseURL = providerConfig.baseUrl;
      }
      args.configuration = configuration;

      return new ChatLlama(args);
    }
    default: {
      // by default, we think it's a openai-compatible provider
      // Pass undefined for extraFetchOptions for default/custom cases
      return createOpenAIChatModel(providerConfig, modelConfig, undefined);
    }
  }
}
