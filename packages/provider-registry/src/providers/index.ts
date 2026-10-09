import p_bimhu from './bimhu'
import p_dashscope from './dashscope'
import type { Provider } from './types'

/** Every provider, in registry order. Source of truth for data/providers.json + data/provider-models.json. */
export const PROVIDERS: Provider[] = [p_bimhu, p_dashscope]
