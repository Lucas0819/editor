'use client'

import {
  Editor,
  loadSceneFromLocalStorage,
  type SceneGraph,
  type SidebarTab,
  saveSceneToLocalStorage,
  ViewerToolbarLeft,
  ViewerToolbarRight,
} from '@pascal-app/editor'
import { useSearchParams } from 'next/navigation'
import { type ComponentType, Suspense, useCallback } from 'react'
import { resolveDemosSceneFetchPath } from '../lib/resolve-scene-query'

const SIDEBAR_TABS: (SidebarTab & { component: ComponentType })[] = [
  {
    id: 'site',
    label: 'Scene',
    component: () => null, // Built-in SitePanel handles this
  },
]

function HomeEditor() {
  const searchParams = useSearchParams()

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
        projectId="local-editor"
        sidebarTabs={SIDEBAR_TABS}
        viewerToolbarLeft={<ViewerToolbarLeft />}
        viewerToolbarRight={<ViewerToolbarRight />}
        onLoad={onLoad}
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
