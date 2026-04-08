# DXF → Pascal 场景：操作说明

## 功能

将 ASCII DXF 中 **LINE**、**LWPOLYLINE**（拆成相邻边）转为 Pascal 编辑器的 **SceneGraph JSON**（`Site → Building → Level → Wall`），用于快速在三维里查看平面几何（每段线对应一堵竖直墙）。

## 环境

- 仓库根目录已安装 [Bun](https://bun.sh)。
- 无需额外 `npm install`（本工具无第三方依赖）。

## 预读（转换前）

在跑 `dxf-to-scene` 之前，可用 CLI 对图纸做**统计与抽样**（图层表、墙段长度分位数、门窗 INSERT 各若干条），供与用户确认 mapping 与参数。输出为 **JSON**（stdout 重定向即可）：

**方式 A（推荐，Skill 内脚本，自动定位仓库根）：**

```bash
bash /path/to/editor/.cursor/skills/dxf-import-conversational/scripts/dxf-preview.sh \
  --input "/path/to/图纸.dxf" \
  [--mapping-file "/path/to/layer-mapping.json"] \
  [--sample 10]
```

**方式 B（直接调包内入口）：**

```bash
bun run /path/to/editor/packages/dxf-import-tool/src/dxf-preview.ts \
  --input "/path/to/图纸.dxf" \
  [--mapping-file "/path/to/layer-mapping.json"] \
  [--sample 10]
```

- `--sample`：每类（门 INSERT、窗 INSERT、映射为墙之线段）最多抽样条数，默认 `10`。  
- 与 **`.cursor/skills/dxf-import-conversational/SKILL.md`** 配合时，Agent 可先执行 **方式 A** 再进入确认流程；stdout 为 JSON，供 Claude Code 解析并整理参数建议。

## 命令

在任意目录执行均可，建议使用**绝对路径**指向 DXF 与输出 JSON。

```bash
bun run /path/to/editor/packages/dxf-import-tool/src/dxf-to-scene.ts \
  --input "/path/to/图纸.dxf" \
  --out "/path/to/editor/apps/editor/public/demos/from-dxf.json" \
  --max-walls 8000
```

### 常用参数

| 参数 | 说明 |
|------|------|
| `--input` / `-i` | DXF 文件路径（必填） |
| `--out` / `-o` | 输出的 SceneGraph JSON 路径（默认 `scene-from-dxf.json`） |
| `--max-walls` | 最多生成多少堵墙（避免一次实体过多） |
| `--min-length-m` | 忽略短于该长度（米）的线段，默认 `0.02` |
| `--wall-height` | 墙高（米），默认 `3` |
| `--wall-thickness` | 墙厚（米），默认 `0.15` |
| `--no-offset` | 不使用 `$EXTMIN` 平移原点（默认会平移，减小坐标数值） |
| `--scale-to-meters` | 手动指定「图纸单位 → 米」的乘数（覆盖 HEADER 里 `$INSUNITS` 的换算） |
| `--axis-snap-tolerance-m` | 在**米制**下：纵向偏差小于容差则视为水平并拉直；横向同理视为垂直。默认 `0.0001`（0.1 mm）；传 `0` 关闭 |
| `--flip-x` | 在米制坐标上对 **DXF X** 取反后再写入墙的 `start`/`end` 第一个分量（Pascal 世界 **X**）。**默认已启用**（不写参数也等价于翻转），与常见 CAD 顶视与编辑器透视下的左右关系一致 |
| `--no-flip-x` | 关闭上述 X 翻转，与 DXF 原始 X 同号 |
| `--flip-y` | 对 **DXF Y** 取反后再写入第二个分量（Pascal 世界 **Z**）。默认关闭 |
| `--no-flip-y` | 显式关闭 Y 翻转（默认即为关闭，一般无需写） |
| `--mapping-file` / `-m` | 图层语义 **覆盖** JSON。与内置 `mapDxfLayerToPascal` 合并：先按图层名（完整 trim，再试 canonical，见 `canonicalDxfLayerName`）查表，未命中则回退内置规则 |
| `--merge-double-wall-lines` | 将**同楼层、同规范图层名**下、互相平行且间距在「双线墙厚」范围内的线段合并为**一条中心线墙**，`thickness` 取两线在平面上的间距（解决 CAD 双线画墙厚、导入后变两堵墙的问题） |
| `--double-wall-min-spacing-m` | 与上一项连用：视为双线的最小间距（米），默认 `0.02`（过滤噪声） |
| `--double-wall-max-spacing-m` | 最大间距（米），默认 `0.65`；超过则认为是两堵独立墙 |
| `--double-wall-min-overlap-m` | 两线在墙方向上的投影重叠至少多长（米）才合并，默认 `0.04` |

当前导出为**单层**（所有墙在同一 `Level`，`level` 字段为 `0`）。

**`--mapping-file` 格式**（`target` / `confidence` 与 `dxf-layer-mapping.ts` 中类型一致）：

```json
{
  "version": 1,
  "layers": {
    "A-CUSTOM-WALL": {
      "target": { "kind": "wall" },
      "confidence": "high"
    },
    "ELEV-PIT": {
      "target": { "kind": "annotation" },
      "confidence": "medium"
    }
  }
}
```

### 墙节点命名与图层语义

每个墙段会按 **`dxf-layer-mapping.ts`** 规则写入：

- **`name`**：`{中文语义} · {规范层名}`。
- **`type`**：按图层映射规则生成 **`wall` / `window` / `door` / `item` / `zone` / `slab` / `roof`**（见 `dxf-layer-mapping.ts`）；**`skip`** 与 **`annotation`** 图层不生成节点。
- **`metadata`**：`layer`、`dxfLayerCanonical`、`dxfPascalTarget`、`dxfMappingConfidence`。
- **`skip`**（如 `PUB_HATCH`）与 **`annotation`** 的线段计入 `site.metadata.skippedSemanticLayerSegments`。

### 可选：按长度过滤线段

若需去掉场地边界等超长边线，可**显式**传入 `--max-segment-length-m <米>`（例如 `60`）。**默认不启用**（等价于不限制长度）。

## 单位与坐标

- 从 DXF **HEADER** 读取 `$INSUNITS`（例如 `4` = 毫米），再换算为米。
- 默认对 XY **减去 `$EXTMIN`**，使场景落在原点附近。
- DXF 平面 **(x, y)** 对应 Pascal 楼层平面 **(start[0], start[1])**，即世界 **X** 与 **Z**。默认 **`--flip-x` 生效**（对 DXF x 取反）；若与图纸不一致，可加 **`--no-flip-x`** 或按需加 **`--flip-y`**。Site 的 `metadata` 中会记录 `flipX` / `flipY`。

## 在编辑器里加载

1. 将生成的 JSON 放到 **`apps/editor/public/demos/`**（例如 `from-dxf.json`）。Agent 完成 `dxf-to-scene` 时应优先使用 `--out` 指向该目录，便于预览。
2. 启动编辑器（仓库根目录 `bun dev`，默认 **http://localhost:3002**）。

### 方式 A：URL query（推荐，适合 Agent 给用户一条链接）

仅允许加载 **`/demos/` 下单层 `.json` 文件**（防路径穿越）。

| 参数 | 说明 | 示例 URL |
|------|------|----------|
| `demo` | 仅文件名（可含空格等），缺省补 `.json` | `http://localhost:3002/?demo=from-dxf` → 请求 `/demos/from-dxf.json` |
| `scene` | 完整静态路径，必须以 `/demos/` 开头、以 `.json` 结尾 | `http://localhost:3002/?scene=%2Fdemos%2Ffrom-dxf.json` |

成功加载后，场景会写入 `localStorage`（`pascal-editor-scene`），与下方方式 B 持久化行为一致。

多楼层竖向堆叠依赖 **SceneGraph 内存在多个 `level` 节点**（由 `dxf-to-scene` 与 mapping 中的 **`floorPlan`** 决定），与上述 URL 参数无关；若 JSON 只有一层，需在图层 mapping 中修正 `floorPlan` 后重新导出。

### 方式 B：Console（无 query 或需覆盖本地缓存时）

浏览器开发者工具 **Console** 执行：

```js
const g = await fetch('/demos/from-dxf.json').then((r) => r.json())
localStorage.setItem('pascal-editor-scene', JSON.stringify(g))
location.reload()
```

## 图层与命名（转换匹配）

- 从 DXF **图层表**读取名称、常见 **工程前缀 / `$` 分隔 / 专业前缀** 的说明，见同目录 **[LAYERS.md](./LAYERS.md)**。
- **图纸图层 ↔ Pascal 节点 / 物品 category** 的对应表与 **`mapDxfLayerToPascal()`**，见 [LAYERS.md](./LAYERS.md) 第 5 节与 `src/dxf-layer-mapping.ts`。

## 门窗（INSERT 块）

- 解析 **ENTITIES** 中的 **INSERT**（含天正等带 **ATTRIB** / **SEQEND** 的块参照），按块名识别：
  - **窗**：`WIN2D`、`TCHSYS$WIN` 等；
  - **门**：`DorLib`、`DOOR2D` 等。
- 与 **墙线段**（同坐标变换与轴对齐）做关联：插入点投影到墙中心线、**宽度**取 `max(|41|,|42|)`×图纸单位→米（与 `$INSUNITS` 一致）。
- **优先**落在已有墙段上：在父墙 `children` 中生成 `window` / `door`（墙局部坐标与 `example/墙体内有门和窗.json` 默认一致：窗高 1.5m、中心 1.5m；门高 2.1m、中心 1.05m）。
- **若**无法贴墙（无墙或偏离过大）：用最近墙方向生成**短墙**再挂门/窗（`metadata.dxfOpeningSyntheticWall`）。
- 柱块 **INSERT**（图层映射为 `column_outline`）由 `dxf-column-inserts.ts` 转为**单根墙**（对边中点连线 + 厚度 `|sy|×` 比例→米）；若图纸用 **LINE/LWPOLYLINE** 画**轴对齐矩形**四条边，同模块会将四边**合并**为一条并写入 `columnThicknessM`，不参与门窗匹配。

## 限制

- 仅解析 **LINE / LWPOLYLINE**；块参照中除**柱 INSERT**与**上述门窗块**外，其它块未展开。
- 结果为「竖直墙条 + 门窗洞口」可视化，不是完整 BIM（房间、屋顶等需另建管线）。
