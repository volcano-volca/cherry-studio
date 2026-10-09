import { describe, expect, it } from 'vitest'

import { RegistryEndpointConfigSchema } from '../schemas/provider'
import { ProviderModelOverrideSchema } from '../schemas/provider-models'

describe('service tier registry contract', () => {
  it('rejects a default outside the supported options and empty model overrides', () => {
    expect(
      RegistryEndpointConfigSchema.safeParse({
        requestControls: {
          serviceTier: {
            default: 'fast',
            options: ['standard', 'flex'],
            wire: {
              delivery: { type: 'provider-option', key: 'serviceTier' },
              values: { standard: 'default', fast: 'priority', flex: 'flex' }
            }
          }
        }
      }).success
    ).toBe(false)

    expect(
      ProviderModelOverrideSchema.safeParse({
        providerId: 'dashscope',
        modelId: 'qwen-flash',
        requestControls: { serviceTier: { options: [] } }
      }).success
    ).toBe(false)
  })
})
