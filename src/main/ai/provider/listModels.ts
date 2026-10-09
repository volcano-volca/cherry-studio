/**
 * Model listing service for Main process (v2 types).
 *
 * Uses Strategy Registry pattern: first matching fetcher wins.
 * All HTTP calls use @ai-sdk/provider-utils for consistent error handling.
 *
 * Every request runs through {@link modelListFetch} — the same Chromium network stack
 * chat uses — so TLS trust and proxy settings cannot diverge between listing models
 * and talking to them.
 */

import {
  createJsonErrorResponseHandler,
  createJsonResponseHandler,
  type FetchFunction,
  getFromApi as aiSdkGetFromApi,
  zodSchema
} from '@ai-sdk/provider-utils'
import * as z from 'zod'

import { loggerService } from '@logger'
import { providerService } from '@main/data/services/ProviderService'
import { mergeHeaders } from '@main/utils/http'
import type { EndpointType, ListedModels, Model } from '@shared/data/types/model'
import {
  createUniqueModelId,
  ENDPOINT_TYPE,
  endpointImpliedCapability,
} from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { formatApiHost, formatOllamaApiHost } from '@shared/utils/api'
import { deriveModelGroupName } from '@shared/utils/model'
import { SystemProviderIds } from '@shared/utils/systemProviderId'

import { customFetch } from '../utils/customFetch'
import {
  defaultHeaders,
  getBaseUrl,
  getExtraHeaders,
  getProviderAppHeaders,
} from '../utils/provider'
import {
  NewApiModelsResponseSchema,
  OpenAIModelsResponseSchema,
} from './listModelsSchemas'

const logger = loggerService.withContext('ModelListService')

/**
 * Provider `fetch` for model listing: Electron `net.fetch` (Chromium) rather than Node's
 * global fetch.
 *
 * Node only trusts its own bundled CA store, while Chromium trusts the OS one and honors
 * the session proxy — so an intercepting corporate root CA that is installed system-wide
 * (and therefore fine for chat, which already goes through `customFetch`) made *listing*
 * fail with a certificate error. Sharing the stack keeps both paths agreeing on trust,
 * proxy and error vocabulary (Chromium `net::ERR_CERT_*`, which `classifyErrorCategory`
 * maps to the proxy/SSL diagnosis).
 *
 * `cache: 'no-store'` because Chromium's HTTP cache would otherwise serve a stale
 * `/models` response on a second pull, resurrecting deleted models.
 */
const modelListFetch: FetchFunction = (input, init) => customFetch(input, { ...init, cache: 'no-store' })

// ── Types ──

type ModelFetcher = {
  match: (provider: Provider) => boolean
  fetch: (provider: Provider, signal?: AbortSignal, options?: { throwOnError?: boolean }) => Promise<ListedModels>
}

/** A listing in which the provider held nothing back — what most fetchers return. */
function listing(models: Partial<Model>[]): ListedModels {
  return { models }
}

function getErrorType(error: unknown) {
  return error instanceof Error ? error.name : typeof error
}

function warnSkippedOpenAIModelEntries(
  providerId: string,
  ...responses: Array<{ data: unknown[]; skippedModelCount?: number }>
): void {
  const skippedModelCount = responses.reduce((total, response) => total + (response.skippedModelCount ?? 0), 0)
  if (skippedModelCount > 0) {
    logger.warn('Skipped malformed OpenAI-compatible model entries', { providerId, skippedModelCount })
  }
}

// ── API Layer ──

const ApiErrorSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      code: z.string().optional()
    })
    .optional(),
  message: z.string().optional()
})

type ApiError = z.infer<typeof ApiErrorSchema>

async function getFromApi<T>({
  url,
  headers,
  responseSchema,
  abortSignal
}: {
  url: string
  headers?: Record<string, string>
  responseSchema: z.ZodType<T>
  abortSignal?: AbortSignal
}): Promise<T> {
  const { value } = await aiSdkGetFromApi({
    url,
    headers,
    successfulResponseHandler: createJsonResponseHandler(zodSchema(responseSchema)),
    failedResponseHandler: createJsonErrorResponseHandler({
      errorSchema: zodSchema(ApiErrorSchema),
      errorToMessage: (error: ApiError) => error.error?.message || error.message || 'Unknown error'
    }),
    abortSignal,
    fetch: modelListFetch
  })

  return value
}

/** Build default headers with rotated API key */

function defaultGroup(modelId: string, providerId: string): string {
  return deriveModelGroupName(modelId) ?? providerId
}

/** Build a partial v2 Model from API response. `apiModelId` carries `#`/`?`
 * verbatim (it is the provider's own handle), so `id` strips them. */
function toModel(apiModelId: string, provider: Provider, extra?: Partial<Model>): Partial<Model> {
  const safeModelId = apiModelId.replace(/[?#]/g, '')
  return {
    id: createUniqueModelId(provider.id, safeModelId),
    providerId: provider.id,
    apiModelId,
    name: extra?.name || apiModelId,
    group: extra?.group || defaultGroup(apiModelId, provider.id),
    ownedBy: extra?.ownedBy,
    description: extra?.description,
    capabilities: [],
    supportsStreaming: true,
    isEnabled: true,
    isHidden: false,
    ...extra
  }
}

function dedup<T>(items: T[], getId: (item: T) => string | undefined): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const id = getId(item)?.trim()
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** Vertex AI: paginate `publishers/{publisher}/models` for each default publisher
 *  (google, openai, meta, qwen, deepseek-ai, moonshotai, zai-org), then filter the
 *  union down to model families we actually run. Misconfigured providers and
 *  per-publisher request failures degrade to "no models from this publisher" with
 *  a warn log instead of failing the whole listing. */
/**
 * ComfyUI has no `/models` endpoint: what a user can generate with is whatever
 * workflow they saved, so the saved-workflow listing IS the model list. Each row is
 * declared image-only on the ComfyUI image endpoint, which is what makes it selectable
 * on the paintings page (`supportsImageGenerationEndpoint`) and routes generation to
 * the comfyui transport instead of an OpenAI adapter.
 */
type NewApiModelResponseItem = z.infer<typeof NewApiModelsResponseSchema>['data'][number]

const ENDPOINT_TYPE_ALIASES: Record<string, EndpointType> = {
  anthropic: ENDPOINT_TYPE.ANTHROPIC_MESSAGES,
  'anthropic:messages': ENDPOINT_TYPE.ANTHROPIC_MESSAGES,
  embeddings: ENDPOINT_TYPE.OPENAI_EMBEDDINGS,
  gemini: ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT,
  'gemini:generate-content': ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT,
  'image-edit': ENDPOINT_TYPE.OPENAI_IMAGE_EDIT,
  'image-generation': ENDPOINT_TYPE.OPENAI_IMAGE_GENERATION,
  'jina-rerank': ENDPOINT_TYPE.JINA_RERANK,
  openai: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
  'openai:chat-completions': ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
  'openai:embeddings': ENDPOINT_TYPE.OPENAI_EMBEDDINGS,
  'openai:image-generations': ENDPOINT_TYPE.OPENAI_IMAGE_GENERATION,
  'openai:responses': ENDPOINT_TYPE.OPENAI_RESPONSES,
  'openai-response': ENDPOINT_TYPE.OPENAI_RESPONSES,
  'openai-response-compact': ENDPOINT_TYPE.OPENAI_RESPONSES,
  'openai-video': ENDPOINT_TYPE.OPENAI_VIDEO_GENERATION
}
const ENDPOINT_TYPE_VALUES = new Set<string>(Object.values(ENDPOINT_TYPE))

function normalizeEndpointTypes(values: string[] | undefined): EndpointType[] | undefined {
  if (!values?.length) {
    return undefined
  }

  const endpointTypes = dedup(
    values
      .map((value) => {
        const normalized = value.trim().toLowerCase()
        return (
          ENDPOINT_TYPE_ALIASES[normalized] ??
          (ENDPOINT_TYPE_VALUES.has(normalized) ? (normalized as EndpointType) : undefined)
        )
      })
      .filter((value): value is EndpointType => Boolean(value)),
    (value) => value
  )

  if (endpointTypes[0] === ENDPOINT_TYPE.OPENAI_EMBEDDINGS) {
    const chatEndpoint = endpointTypes.find((endpointType) => endpointImpliedCapability(endpointType) === undefined)
    if (chatEndpoint) {
      return [chatEndpoint, ...endpointTypes.filter((endpointType) => endpointType !== chatEndpoint)]
    }
  }

  return endpointTypes.length > 0 ? endpointTypes : undefined
}

const newApiFetcher: ModelFetcher = {
  // Bimhu is New API compatible: list models through the New API `/models` shape.
  match: (p) => p.id === SystemProviderIds.bimhu || p.presetProviderId === SystemProviderIds.bimhu,
  fetch: async (provider, signal) => {
    const baseUrl = formatApiHost(getBaseUrl(provider))
    const response = await getFromApi({
      url: `${baseUrl}/models`,
      headers: defaultHeaders(provider),
      responseSchema: NewApiModelsResponseSchema,
      abortSignal: signal
    })
    return listing(
      dedup(response.data, (m) => m.id).map((m: NewApiModelResponseItem) => {
        const endpointTypes = normalizeEndpointTypes(m.supported_endpoint_types)
        const impliedCapability = endpointImpliedCapability(endpointTypes?.[0])

        return toModel(m.id, provider, {
          ownedBy: m.owned_by,
          endpointTypes,
          ...(impliedCapability ? { capabilities: [impliedCapability] } : {})
        })
      })
    )
  }
}

/** Vercel AI Gateway: hits /v3/ai/config directly with `ai-gateway-protocol-version` header
 *  instead of going through `@ai-sdk/gateway`'s `getAvailableModels()`. The SDK validates the
 *  response against a strict schema that breaks whenever Vercel evolves the registry, so we
 *  parse with `z.looseObject` here to keep listing resilient. Inference still uses the SDK. */
async function listOpenAICompatibleModels(
  provider: Provider,
  baseUrl: string,
  signal?: AbortSignal
): Promise<ListedModels> {
  const response = await getFromApi({
    url: `${baseUrl}/models`,
    headers: defaultHeaders(provider),
    responseSchema: OpenAIModelsResponseSchema,
    abortSignal: signal
  })
  warnSkippedOpenAIModelEntries(provider.id, response)
  return listing(
    dedup(response.data, (m) => m.id).map((m) =>
      toModel(m.id, provider, {
        name: m.name || m.id,
        ownedBy: m.owned_by
      })
    )
  )
}

const openAICompatibleFetcher: ModelFetcher = {
  match: () => true,
  fetch: (provider, signal) => listOpenAICompatibleModels(provider, formatApiHost(getBaseUrl(provider)), signal)
}

// Native v1 lists downloaded models even when JIT loading is disabled.
// ── Ollama probe ──

/** Lightweight model-existence check for Ollama — avoids loading the model into memory. */
export async function probeOllamaModel(
  provider: Provider,
  modelApiId: string | undefined,
  signal?: AbortSignal,
  apiKeyOverride?: string
): Promise<{ latency: number }> {
  const start = performance.now()
  const baseUrl = formatOllamaApiHost(getBaseUrl(provider))
  const resolved = providerService.resolveApiKey(provider.id, apiKeyOverride)
  const headers = mergeHeaders(getProviderAppHeaders(provider), getExtraHeaders(provider), {
    'Content-Type': 'application/json',
    ...(resolved.value ? { Authorization: `Bearer ${resolved.value}`, 'X-Api-Key': resolved.value } : {})
  })
  const response = await fetch(`${baseUrl}/show`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: modelApiId ?? '' }),
    signal
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string; message?: string } | undefined
    throw new Error(body?.error ?? body?.message ?? `Ollama /api/show returned ${response.status}`)
  }
  return { latency: performance.now() - start }
}

// ── Registry (order matters: first match wins) ──

const fetchers: ModelFetcher[] = [
  newApiFetcher,
  openAICompatibleFetcher // always-match fallback, must be last
]

// ── Public API ──

export async function listModels(
  provider: Provider,
  abortSignal?: AbortSignal,
  options?: { throwOnError?: boolean }
): Promise<ListedModels> {
  try {
    const fetcher = fetchers.find((f) => f.match(provider))!
    return await fetcher.fetch(provider, abortSignal, options)
  } catch (error) {
    logger.error('Error listing models', { providerId: provider.id, errorType: getErrorType(error) })
    if (options?.throwOnError) {
      throw error
    }
    return listing([])
  }
}
