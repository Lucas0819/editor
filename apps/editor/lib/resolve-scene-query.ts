/**
 * 将 URL query 解析为可 fetch 的静态资源路径（仅限 public/demos 下的 JSON）。
 * 用于 Agent 将 dxf-to-scene 输出放到 apps/editor/public/demos/ 后，用链接预览。
 */

/** 单层 demos 文件名、无路径穿越、必须以 .json 结尾 */
const DEMOS_JSON_PATH = /^\/demos\/[^/]+\.json$/i

export function resolveDemosSceneFetchPath(searchParams: URLSearchParams): string | null {
  const rawScene = searchParams.get('scene')
  if (rawScene) {
    let path = decodeURIComponent(rawScene.trim())
    if (!path.startsWith('/')) {
      path = `/${path}`
    }
    if (path.includes('..')) {
      return null
    }
    if (!DEMOS_JSON_PATH.test(path)) {
      return null
    }
    return path
  }

  const demo = searchParams.get('demo')
  if (demo) {
    const base = decodeURIComponent(demo.trim())
    if (!base || /[/\\]/.test(base) || base.includes('..')) {
      return null
    }
    const file = /\.json$/i.test(base) ? base : `${base}.json`
    const path = `/demos/${file}`
    if (!DEMOS_JSON_PATH.test(path)) {
      return null
    }
    return path
  }

  return null
}
