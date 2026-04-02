/**
 * DXF 图层名（含 xref 长前缀）→ Pascal 场景语义映射。
 * 与 `packages/dxf-import-tool/LAYERS.md` 中「图纸图层类型 → Pascal 场景类型」表一致，供转换管线按图层分流。
 *
 * `dxf-to-scene` 按 `target.kind` 生成对应 Pascal 节点（`wall` / `window` / `door` / `item` / `zone` / `slab` / `roof`）；`skip` 与 `annotation` 不生成实体。
 */

/** 与编辑器 `CatalogCategory`（{@link packages/editor/src/store/use-editor.tsx}）对齐，避免 dxf 包依赖 editor */
export type ItemCatalogCategoryHint =
  | 'furniture'
  | 'appliance'
  | 'bathroom'
  | 'kitchen'
  | 'outdoor'
  | 'window'
  | 'door'
  | 'unspecified'

export type DxfLayerPascalTarget =
  | {
      kind: 'wall'
      /** 柱、幕墙等是否仍用墙段表达 */
      variant?: 'default' | 'column_outline'
    }
  | { kind: 'window' }
  | { kind: 'door' }
  | { kind: 'item'; catalog: ItemCatalogCategoryHint }
  | { kind: 'zone' }
  | { kind: 'slab' }
  | { kind: 'roof' }
  /** 文字、填充、尺寸等：默认不参与墙体重建 */
  | { kind: 'annotation' }
  | { kind: 'skip' }

export type DxfLayerMapping = {
  target: DxfLayerPascalTarget
  /** high：命名与专业一致；medium：需结合几何；low：仅作占位 */
  confidence: 'high' | 'medium' | 'low'
}

/** 用于 Scene JSON `name` 的简短中文标签（与 `kind` 对应） */
export function dxfTargetDisplayName(target: DxfLayerPascalTarget): string {
  switch (target.kind) {
    case 'wall':
      return target.variant === 'column_outline' ? '柱' : '墙'
    case 'window':
      return '窗'
    case 'door':
      return '门'
    case 'item': {
      const c = target.catalog
      if (c === 'bathroom') return '卫浴'
      if (c === 'appliance') return '设备'
      if (c === 'furniture') return '家具'
      if (c === 'kitchen') return '厨房'
      if (c === 'outdoor') return '室外'
      if (c === 'window') return '窗（物品）'
      if (c === 'door') return '门（物品）'
      return '物品'
    }
    case 'zone':
      return '区域'
    case 'slab':
      return '板洞'
    case 'roof':
      return '屋面'
    case 'annotation':
      return '标注'
    case 'skip':
      return '忽略'
  }
}

/** 写入 `metadata.dxfPascalTarget` 的 JSON 安全对象 */
export function dxfTargetToJson(target: DxfLayerPascalTarget): Record<string, unknown> {
  switch (target.kind) {
    case 'wall':
      return { kind: 'wall', variant: target.variant ?? 'default' }
    case 'item':
      return { kind: 'item', catalog: target.catalog }
    default:
      return { kind: target.kind }
  }
}

/**
 * DXF 线段 → 墙节点展示名：`{语义} · {规范层名}`
 */
export function dxfWallNodeDisplayName(layer: string, mapping: DxfLayerMapping): string {
  const can = canonicalDxfLayerName(layer)
  const label = dxfTargetDisplayName(mapping.target)
  return `${label} · ${can}`
}

/**
 * 去掉 xref/绑定路径前缀，得到「规范层名」候选（取最后一个 `$` 之后）。
 * 若无 `$`，返回去首尾空白的原字符串。
 */
export function canonicalDxfLayerName(fullLayerName: string): string {
  const t = fullLayerName.trim()
  const i = t.lastIndexOf('$')
  return i >= 0 ? t.slice(i + 1) : t
}

/**
 * 根据规范层名（或完整层名，会先 canonicalize）推断 Pascal 侧语义。
 * 规则按 **更具体的模式优先** 顺序匹配。
 */
export function mapDxfLayerToPascal(
  layerName: string,
  opts?: { alreadyCanonical?: boolean },
): DxfLayerMapping {
  const c = opts?.alreadyCanonical ? layerName.trim() : canonicalDxfLayerName(layerName)

  const rules: Array<{ when: (s: string) => boolean; map: DxfLayerMapping }> = [
    { when: (s) => s === '0' || /^defpoints$/i.test(s), map: { target: { kind: 'skip' }, confidence: 'high' } },
    { when: (s) => s === '洁具' || /^LATRINE$/i.test(s) || /A-PLAN-LVTRY/i.test(s), map: { target: { kind: 'item', catalog: 'bathroom' }, confidence: 'high' } },
    { when: (s) => /房间编号/.test(s), map: { target: { kind: 'annotation' }, confidence: 'high' } },
    { when: (s) => /板空洞/.test(s), map: { target: { kind: 'slab' }, confidence: 'medium' } },
    { when: (s) => /A-ROOF-DRAN|A-屋面|ROOF/i.test(s), map: { target: { kind: 'roof' }, confidence: 'medium' } },
    { when: (s) => /P-FIRE|M-H-|M-V-|散热器|排风管|消火栓/i.test(s), map: { target: { kind: 'item', catalog: 'appliance' }, confidence: 'medium' } },
    /** 填充图案层（HATCH），不参与墙/空间等几何转换 */
    { when: (s) => /PUB_HATCH|A-ANNO-PUB-HATCH/i.test(s), map: { target: { kind: 'skip' }, confidence: 'high' } },
    /**
     * 承重柱（平面多为正方形四边）：用墙段表达，须在 ANNO|TEXT 等宽泛规则之前匹配。
     * 常见名：A-COLU、COLUMN、COLU、中文「承重柱」「结构柱」。
     */
    {
      when: (s) => /A-COLU|COLUMN|COLU|承重柱|结构柱/i.test(s),
      map: { target: { kind: 'wall', variant: 'column_outline' }, confidence: 'medium' },
    },
    /**
     * 纯数字楼层图层（与 OPERATIONS 默认 `--layer-regex`「图层\\s*(\\d+)」配套）：无专业 A-WALL 前缀时仍出墙线。
     * 若某层混有非墙几何，需改用专业图层名或后续管线细分。
     */
    { when: (s) => /^图层\s*\d+$/.test(s.trim()), map: { target: { kind: 'wall' }, confidence: 'low' } },
    { when: (s) => /ANNO|文字|E-GENE|TEXT/i.test(s), map: { target: { kind: 'annotation' }, confidence: 'high' } },
    { when: (s) => /A-WIND-TEXT|WINDOW_TEXT/i.test(s), map: { target: { kind: 'annotation' }, confidence: 'high' } },
    { when: (s) => /A-WALL-MOVE|A-WALL|^WALL$/i.test(s), map: { target: { kind: 'wall' }, confidence: 'high' } },
    /** 楼梯平面多为踏步线脚，非结构墙；与 LAYERS.md §5.4 一致，墙体专用管线不生成节点 */
    { when: (s) => /A-PLAN-STAIR|STAIR/i.test(s), map: { target: { kind: 'annotation' }, confidence: 'medium' } },
    { when: (s) => /A-PLAN-EVTR|EVTR|ELEV/i.test(s), map: { target: { kind: 'annotation' }, confidence: 'low' } },
    {
      when: (s) => /^(?:WINDOW|A-WIND)$/i.test(s),
      map: { target: { kind: 'window' }, confidence: 'high' },
    },
    { when: (s) => /DOOR|A-DOOR/i.test(s), map: { target: { kind: 'door' }, confidence: 'medium' } },
    {
      when: (s) => /^(?:A-)?WALL(?:$|-)/i.test(s) || /^WALL$/i.test(s),
      map: { target: { kind: 'wall' }, confidence: 'medium' },
    },
  ]

  for (const { when, map } of rules) {
    if (when(c)) {
      return map
    }
  }

  return { target: { kind: 'annotation' }, confidence: 'low' }
}

/**
 * 合并键：完整图层名（trim）与 `canonicalDxfLayerName` 可能对应同一映射，便于 xref 长名与短名共用一条配置。
 */
export function resolveLayerMapping(
  layerName: string,
  overrides: Map<string, DxfLayerMapping> | null,
): DxfLayerMapping {
  if (overrides && overrides.size > 0) {
    const trimmed = layerName.trim()
    const direct = overrides.get(trimmed)
    if (direct) {
      return direct
    }
    const canon = canonicalDxfLayerName(layerName)
    const byCanon = overrides.get(canon)
    if (byCanon) {
      return byCanon
    }
  }
  return mapDxfLayerToPascal(layerName)
}

function isItemCatalogCategoryHint(x: string): x is ItemCatalogCategoryHint {
  return (
    x === 'furniture' ||
    x === 'appliance' ||
    x === 'bathroom' ||
    x === 'kitchen' ||
    x === 'outdoor' ||
    x === 'window' ||
    x === 'door' ||
    x === 'unspecified'
  )
}

/** 从 JSON 的 `target` 对象解析为 `DxfLayerPascalTarget`（用于 mapping 文件校验）。 */
export function parseDxfLayerPascalTargetFromJson(raw: unknown): DxfLayerPascalTarget {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('target must be a non-null object')
  }
  const o = raw as Record<string, unknown>
  const kind = o.kind
  if (kind === 'wall') {
    const v = o.variant
    if (v === undefined) {
      return { kind: 'wall' }
    }
    if (v === 'default' || v === 'column_outline') {
      return { kind: 'wall', variant: v }
    }
    throw new Error(`wall.variant must be "default" | "column_outline", got ${String(v)}`)
  }
  if (kind === 'item') {
    const c = o.catalog
    if (typeof c !== 'string' || !isItemCatalogCategoryHint(c)) {
      throw new Error(`item.catalog must be a valid ItemCatalogCategoryHint, got ${String(c)}`)
    }
    return { kind: 'item', catalog: c }
  }
  if (
    kind === 'window' ||
    kind === 'door' ||
    kind === 'zone' ||
    kind === 'slab' ||
    kind === 'roof' ||
    kind === 'annotation' ||
    kind === 'skip'
  ) {
    return { kind }
  }
  throw new Error(`unknown target.kind: ${String(kind)}`)
}

function parseConfidence(raw: unknown): 'high' | 'medium' | 'low' {
  if (raw === 'high' || raw === 'medium' || raw === 'low') {
    return raw
  }
  throw new Error(`confidence must be "high" | "medium" | "low", got ${String(raw)}`)
}

export type ParsedDxfLayerMappingFile = {
  map: Map<string, DxfLayerMapping>
  /** `layers` 对象中的条目数（不含为 canonical 名自动追加的键） */
  layerCount: number
}

/**
 * 解析 mapping 文件 JSON：`{ "version": 1, "layers": { "<layerName>": { "target": …, "confidence": … } } }`
 * 每个键会同时注册 trim 后的全名与 canonical 名（若不同），便于与 DXF 中 xref 前缀一致或省略。
 */
export function parseDxfLayerMappingFileJson(text: string): ParsedDxfLayerMappingFile {
  let root: unknown
  try {
    root = JSON.parse(text) as unknown
  } catch (e) {
    throw new Error(`mapping file: invalid JSON (${e instanceof Error ? e.message : String(e)})`)
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('mapping file: root must be an object')
  }
  const obj = root as Record<string, unknown>
  const layers = obj.layers
  if (layers === null || typeof layers !== 'object' || Array.isArray(layers)) {
    throw new Error('mapping file: "layers" must be an object')
  }
  const layerEntries = Object.entries(layers as Record<string, unknown>)
  const out = new Map<string, DxfLayerMapping>()
  for (const [key, entry] of layerEntries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`mapping file: layers["${key}"] must be an object`)
    }
    const e = entry as Record<string, unknown>
    const target = parseDxfLayerPascalTargetFromJson(e.target)
    const confidence = parseConfidence(e.confidence)
    const mapping: DxfLayerMapping = { target, confidence }
    const trimmed = key.trim()
    out.set(trimmed, mapping)
    const canon = canonicalDxfLayerName(key)
    if (canon !== trimmed) {
      out.set(canon, mapping)
    }
  }
  return { map: out, layerCount: layerEntries.length }
}
