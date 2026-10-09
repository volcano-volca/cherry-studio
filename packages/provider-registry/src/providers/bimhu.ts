import { defineProvider } from './types'

const claudeWebToolModels = [
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
  'claude-3-5-haiku',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet'
]
const geminiWebToolModels = [
  'gemini-2',
  'gemini-3',
  'gemini-flash-latest',
  'gemini-pro-latest',
  'gemini-flash-lite-latest'
]
const openAIWebSearchModels = ['gpt-4o', 'gpt-4-1', 'gpt-5', 'o3', 'o4']

/**
 * Bimhu dedicated gateway (New API compatible). Same shape as the `new-api`
 * preset, pinned to the Bimhu gateway host. No per-model overrides: an override
 * is also a catalog row, so it would advertise models every relay may not serve.
 */
export default defineProvider({
  id: 'bimhu',
  name: 'Bimhu',
  availableInEditions: ['global', 'cn'],
  // Only the default endpoint carries the gateway host; a baseUrl on the other
  // endpoints would override the user's single host.
  endpointConfigs: {
    'anthropic-messages': {
      adapterFamily: 'newapi'
    },
    'openai-chat-completions': {
      adapterFamily: 'newapi',
      baseUrl: 'https://api.bimhu.com',
      reasoningFormat: { type: 'openai-chat' }
    },
    // `newapi` on every endpoint so all four route through the NewAPI adapter.
    // Left inferred, the last two resolve to plain `openai`/`google` adapters.
    'openai-responses': {
      adapterFamily: 'newapi'
    },
    'google-generate-content': {
      adapterFamily: 'newapi'
    }
  },
  // Gateway-mapped delivery: only vendors owning a native tool factory receive one.
  serverTools: [
    {
      id: 'web-search',
      modelScope: 'model-dependent',
      modelIdPrefixes: [...claudeWebToolModels, ...geminiWebToolModels, ...openAIWebSearchModels],
      imageModelIds: ['gemini-3-pro-image', 'gemini-3-pro-image-preview'],
      vendors: ['anthropic', 'gemini', 'openai']
    },
    {
      id: 'url-context',
      modelScope: 'model-dependent',
      modelIdPrefixes: [...claudeWebToolModels, ...geminiWebToolModels],
      vendors: ['anthropic', 'gemini']
    }
  ],
  metadata: {
    website: {
      official: 'https://bimhu.com'
    }
  }
})
