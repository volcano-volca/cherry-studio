import { useEffect, useMemo } from 'react'

import { usePreference } from '@data/hooks/usePreference'
import { loggerService } from '@logger'
import {
  CORE_SIDEBAR_SHORTCUT_PROVIDERS,
  SidebarShortcutRegistry,
  SidebarShortcutRegistryProvider
} from '@renderer/components/app/sidebarShortcuts'
import { CodeStyleProvider } from '@renderer/components/CodeStyleProvider'
import { CommandContextKeyProvider, CommandProvider } from '@renderer/components/command'
import { ConversationNotificationRuntime } from '@renderer/components/ConversationNotificationRuntime'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { AppShell } from '@renderer/components/layout/AppShell'
import { TabsProvider } from '@renderer/components/layout/TabsProvider'
import { MandatoryGateProvider } from '@renderer/components/MandatoryGateProvider'
import { McpInteractionHost } from '@renderer/components/McpInteractionHost'
import { PopupHost } from '@renderer/components/PopupHost'
import { ThemeProvider } from '@renderer/components/ThemeProvider'
import ToastHost from '@renderer/components/ToastHost'
import { WindowFatalFallback } from '@renderer/components/WindowFatalFallback'
import { useMainWindowNavigation } from '@renderer/hooks/tab'
import { useIsPrivacyUpdateRequired } from '@renderer/hooks/useIsPrivacyUpdateRequired'
import { useStorageMonitorNotification } from '@renderer/hooks/useStorageMonitorNotification'
import { useWindowRuntime } from '@renderer/hooks/useWindowRuntime'
import { registerImageModeChooser } from '@renderer/services/imageExportModeChooser'
import { getSidebarDefaultLandingUrl } from '@renderer/utils/sidebar'
import type { Tab } from '@shared/data/cache/cacheValueTypes'

import { useAppUpdateHandler } from './hooks/useAppUpdateHandler'
import { useAutoBackupEvents } from './hooks/useAutoBackupEvents'
import { useTopicNamingErrorNotification } from './hooks/useTopicNamingErrorNotification'
import { PrivacyPolicyUpdateGate } from './privacy/PrivacyPolicyUpdateGate'

const logger = loggerService.withContext('MainApp')

// Behavior leaf inside the providers: the shared window runtime plus the main-only
// concerns, then the popup/toast hosts. It sits inside the providers but outside every
// TabRouter/<Activity>, so these window-scoped subscriptions and DOM sync are never
// torn down when a background tab hides.
//
// useAppUpdateHandler / useAutoBackupEvents / useStorageMonitorNotification / useTopicNamingErrorNotification are
// intentionally main-only (update events only reach the main window; the storage warning and
// topic-naming-failed toast must not duplicate across windows) and intentionally React hooks:
// they depend on React-visible
// cache/toast state and manage their own effect cleanup, and the renderer has no
// service lifecycle container, so a service would only add manual start/stop.
//
// Headless: it runs hooks and renders nothing. The popup/toast hosts are explicit
// siblings in the App JSX below, so a window's host composition is visible there.
function MainWindowRuntime(): null {
  useWindowRuntime()
  useMainWindowNavigation()

  // Register the real (component-layer) image-mode popup behind the services seam.
  // subWindow registers the same effect (SubWindowApp) — detached tabs render the
  // same route tree and can export too; other windows never reach these exports.
  useEffect(() => {
    registerImageModeChooser((imageCount) =>
      import('@renderer/components/MarkdownImageExportPopup').then((m) => m.default.show({ imageCount }))
    )
  }, [])

  // Main-only: tear down the HTML boot spinner and end the `init` timer. Both are
  // paired with markup only main/index.html creates (`#spinner`, `console.time`), so
  // this must never run in another window.
  useEffect(() => {
    document.getElementById('spinner')?.remove()
    // Paired with `console.time('init')` in index.html's bootstrap script; a DevTools
    // timer for dev DX, not a production log — loggerService is not apt.
    // eslint-disable-next-line no-restricted-syntax
    console.timeEnd('init')
  }, [])

  useAppUpdateHandler()
  useAutoBackupEvents()
  useStorageMonitorNotification()
  useTopicNamingErrorNotification()

  return null
}

export function MainWindowContent(): React.ReactElement {
  const [providerSetupStatus] = usePreference('app.onboarding.provider_setup.status')
  const [sidebarShortcuts] = usePreference('ui.sidebar_shortcut')
  const [defaultPaintingProvider] = usePreference('feature.paintings.default_provider')
  const sidebarShortcutRegistry = useMemo(() => new SidebarShortcutRegistry(CORE_SIDEBAR_SHORTCUT_PROVIDERS), [])
  const privacyUpdateRequired = useIsPrivacyUpdateRequired()
  // Onboarding collects privacy consent itself, so the gate only owns the window afterwards.
  const privacyGateOpen = providerSetupStatus !== 'pending' && privacyUpdateRequired

  const initialDefaultTab = useMemo<Tab>(
    () => ({
      id: 'home',
      type: 'route',
      url: getSidebarDefaultLandingUrl(sidebarShortcuts, defaultPaintingProvider) || '/app/launchpad',
      title: '',
      lastAccessTime: Date.now(),
      isDormant: false
    }),
    [defaultPaintingProvider, sidebarShortcuts]
  )

  return (
    <TabsProvider initialDefaultTab={initialDefaultTab}>
      <SidebarShortcutRegistryProvider registry={sidebarShortcutRegistry}>
        <MandatoryGateProvider open={privacyGateOpen}>
          {/* BimhuChat: dedicated app, skip provider-setup onboarding entirely */}
          <AppShell />
          <MainWindowRuntime />
          <ConversationNotificationRuntime />
          <McpInteractionHost />
          <PopupHost />
          <ToastHost />
          <PrivacyPolicyUpdateGate />
        </MandatoryGateProvider>
      </SidebarShortcutRegistryProvider>
    </TabsProvider>
  )
}

function MainApp(): React.ReactElement {
  logger.info('MainApp initialized')

  return (
    // The boundary must stay the ANCESTOR of every provider so a provider throwing
    // during render (e.g. reading preferences) falls back instead of white-screening.
    <ErrorBoundary fallbackComponent={WindowFatalFallback}>
      <ThemeProvider>
        <CodeStyleProvider>
          <CommandContextKeyProvider>
            <CommandProvider>
              <MainWindowContent />
            </CommandProvider>
          </CommandContextKeyProvider>
        </CodeStyleProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default MainApp
