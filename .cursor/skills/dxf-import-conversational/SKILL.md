---
name: dxf-import-conversational
description: >-
  引导用户完成 DXF→Pascal 场景 JSON：预读（dxf-preview.sh）、确认 mapping 与 CLI、
  执行 dxf-to-scene；生成 JSON 后询问是否浏览器预览，按需检测 3002 端口并启动
  bun dev。适用于用户提供 .dxf、dxf-import-tool、mapping、图层预处理、floorPlan、
  或「确认后再转换 / 预览」时。
---

# DXF 交互式导入（Cursor / Claude Code）

## 目标

每次转换：**预读 → 用户确认 mapping（可改）→ 预读/建议 CLI → 用户确认参数 → 执行 `dxf-to-scene` → 告知输出 JSON 路径**；若用户需要预览，再执行 **§5 预览流程**。

## 1. 预读（必须先做）

**推荐（Skill 内入口，Claude Code 直接执行即可）**：从仓库根解析 `packages/dxf-import-tool`，无需手算路径。

```bash
bash .cursor/skills/dxf-import-conversational/scripts/dxf-preview.sh \
  --input "/绝对路径/图.dxf" --sample 10
```

若用户已有一份 mapping 草案：

```bash
bash .cursor/skills/dxf-import-conversational/scripts/dxf-preview.sh \
  --input "/绝对路径/图.dxf" \
  --mapping-file "/绝对路径/mapping.json" \
  --sample 10
```

**等价命令**（在仓库根目录）：

```bash
bun run packages/dxf-import-tool/src/dxf-preview.ts --input "/绝对路径/图.dxf" --sample 10
```

### 说明（能力与边界）

- **预读算法**（解析 DXF、统计、抽样）在 `packages/dxf-import-tool/src/dxf-preview.ts`；Skill **内置**的是**稳定调用入口** `scripts/dxf-preview.sh`，便于 Agent 在任意工作目录下一条命令得到结果。
- **Claude Code / Cursor Agent**：执行上述命令后，**读取 stdout 的 JSON**，据此向用户解释图层、抽样与 `cliHints`，并整理待确认的 CLI 参数——**不要在未运行命令时编造统计**。

将 **stdout 的 JSON** 作为事实来源：其中含门窗与墙段的**确定性抽样**（每类最多 `--sample` 条）、墙段长度分位数（米）、`cliHints`、`layerTableNames`、`layersInGeometry` 等。

## 2. 图层 mapping（第一次与用户确认）

1. 完整阅读并按步骤执行  
   `packages/dxf-import-tool/AGENT_LAYER_MAPPING_PROMPT.md`  
   输出根级含 `"version": 1`、`"layers"`，并尽量给出 `floorPlan`（多楼层时）。
2. 把 `dxf-preview` 中的图层名、几何层、门窗样本与 `openingBlockHistogramOther` 对齐到 `layers`，在对话里用简短中文说明**低置信度**的层。
3. **暂停**：请用户确认或逐条修改 mapping；用户改完后，将**最终** JSON 存成文件（例如 `layer-mapping.json`），必要时用该文件**重跑**上一节 `dxf-preview --mapping-file` 以刷新统计。

## 3. CLI 参数（第二次与用户确认）

阅读 `packages/dxf-import-tool/OPERATIONS.md` 中的参数表，并结合 `dxf-preview` 结果给出**可执行建议**，例如：

| 依据 | 建议项 |
|------|--------|
| `counts.wallMappedSegments`、`cliHints.suggestedMaxWalls` | `--max-walls` |
| `lengthDistributionWallSegmentsM`、`cliHints.noteMaxSegmentLengthM` | `--min-length-m`、`--max-segment-length-m` |
| `cliHints.noteMergeDoubleWall`、双线习惯 | `--merge-double-wall-lines` 及双线间距参数 |
| 坐标与左右习惯 | `--flip-x`（默认开启）或 `--no-flip-x`，必要时 `--flip-y` |
| 微抖动 | `--axis-snap-tolerance-m`（默认很小；`0` 关闭） |

只列出**与用户图纸相关的**参数，避免把 OPERATIONS 全文堆给用户；默认值未改动的可省略。

**暂停**：请用户确认或覆盖；得到明确同意后再跑转换命令。

## 4. 执行转换并交付

转换前若**已预判用户会预览**，建议将 `--out` 指到编辑器可静态访问的路径（与 `OPERATIONS.md`「在编辑器里加载」一致）：

- 推荐：`apps/editor/public/demos/<名称>.json`（仓库根目录下的相对路径，或等价绝对路径）。

```bash
bun run packages/dxf-import-tool/src/dxf-to-scene.ts \
  --input "/绝对路径/图.dxf" \
  --out "/绝对路径/…/apps/editor/public/demos/from-dxf.json" \
  --mapping-file "/绝对路径/layer-mapping.json" \
  …用户确认的其他参数…
```

成功后**明确回复输出 JSON 的绝对路径**；若用户需要，可补充节点规模或 `site.metadata` 中与坐标/翻转相关的字段。

## 5. 生成 JSON 后：是否预览（可选）

在 **§4 已成功生成 JSON** 之后，**必须询问用户**：「是否要在浏览器中预览转换结果？」

- **用户选择不预览**：结束本流程。
- **用户选择预览**，按顺序执行：

### 5.1 确保可通过 HTTP 访问该 JSON

若当前输出路径**不在** `apps/editor/public/demos/` 下，将文件复制到该目录（或让用户确认目标文件名），并记下 **URL 路径** `/demos/<文件名>.json`（文件名与最终文件一致）。

### 5.2 检测开发服务器（端口 3002）

本仓库编辑器由 `apps/editor` 的 `next dev --port 3002` 提供。在仓库根目录执行：

```bash
bash .cursor/skills/dxf-import-conversational/scripts/check-port-3002.sh
```

- **退出码 0**：3002 已有监听 → **不要**再启动 `bun dev`，告知用户直接打开 **http://localhost:3002**。
- **退出码非 0**：未监听 → 在**仓库根目录**后台启动开发服务器（持久任务）：

```bash
cd "/绝对路径/仓库根" && bun dev
```

待终端出现 Next 就绪日志后，再请用户打开 **http://localhost:3002**。

（等价检测，无需脚本时：`lsof -iTCP:3002 -sTCP:LISTEN -n -P` 有输出即视为已启动。）

### 5.3 在页面中加载场景

**优先（推荐）**：打开带 **query** 的编辑器首页，由应用自动 `fetch` 并写入 `localStorage`（见 `apps/editor` 与 `OPERATIONS.md`）。

- 仅 basename（自动补 `.json`）：

  `http://localhost:3002/?demo=<文件名不含路径>`

  例：`--out` 为 `…/apps/editor/public/demos/from-dxf.json` → 给用户 **`http://localhost:3002/?demo=from-dxf`**

- 或完整 demos 路径（需 URL 编码）：

  `http://localhost:3002/?scene=` + `encodeURIComponent('/demos/from-dxf.json')`

文件名含空格或特殊字符时，优先用 `scene` 参数或对 `demo` 的值做编码。

**备选**：若用户无法使用 query，再提供 `OPERATIONS.md` 中的 **Console** `fetch` + `localStorage` + `reload` 片段。

若预览时多楼层未竖向分开，首先检查 **JSON 是否含多个 `type: level` 节点**（取决于 mapping 里的 **`floorPlan`** 与 `dxf-to-scene` 导出）；非预览链接问题。可在编辑器工具栏切换 **Level Mode**（Stacked / Exploded 等）。

## 约束

- 在用户确认 mapping 与 CLI 前，**不要**执行 `dxf-to-scene.ts`。
- **仅在用户明确同意预览后**再启动 `bun dev`；启动前用 §5.2 检测 **3002** 是否已占用，已占用则**不得**重复启动。
- 不要编造 `dxf-preview` 未给出的统计；大图以 CLI 预读为准。
- 能力边界以 `OPERATIONS.md` 与 `AGENT_LAYER_MAPPING_PROMPT.md` 为准（例如 `floorPlan` 与 CLI 的衔接以仓库当前实现为准）。

## 参考文件（按需打开）

- `packages/dxf-import-tool/layer-mapping.example.json`
- `packages/dxf-import-tool/AGENT_LAYER_MAPPING_PROMPT.md`
- `packages/dxf-import-tool/OPERATIONS.md`
