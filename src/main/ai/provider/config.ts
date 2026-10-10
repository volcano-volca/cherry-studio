/**
 * `Provider + Model` → `ProviderConfig` for `@cherrystudio/ai-core`.
 * Resolves the serving credential and its safe identity in one step so billing
 * can attribute the request without consulting mutable rotation state later.
 */

import { isEmpty } from 'es-toolkit/compat'

import { application } from '@application'
import { hasProviderConfig, type StringKeys } from '@cherrystudio/ai-core/provider'
import type { CherryInProviderSettings } from '@cherrystudio/ai-sdk-provider'
import { providerService, type ResolvedProviderApiKey } from '@main/data/services/ProviderService'
import { CHERRYAI_PROVIDER_ID, isManagedCherryCloudModel } from '@shared/data/presets/cherryai'
import { OPENAI_CODEX_PROVIDER_ID } from '@shared/data/presets/codex'
import { GROK_CLI_PROVIDER_ID } from '@shared/data/presets/grokCli'
import { LOCAL_EMBEDDING_PROVIDER_ID } from '@shared/data/presets/localEmbedding'
import type { EndpointType, Model } from '@shared/data/types/model'
import { ENDPOINT_TYPE } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import {
  formatApiHost,
  formatOllamaApiHost,
  isBareVertexApiHost,
  isWithTrailingSharp,
  withoutTrailingApiVersion
} from '@shared/utils/api'
import {
  isAzureOpenAIProvider,
  isGeminiProvider,
  isOllamaProvider,
  isVertexProvider,
  resolveEndpointDialect
} from '@shared/utils/provider'

import type { ProviderConfig } from '../types'
import { type AppProviderId, appProviderIds, type AppProviderSettingsMap } from '../types'
import { customFetch } from '../utils/customFetch'
import {
  getBaseUrl,
  getExtraHeaders,
  getProviderAppHeaders,
  routeToEndpoint
} from '../utils/provider'
import { generateSignature } from './cherryai'
import { buildCherryCloudProviderConfig } from './cherryCloud'
import { buildCodexRequestHeaders, coerceCodexRequestBody } from './codex'
import type { ServingAuthMethod, ServingCredentialReceipt } from './credential'
import { resolveAiSdkProviderId, type ResolvedEndpoint, resolveEffectiveEndpoint } from './endpoint'
import { buildGrokCliRequestHeaders, rewriteGrokCliResponsesBody } from './grokCli'

interface BaseConfig {
  baseURL: string
  apiKey: string
}

interface BuilderContext {
  actualProvider: Provider
  model: Model
  baseConfig: BaseConfig
  resolvedBaseUrl: string
  apiKeyOverride?: string
  endpointType?: EndpointType
  endpoint?: string
  aiSdkProviderId: StringKeys<AppProviderSettingsMap>
}

type ApiKeyBuilderContext = BuilderContext & {
  apiKeySelection: ResolvedProviderApiKey['apiKeySelection']
}

interface ProviderToAiSdkConfigOptions {
  apiKeyOverride?: string
  resolvedEndpoint?: ResolvedEndpoint
}

export interface ResolvedProviderAiSdkConfig {
  config: ProviderConfig
  credentialReceipt: ServingCredentialReceipt
}

/** Applies endpoint-/provider-specific formatting (API version, Ollama/Gemini paths). */
function formatBaseURL(baseURL: string, provider: Provider, endpointType?: EndpointType): string {
  if (!baseURL) return ''

  const appendApiVersion = !isWithTrailingSharp(baseURL)

  // Preserve the v1 Vertex contract before generic endpoint formatting:
  // official bare hosts are SDK-derived, while every explicit override keeps
  // its host/port/path and receives Vertex's default /v1 when needed.
  if (isVertexProvider(provider)) {
    return isBareVertexApiHost(baseURL) ? '' : formatApiHost(baseURL, appendApiVersion)
  }

  // Endpoint-driven formatting
  if (endpointType === ENDPOINT_TYPE.OLLAMA_CHAT || endpointType === ENDPOINT_TYPE.OLLAMA_GENERATE) {
    return formatOllamaApiHost(baseURL)
  }
  if (endpointType === ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT) {
    return formatApiHost(baseURL, appendApiVersion, 'v1beta')
  }

  // Provider-driven formatting (for providers without endpoint type info)
  if (isOllamaProvider(provider)) return formatOllamaApiHost(baseURL)
  if (isGeminiProvider(provider)) return formatApiHost(baseURL, appendApiVersion, 'v1beta')

  // Providers that don't append API version
  const noVersionProviders = ['copilot', CHERRYAI_PROVIDER_ID, 'perplexity', 'newapi', 'new-api', 'azure-openai']
  if (noVersionProviders.includes(provider.id) || noVersionProviders.includes(provider.presetProviderId ?? '')) {
    return formatApiHost(baseURL, false)
  }

  return formatApiHost(baseURL, appendApiVersion)
}

// ── SDK Config Building ──

type ProviderConfigBuilder = (ctx: BuilderContext) => ProviderConfig | Promise<ProviderConfig>

interface ResolvedProviderConfigBuild {
  config: ProviderConfig
  credentialReceipt: ServingCredentialReceipt
}

type ConfigBuilderEntry = {
  match: (provider: Provider, aiSdkProviderId: AppProviderId) => boolean
  build: (ctx: BuilderContext) => ResolvedProviderConfigBuild | Promise<ResolvedProviderConfigBuild>
}

function selectApiKey(ctx: BuilderContext): ApiKeyBuilderContext {
  const resolved = providerService.resolveApiKey(ctx.actualProvider.id, ctx.apiKeyOverride)
  return {
    ...ctx,
    baseConfig: { ...ctx.baseConfig, apiKey: resolved.value },
    apiKeySelection: resolved.apiKeySelection
  }
}

function withSelectedApiKey(build: ProviderConfigBuilder): ConfigBuilderEntry['build'] {
  return async (ctx) => {
    const selected = selectApiKey(ctx)
    return {
      config: await build(selected),
      credentialReceipt: selected.apiKeySelection
    }
  }
}

function withProviderAuth(method: ServingAuthMethod, build: ProviderConfigBuilder): ConfigBuilderEntry['build'] {
  return async (ctx) => ({
    config: await build(ctx),
    credentialReceipt: { attribution: 'auth', method }
  })
}

function withoutCredential(build: ProviderConfigBuilder): ConfigBuilderEntry['build'] {
  return async (ctx) => ({
    config: await build(ctx),
    credentialReceipt: { attribution: 'unknown' }
  })
}

/** Endpoint priority: `model.endpointTypes[0]` > `provider.defaultChatEndpoint` > fallback. */
export async function providerToAiSdkConfig(
  provider: Provider,
  model: Model,
  options?: ProviderToAiSdkConfigOptions
): Promise<ProviderConfig> {
  return (await resolveProviderAiSdkConfig(provider, model, options)).config
}

/** Resolve SDK configuration plus the exact non-secret serving-credential receipt. */
export async function resolveProviderAiSdkConfig(
  provider: Provider,
  model: Model,
  options?: ProviderToAiSdkConfigOptions
): Promise<ResolvedProviderAiSdkConfig> {
  const { endpointType, baseUrl } = options?.resolvedEndpoint ?? resolveEffectiveEndpoint(provider, model)

  const aiSdkProviderId = appProviderIds[resolveAiSdkProviderId(provider, endpointType)]

  const formattedBaseUrl = formatBaseURL(baseUrl, provider, endpointType)
  const { baseURL, endpoint } = routeToEndpoint(formattedBaseUrl)

  const ctx: BuilderContext = {
    actualProvider: provider,
    model,
    resolvedBaseUrl: baseUrl,
    // Credential selection is intentionally deferred until a key-backed builder
    // wins dispatch. OAuth/IAM/no-credential routes must not advance rotation
    // for a key they never serve with.
    baseConfig: { baseURL, apiKey: '' },
    apiKeyOverride: options?.apiKeyOverride,
    endpointType,
    endpoint,
    aiSdkProviderId
  }

  const builders: ConfigBuilderEntry[] = [
    { match: (p) => p.id === OPENAI_CODEX_PROVIDER_ID, build: withProviderAuth('oauth', buildCodexConfig) },
    { match: (p) => p.id === GROK_CLI_PROVIDER_ID, build: withProviderAuth('oauth', buildGrokCliConfig) },
    {
      match: (p) => isManagedCherryCloudModel(p.id),
      build: withoutCredential((ctx) => buildCherryCloudProviderConfig(ctx.endpointType, ctx.endpoint))
    },
    { match: (p) => p.id === CHERRYAI_PROVIDER_ID, build: withSelectedApiKey(buildCherryAIConfig) },
    // Local embedding runs fully in-process (transformers.js in a worker): no
    // endpoint, baseURL, or apiKey. Without this entry it falls through to the
    // openai-compatible builder, which hands ai-core an empty baseURL and throws
    // "Invalid URL". Route it to its own registered provider so embed calls reach
    // LocalEmbeddingModel.doEmbed directly.
    {
      match: (p) => p.id === LOCAL_EMBEDDING_PROVIDER_ID,
      build: withoutCredential((ctx) => ({
        providerId: LOCAL_EMBEDDING_PROVIDER_ID,
        endpoint: ctx.endpoint,
        providerSettings: {}
      }))
    },
    { match: (p) => isOllamaProvider(p), build: withSelectedApiKey(buildOllamaConfig) },
    { match: (p) => isAzureOpenAIProvider(p), build: withSelectedApiKey(buildAzureConfig) },
    // Subset Responses servers (HuggingFace router today) speak the spec-neutral dialect: the
    // minimal body only, no OpenAI-only extras they would reject.
    { match: (_, id) => id === 'open-responses', build: withSelectedApiKey(buildOpenResponsesConfig) },
    { match: (_, id) => id === 'newapi', build: withSelectedApiKey(buildNewApiConfig) },
  ]

  const builder = builders.find((b) => b.match(provider, aiSdkProviderId))
  let resolved: ResolvedProviderConfigBuild
  if (builder) {
    resolved = await builder.build(ctx)
  } else if (hasProviderConfig(aiSdkProviderId) && (aiSdkProviderId as string) !== 'openai-compatible') {
    resolved = await withSelectedApiKey(buildGenericProviderConfig)(ctx)
  } else {
    resolved = await withSelectedApiKey(buildOpenAICompatibleConfig)(ctx)
  }

  const { config } = resolved
  // Default every provider to the proxy-aware net.fetch base so the app proxy
  // (ProxyService → session.setProxy) applies to provider HTTP traffic. Builders
  // that install their own fetch wrapper (e.g. CherryAI request signing) compose
  // on top of customFetch; `??=` preserves them rather than clobbering them.
  config.providerSettings.fetch ??= customFetch

  return {
    config,
    credentialReceipt: resolved.credentialReceipt
  }
}

// ── Config Builders ──

/**
 * OpenAI Codex routes through the standard OpenAI Responses adapter, but against
 * the ChatGPT backend codex endpoint (`…/backend-api/codex/responses`, no `/v1`
 * segment) with OAuth bearer auth instead of an API key. The per-request `fetch`
 * is the single place that (1) injects a freshly-refreshed OAuth token + account
 * header, and (2) coerces the body to what the codex backend demands —
 * `store: false` plus encrypted-reasoning round-tripping — neither of which the
 * generic Responses adapter sets on its own.
 */
function buildCodexConfig(ctx: BuilderContext): ProviderConfig<'openai'> {
  // Use the raw configured baseURL (the adapter appends `/responses`); the
  // formatted one in baseConfig has `/v1` tacked on, which the codex path rejects.
  const rawBaseUrl =
    getBaseUrl(ctx.actualProvider, ENDPOINT_TYPE.OPENAI_RESPONSES) || 'https://chatgpt.com/backend-api/codex'
  const baseURL = rawBaseUrl.replace(/\/+$/, '')

  return {
    providerId: 'openai',
    endpoint: ctx.endpoint,
    providerSettings: {
      ...ctx.baseConfig,
      baseURL,
      // The SDK rejects an empty key; the real bearer token is injected per
      // request in the custom fetch below, overriding this placeholder.
      apiKey: 'codex-oauth',
      headers: { ...getProviderAppHeaders(ctx.actualProvider), ...getExtraHeaders(ctx.actualProvider) },
      fetch: buildCodexFetch()
    }
  }
}

function buildCodexFetch() {
  // Token fetch + not-signed-in guard + 401 force-refresh retry live in
  // OAuthRuntimeService.authenticatedFetch; this wrapper only shapes the codex
  // request (headers + body coercion), re-applied with the fresh token on retry.
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    application.get('OAuthRuntimeService').authenticatedFetch(
      OPENAI_CODEX_PROVIDER_ID,
      (creds) => ({
        input,
        init: {
          ...init,
          headers: buildCodexRequestHeaders(init?.headers, {
            accessToken: creds.accessToken,
            accountId: creds.accountId ?? null
          }),
          body: coerceCodexRequestBody(init?.body)
        }
      }),
      customFetch,
      { notSignedInMessage: 'Not signed in to OpenAI Codex. Open the provider settings and sign in again.' }
    )
}

/**
 * Grok CLI routes through the OpenAI Responses adapter against xAI's Grok CLI
 * proxy (`cli-chat-proxy.grok.com/v1/responses`) with OAuth bearer auth. The
 * per-request `fetch` injects a freshly-refreshed token + the Grok-CLI proxy
 * headers, and rewrites the body into the shape the proxy accepts (hoisting
 * system turns into `instructions`, normalizing reasoning) — none of which
 * the generic Responses adapter does on its own.
 */
function buildGrokCliConfig(ctx: BuilderContext): ProviderConfig<'openai'> {
  // Use the raw configured baseURL (already `…/v1`; the adapter appends
  // `/responses`); the formatted one in baseConfig would double the `/v1`.
  const rawBaseUrl =
    getBaseUrl(ctx.actualProvider, ENDPOINT_TYPE.OPENAI_RESPONSES) || 'https://cli-chat-proxy.grok.com/v1'
  const baseURL = rawBaseUrl.replace(/\/+$/, '')

  return {
    providerId: 'openai',
    endpoint: ctx.endpoint,
    providerSettings: {
      ...ctx.baseConfig,
      baseURL,
      // The SDK rejects an empty key; the real bearer token is injected per
      // request in the custom fetch below, overriding this placeholder.
      apiKey: 'grok-cli-oauth',
      headers: { ...getProviderAppHeaders(ctx.actualProvider), ...getExtraHeaders(ctx.actualProvider) },
      fetch: buildGrokCliFetch()
    }
  }
}

function buildGrokCliFetch() {
  // See buildCodexFetch: shared token/refresh/401-retry lives in
  // OAuthRuntimeService.authenticatedFetch; this only shapes the Grok request.
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let modelId = ''
    let body = init?.body
    if (typeof body === 'string') {
      try {
        const json = JSON.parse(body)
        modelId = typeof json.model === 'string' ? json.model : ''
        body = JSON.stringify(rewriteGrokCliResponsesBody(json))
      } catch {
        // Non-JSON body (shouldn't happen for responses) — leave untouched.
      }
    }

    return application.get('OAuthRuntimeService').authenticatedFetch(
      GROK_CLI_PROVIDER_ID,
      (creds) => ({
        input,
        init: {
          ...init,
          headers: buildGrokCliRequestHeaders(init?.headers, { accessToken: creds.accessToken, modelId }),
          body
        }
      }),
      customFetch,
      { notSignedInMessage: 'Not signed in to Grok CLI. Open the provider settings and sign in again.' }
    )
  }
}

async function buildCherryAIConfig(ctx: BuilderContext): Promise<ProviderConfig<'openai-compatible'>> {
  return {
    providerId: 'openai-compatible',
    endpoint: ctx.endpoint,
    providerSettings: {
      ...ctx.baseConfig,
      name: ctx.actualProvider.id,
      includeUsage: resolveEndpointDialect(ctx.actualProvider, ctx.endpointType).streamOptions,
      headers: { ...getProviderAppHeaders(ctx.actualProvider), ...getExtraHeaders(ctx.actualProvider) },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const signature = generateSignature({
          method: 'POST',
          path: '/chat/completions',
          query: '',
          body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
        })
        return customFetch(input, { ...init, headers: { ...init?.headers, ...signature } })
      }
    }
  }
}

function buildCommonOptions(ctx: BuilderContext) {
  const options: Record<string, any> = {
    headers: {
      ...getProviderAppHeaders(ctx.actualProvider),
      ...getExtraHeaders(ctx.actualProvider)
    }
  }
  if (ctx.aiSdkProviderId === 'openai') {
    options.headers['X-Api-Key'] = ctx.baseConfig.apiKey
  }
  return options
}

function buildOllamaConfig(ctx: BuilderContext): ProviderConfig<'ollama'> {
  const headers: Record<string, string> = {
    ...getProviderAppHeaders(ctx.actualProvider),
    ...getExtraHeaders(ctx.actualProvider)
  }
  if (!isEmpty(ctx.baseConfig.apiKey)) {
    headers.Authorization = `Bearer ${ctx.baseConfig.apiKey}`
  }

  return {
    providerId: 'ollama',
    endpoint: ctx.endpoint,
    providerSettings: { ...ctx.baseConfig, headers }
  }
}

function mapCherryinEndpointType(epType: string | undefined): CherryInProviderSettings['endpointType'] {
  if (!epType) return undefined

  switch (epType) {
    case ENDPOINT_TYPE.ANTHROPIC_MESSAGES:
      return 'anthropic'
    case ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT:
      return 'gemini'
    case ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS:
    case ENDPOINT_TYPE.OLLAMA_CHAT:
      return 'openai'
    case ENDPOINT_TYPE.OPENAI_RESPONSES:
      return 'openai-response'
    case ENDPOINT_TYPE.JINA_RERANK:
      return 'jina-rerank'
    case ENDPOINT_TYPE.OPENAI_EMBEDDINGS:
      return 'embedding'
    default:
      return 'openai'
  }
}

function formatAzureBaseURL(baseURL: string, forAnthropic: boolean, includeApiVersion = false): string {
  const normalized = baseURL.replace(/\/v1$/, '').replace(/\/openai$/, '')
  return forAnthropic ? normalized : `${normalized}/openai${includeApiVersion ? '/v1' : ''}`
}

function isOfficialAzureOpenAIBaseURL(baseURL: string): boolean {
  const hostname = new URL(baseURL).hostname
  return (
    hostname.endsWith('.openai.azure.com') ||
    hostname.endsWith('.services.ai.azure.com') ||
    hostname.endsWith('.cognitiveservices.azure.com')
  )
}

function buildAzureConfig(
  ctx: BuilderContext
): ProviderConfig<'azure'> | ProviderConfig<'azure-anthropic'> | ProviderConfig<'azure-responses'> {
  const modelId = ctx.model.apiModelId ?? ctx.model.id
  const endpointType = ctx.endpointType

  // Azure + Claude model → azure-anthropic
  if (modelId.startsWith('claude') || endpointType === ENDPOINT_TYPE.ANTHROPIC_MESSAGES) {
    return {
      providerId: 'azure-anthropic',
      endpoint: ctx.endpoint,
      providerSettings: {
        ...ctx.baseConfig,
        baseURL: formatAzureBaseURL(ctx.baseConfig.baseURL, true),
        headers: { ...getProviderAppHeaders(ctx.actualProvider), ...getExtraHeaders(ctx.actualProvider) }
      }
    }
  }

  const apiVersion = ctx.actualProvider.settings?.apiVersion?.trim()
  const isResponsesVariant = ctx.aiSdkProviderId === 'azure-responses'
  const useDeploymentBasedUrls = Boolean(apiVersion && !isResponsesVariant)
  const useCustomGatewayV1 = !isOfficialAzureOpenAIBaseURL(ctx.baseConfig.baseURL) && !useDeploymentBasedUrls

  const providerSettings: AppProviderSettingsMap['azure'] & {
    apiVersion?: string
    useDeploymentBasedUrls?: boolean
  } = {
    ...ctx.baseConfig,
    baseURL: formatAzureBaseURL(ctx.baseConfig.baseURL, false, useCustomGatewayV1),
    headers: { ...getProviderAppHeaders(ctx.actualProvider), ...getExtraHeaders(ctx.actualProvider) }
  }

  if (apiVersion) {
    providerSettings.apiVersion = apiVersion
    if (useDeploymentBasedUrls) {
      providerSettings.useDeploymentBasedUrls = true
    }
  }

  if (useCustomGatewayV1) {
    // The Azure SDK treats non-Azure hosts as complete URLs, so preserve Cherry's v1/version contract here.
    providerSettings.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      url.searchParams.set('api-version', apiVersion || 'v1')
      return customFetch(url, init)
    }
  }

  if (isResponsesVariant) {
    return {
      providerId: 'azure-responses',
      endpoint: ctx.endpoint,
      providerSettings
    }
  }

  return {
    providerId: 'azure',
    endpoint: ctx.endpoint,
    providerSettings
  }
}

function buildOpenAICompatibleConfig(ctx: BuilderContext): ProviderConfig<'openai-compatible'> {
  const commonOptions = buildCommonOptions(ctx)

  return {
    providerId: 'openai-compatible',
    endpoint: ctx.endpoint,
    providerSettings: {
      ...ctx.baseConfig,
      ...commonOptions,
      name: ctx.actualProvider.id,
      includeUsage: resolveEndpointDialect(ctx.actualProvider, ctx.endpointType).streamOptions
    }
  }
}

function buildGenericProviderConfig(ctx: BuilderContext): ProviderConfig {
  const commonOptions = buildCommonOptions(ctx)

  return {
    providerId: ctx.aiSdkProviderId,
    endpoint: ctx.endpoint,
    providerSettings: { ...ctx.baseConfig, ...commonOptions }
  }
}

/**
 * `createOpenResponses` takes a full POST endpoint URL and a `name` that sets both the
 * providerOptions namespace and the model's `provider` string. `name: 'openai'` keeps
 * wire options under `providerOptions.openai` and lets tool-factory resolution fall
 * back to the OpenAI extension — matching the `@ai-sdk/openai` behavior it replaces.
 */
function buildOpenResponsesConfig(ctx: BuilderContext): ProviderConfig<'open-responses'> {
  return {
    providerId: 'open-responses',
    endpoint: ctx.endpoint,
    providerSettings: {
      url: `${ctx.baseConfig.baseURL.replace(/\/+$/, '')}/responses`,
      name: 'openai',
      apiKey: ctx.baseConfig.apiKey,
      headers: {
        ...getProviderAppHeaders(ctx.actualProvider),
        ...getExtraHeaders(ctx.actualProvider),
        // Parity with buildCommonOptions' 'openai' branch — these providers received it before.
        'X-Api-Key': ctx.baseConfig.apiKey
      }
    }
  }
}

/**
 * NewAPI multiplexes every protocol over ONE host, so the version segment belongs to the ROUTE, not
 * the host: `/v1` for chat / responses / messages (the Anthropic SDK appends `/messages` to it) and
 * `/v1beta` for Gemini. Whatever version the user typed is therefore dropped and re-derived per
 * endpoint — otherwise a `/v1beta` host reaches chat as `/v1beta/chat/completions` (404) and a `/v1`
 * host reaches Gemini without its `/v1beta`. A `#`-terminated host still opts out entirely.
 */
function formatNewApiBaseURL(baseURL: string, endpointType: EndpointType | undefined): string {
  const host = withoutTrailingApiVersion(baseURL)
  return endpointType === ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT
    ? formatApiHost(host, true, 'v1beta')
    : formatApiHost(host, true)
}

function buildNewApiConfig(ctx: BuilderContext): ProviderConfig<'newapi'> {
  const endpointType = ctx.endpointType
  let rawBaseURL: string

  if (endpointType === ENDPOINT_TYPE.ANTHROPIC_MESSAGES) {
    const anthropicBaseURL = getBaseUrl(ctx.actualProvider, endpointType)
    rawBaseURL = anthropicBaseURL || ctx.baseConfig.baseURL
  } else {
    rawBaseURL = ctx.baseConfig.baseURL
  }

  const baseURL = formatNewApiBaseURL(rawBaseURL, endpointType)

  return {
    providerId: 'newapi',
    endpoint: ctx.endpoint,
    providerSettings: {
      ...ctx.baseConfig,
      baseURL,
      endpointType: mapCherryinEndpointType(endpointType),
      headers: { ...getProviderAppHeaders(ctx.actualProvider), ...getExtraHeaders(ctx.actualProvider) }
    }
  }
}
