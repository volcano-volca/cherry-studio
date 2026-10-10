import { describe, expect, it } from 'vitest'

import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'

import { buildProviderBuiltinWebSearchConfig, getWebSearchParams } from '../websearch'

const webSearchConfig = { maxResults: 50, excludeDomains: [] }

const model = (partial: Partial<Model>): Model => partial as Model
/** Canonical preset provider (id === preset id) and a user-copied one that keeps its own id. */
const preset = (presetProviderId: string): Provider => ({ id: presetProviderId, presetProviderId }) as Provider
const copyOf = (presetProviderId: string): Provider => ({ id: 'user-copy-1', presetProviderId }) as Provider

describe('buildProviderBuiltinWebSearchConfig', () => {
  it('emits a bare openai config for doubao so only {type:"web_search"} reaches Ark', () => {
    const config = buildProviderBuiltinWebSearchConfig(
      'openai',
      webSearchConfig,
      model({ id: 'doubao::doubao-seed-2-1-pro', providerId: 'doubao', apiModelId: 'doubao-seed-2-1-pro' }),
      preset('doubao')
    )
    expect(config).toEqual({ openai: {} })
  })

  it('emits a bare openai config for DeepSeek Responses web search', () => {
    const config = buildProviderBuiltinWebSearchConfig(
      'openai',
      webSearchConfig,
      model({ id: 'deepseek::deepseek-v4-flash', providerId: 'deepseek', apiModelId: 'deepseek-v4-flash' }),
      preset('deepseek')
    )
    expect(config).toEqual({ openai: {} })
  })

  // Availability keys off the wire id with an `apiModelId ?? id` fallback, so a model
  // carrying the wire name in `id` alone still routes to the server side. Reading
  // `apiModelId` directly here made the config undefined for exactly those models:
  // the route stayed 'server' (client tools withheld) and nothing was injected.
  it('emits the openrouter web_search server-tool args (camelCase, mapped to the wire tool)', () => {
    const config = buildProviderBuiltinWebSearchConfig(
      'openrouter',
      webSearchConfig,
      model({ id: 'openrouter::anthropic/claude-4', providerId: 'openrouter', apiModelId: 'anthropic/claude-4' }),
      preset('openrouter')
    )
    expect(config).toEqual({ openrouter: { maxResults: 50 } })
  })

  it('forwards excluded domains to the openrouter web_search tool (→ excluded_domains)', () => {
    const config = buildProviderBuiltinWebSearchConfig(
      'openrouter',
      { maxResults: 10, excludeDomains: ['example.com', 'https://foo.dev/bar'] },
      model({ id: 'openrouter::x/y', providerId: 'openrouter', apiModelId: 'x/y' }),
      preset('openrouter')
    )
    expect(config).toEqual({ openrouter: { maxResults: 10, excludedDomains: ['example.com', 'foo.dev'] } })
  })

  it('keeps searchContextSize for real openai models', () => {
    const config = buildProviderBuiltinWebSearchConfig(
      'openai',
      webSearchConfig,
      model({ id: 'openai::gpt-5.5', providerId: 'openai', apiModelId: 'gpt-5.5' }),
      preset('openai')
    )
    expect(config).toEqual({ openai: { searchContextSize: 'medium' } })
  })
})

/**
 * Bailian serves built-in search through two different mechanisms, split by endpoint: the Responses
 * `web_search` tool (Qwen3.x line only) and Chat Completions' `enable_search` params. This matrix pins
 * which mechanism each SKU gets, so a model can never be handed the one its endpoint does not serve.
 */
// A user-copied provider keeps its own id but still gets the preset's serverTools and the preset's
// request transform, so delivery must key off the preset link — not `model.providerId`. Keying it off
// the runtime id routed these copies to the server side and then injected nothing.
// Kimi's tool executes a formula fiber, so it needs THIS request's credential. The factory cannot
// read it off the provider instance — `getToolProvider` re-creates that one with no settings when an
// instance is cached, which made every search fail with "Moonshot API key is missing".
describe('moonshot formula credentials', () => {
  it('passes the resolved serving credential to the tool factory', () => {
    const config = buildProviderBuiltinWebSearchConfig(
      'moonshot',
      webSearchConfig,
      model({ id: 'moonshot::kimi-k3', providerId: 'moonshot', apiModelId: 'kimi-k3' }),
      preset('moonshot'),
      { apiKey: 'sk-live', baseURL: 'https://api.moonshot.cn/v1' }
    )
    expect(config).toEqual({ moonshot: { apiKey: 'sk-live', baseURL: 'https://api.moonshot.cn/v1' } })
  })
})

describe('preset-derived (copied) providers deliver like their preset', () => {
  it('emits the zhipu marker for a copied Zhipu provider', () => {
    const params = getWebSearchParams(
      model({ id: 'user-copy-1::glm-5', providerId: 'user-copy-1', apiModelId: 'glm-5' }),
      copyOf('zhipu')
    )
    expect(params).toEqual({ web_search: { enable: true, search_engine: 'search_pro', search_result: true } })
  })

  it('emits the bare Ark tool for a copied Doubao provider instead of openai knobs', () => {
    const config = buildProviderBuiltinWebSearchConfig(
      'openai',
      webSearchConfig,
      model({ id: 'user-copy-1::doubao-seed-2-1-pro', providerId: 'user-copy-1', apiModelId: 'doubao-seed-2-1-pro' }),
      copyOf('doubao')
    )
    expect(config).toEqual({ openai: {} })
  })
})

describe('getWebSearchParams (zhipu chat)', () => {
  it('emits the web_search marker for the transform to move into tools', () => {
    const params = getWebSearchParams(
      model({ id: 'zhipu::glm-5', providerId: 'zhipu', apiModelId: 'glm-5' }),
      preset('zhipu')
    )
    expect(params).toEqual({
      web_search: { enable: true, search_engine: 'search_pro', search_result: true }
    })
  })
})
