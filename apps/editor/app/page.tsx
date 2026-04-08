'use client'

import {
  Editor,
  loadSceneFromLocalStorage,
  type SceneGraph,
  type SidebarTab,
  saveSceneToLocalStorage,
  type SettingsPanelProps,
  type SitePanelProps,
  ViewerToolbarLeft,
  ViewerToolbarRight,
} from '@pascal-app/editor'
import { useSearchParams } from 'next/navigation'
import { type ComponentType, Suspense, useCallback, useMemo } from 'react'
import { EditorNavbar } from './editor-navbar'
import { resolveDemosSceneFetchPath } from '../lib/resolve-scene-query'

/** Matches SettingsPanel local heuristic — enables site/settings integration without cloud APIs. */
const LOCAL_PROJECT_ID = 'local-editor'

const SIDEBAR_TABS: (SidebarTab & { component: ComponentType })[] = [
  {
    id: 'site',
    label: 'Scene',
    component: () => null, // Built-in SitePanel handles this
  },
  {
    id: 'settings',
    label: 'Settings',
    component: () => null, // Built-in SettingsPanel handles this (Export GLB, etc.)
  },
]

function HomeEditor() {
  const searchParams = useSearchParams()

  const sitePanelProps = useMemo<SitePanelProps>(
    () => ({
      projectId: LOCAL_PROJECT_ID,
    }),
    [],
  )

  const settingsPanelProps = useMemo<SettingsPanelProps>(
    () => ({
      projectId: LOCAL_PROJECT_ID,
    }),
    [],
  )

  const onSave = useCallback(async (scene: SceneGraph) => {
    saveSceneToLocalStorage(scene)
  }, [])

  const onLoad = useCallback(async (): Promise<SceneGraph | null> => {
    const path = resolveDemosSceneFetchPath(searchParams)
    if (path) {
      const res = await fetch(path, { cache: 'no-store' })
      if (!res.ok) {
        console.error(`[editor] Scene fetch failed: ${path} (${res.status})`)
        return loadSceneFromLocalStorage()
      }
      try {
        const g = (await res.json()) as SceneGraph
        saveSceneToLocalStorage(g)
        return g
      } catch (e) {
        console.error('[editor] Scene JSON parse failed:', e)
        return loadSceneFromLocalStorage()
      }
    }
    return loadSceneFromLocalStorage()
  }, [searchParams])

  return (
    <div className="h-screen w-screen">
      <Editor
        layoutVersion="v2"
        navbarSlot={<EditorNavbar />}
        projectId={LOCAL_PROJECT_ID}
        settingsPanelProps={settingsPanelProps}
        sidebarTabs={SIDEBAR_TABS}
        sitePanelProps={sitePanelProps}
        viewerToolbarLeft={<ViewerToolbarLeft />}
        viewerToolbarRight={<ViewerToolbarRight />}
        onLoad={onLoad}
        onSave={onSave}
      />
    </div>
  )
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen w-screen items-center justify-center bg-background text-muted-foreground text-sm">
          Loading editor…
        </div>
      }
    >
      <HomeEditor />
    </Suspense>
  )
}
