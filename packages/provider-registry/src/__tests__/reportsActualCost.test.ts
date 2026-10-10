/**
 * Guards the `reportsActualCost` provider capability flag: defaults to false
 * for the remaining provider (bimhu) — it does not report actual cost.
 */

import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { ProviderListSchema } from '../schemas/provider'

describe('provider reportsActualCost', () => {
  it('defaults the remaining providers to false', () => {
    const raw = fs.readFileSync(new URL('../../data/providers.json', import.meta.url), 'utf-8')
    const { providers } = ProviderListSchema.parse(JSON.parse(raw))

    expect(providers.map((p) => p.id).sort()).toEqual(['bimhu'])
    for (const provider of providers) {
      expect(provider.reportsActualCost).toBe(false)
    }
  })
})
