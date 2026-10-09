import { describe, expect, it } from 'vitest'

import { PROVIDERS } from '../providers'

const provider = (providerId: string) => {
  const result = PROVIDERS.find(({ id }) => id === providerId)
  if (!result) throw new Error(`Missing provider: ${providerId}`)
  return result
}

const override = (providerId: string, modelId: string) => {
  const result = provider(providerId).overrides?.find((entry) => entry.modelId === modelId)
  if (!result) throw new Error(`Missing override: ${providerId}/${modelId}`)
  return result
}

describe('provider reasoning contracts', () => {
  // `auto` is the one selection no model validates, so the serializer projects a profile's automatic
  // tier onto the model's declared efforts. A tier buried in a literal operation is invisible to it
  // and reaches the wire unchecked — which is how Kimi K3 received `medium` and returned 400 (#20029).
  it('declares every automatic effort tier through effortMap, never as a literal', () => {
    const tiers = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    const offenders: string[] = []

    for (const entry of PROVIDERS) {
      const wires = [
        ...Object.entries(entry.endpointConfigs ?? {}).map(
          ([endpoint, config]) => [`${entry.id}/${endpoint}`, config.reasoningFormat?.wire] as const
        ),
        ...(entry.overrides ?? []).flatMap((model) =>
          Object.entries(model.reasoningContracts ?? {}).map(
            ([endpoint, contract]) => [`${entry.id}/${model.modelId}/${endpoint}`, contract.wire] as const
          )
        )
      ]

      for (const [label, wire] of wires) {
        for (const operation of wire?.auto?.operations ?? []) {
          if (operation.value.source === 'literal' && tiers.has(String(operation.value.value))) {
            offenders.push(`${label} → ${operation.target}=${operation.value.value}`)
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('keeps DashScope Kimi K3 reasoning within the provider-supported effort vocabulary', () => {
    const dashscopeSupport = override('dashscope', 'kimi-k3').reasoningContracts?.['openai-chat-completions']?.support

    expect(dashscopeSupport?.controls).toEqual([{ default: 'max', kind: 'effort', values: ['none', 'max'] }])
  })

  it.each(['qwen3-coder', 'qwen3-coder-next'])('does not declare a DashScope reasoning contract for %s', (modelId) => {
    expect(
      provider('dashscope').overrides?.some((entry) => entry.modelId === modelId && entry.reasoningContracts)
    ).toBe(false)
  })
})
