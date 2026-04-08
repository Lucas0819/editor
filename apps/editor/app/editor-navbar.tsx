'use client'

/**
 * v2 top bar: fills `navbarSlot` so the layout matches the intended two-row shell
 * (navbar + sidebar/canvas) and surfaces shortcuts that are easy to miss when the
 * icon rail from v1 is absent.
 */
export function EditorNavbar() {
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-border/60 border-b bg-sidebar px-4 text-sidebar-foreground">
      <span className="font-semibold text-sm">Pascal Editor</span>
      <span className="text-muted-foreground text-xs">本地 · 场景自动保存到浏览器</span>
      <span className="ml-auto text-muted-foreground text-[11px]">⌘K 命令面板 · Esc 关闭</span>
    </header>
  )
}
