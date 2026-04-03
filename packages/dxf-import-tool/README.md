## 转换脚本

### 使用方式

> 浏览器打开后，基于localStorage重新加载

```javascript
const g = await fetch('/demos/example.json').then((r) => r.json())
localStorage.setItem('pascal-editor-scene', JSON.stringify(g))
location.reload()
```

### 单楼层测试文件转换

``` shell
bun run src/dxf-to-scene.ts \
  --input "/Volumes/Ti600/Workspace/DEMO/Lucas/editor/Drawing1.dxf" \
  --out "/Volumes/Ti600/Workspace/DEMO/Lucas/editor/apps/editor/public/demos/example.json" \
  --merge-double-wall-lines \
  --max-walls 8000
```

### 多楼层测试文件转换

``` shell
bun run src/dxf-to-scene.ts \
  --input "/Volumes/Ti600/Workspace/DEMO/Lucas/editor/Drawing5.dxf" \
  --out "/Volumes/Ti600/Workspace/DEMO/Lucas/editor/apps/editor/public/demos/example.json" \
  --mapping-file layer-mapping.Drawing5.json \
  --merge-double-wall-lines \
  --max-walls 8000
```
