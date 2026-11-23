# 实施计划：javdatabase 增量身高源

> 依据 `docs/design-height-sources.md`（已确认）。
> 每个任务 2–5 分钟，TDD：先写失败测试 → 看红 → 最少代码 → 看绿。

## 任务 1：抽取可测试的解析函数到 `tools/lib-javdatabase.mjs`

**文件**：新建 `tools/lib-javdatabase.mjs`

- `parseHeightFilterPage(html)` → `{ slugs: string[], nextPage: string|null }`
  - 抓 `/idols/<slug>/` 链接（排除 `/idols/?...` 筛选链接）
  - 抓 `<link rel="next" href="...">` 或分页里的下一页
- `parseIdolDetail(html)` → `{ jpName: string|null, height: number|null }`
  - `JP: 比留川マイ` → `jpName = '比留川マイ'`
  - `Height: 160 cm` → `height = 160`
  - 缺字段返回 null，不抛错
- `heightRange()` → `[133..190]`

**测试**：新建 `tools/test-javdatabase.mjs`
- 用真实 HTML 片段（取自实测页面）作为夹具
- 5 条断言：筛选页 slug 提取、next 链接、详情页 JP、详情页 height、缺字段容错
- **先跑测试确认全红**

## 任务 2：写抓取脚本 `tools/fetch-javdatabase-height.mjs`

**文件**：新建脚本，import 任务 1 的解析函数

- 参数：`--proxy http://127.0.0.1:21578`、`--delay 400`、`--resume`（默认）、`--merge-only`
- fetch 走代理：Node 原生 fetch 不支持 proxy，用 `undici` 的 `ProxyAgent`；
  检查项目是否已有 undici 依赖，没有则用 `https.request` 的 CONNECT 隧道实现，
  或退化为调用 curl（本机已验证 curl + `--proxy` 可用）。**优先 curl 子进程**，零新依赖。
- Phase 1：遍历身高段 → 筛选页 → 分页 → 收集 slug，写 `build/cache/javdatabase-links.json`
- Phase 2：逐个详情页，先查已有数据集（normalized name）→ 已知就跳过，不请求
- 产出 `build/javdatabase-cache.json`：`{ "日文名": 身高 }`
- 断点续传：已抓过的 slug 不重复；失败不覆盖旧缓存
- 限速 400ms，重试 3 次，出错明确提示代理

**测试**：在 `test-javdatabase.mjs` 加 2 条
- `--merge-only` 不发起任何网络请求（用假 slug 缓存跑通）
- 已知名字被跳过（构造已存在数据集）

## 任务 3：合并脚本接入新源

**文件**：改 `tools/merge-height-data.mjs`

- 新增 `JAVDB_PATH = build/javdatabase-cache.json`
- `loadJavDatabase()` 读取
- `tryAdd` 之前先加载 javdb 条目，**优先级排第二**（existing → javdb → avjoyudb → warashi）
- 只补缺失、不覆盖已有（现有 tryAdd 已实现）

**测试**：在 `test-javdatabase.mjs` 加 2 条
- 合并只补缺失、不覆盖已有身高
- 归一化后重名的不重复加入

## 任务 4：AN 加入忽略名单

**文件**：`src/userscript.template.js`

- `IGNORED_NAMES = ['AI', 'AN']`

**测试**：`tools/test-dom.mjs` 加 1 条
- 构造标题 `AN 破解` / `AN破解`，断言都不标注

## 任务 5：实跑增量抓取 + 合并 + 重建产物

- `node tools/fetch-javdatabase-height.mjs --proxy http://127.0.0.1:21578 --delay 400`
- 观察日志：链接数 / 新增数 / 跳过数
- `node tools/merge-height-data.mjs`
- `node tools/build-userscript.mjs`（版本号递增）
- 四套件全跑，确认无回归

## 任务 6：收尾（已完成）

- [x] 五套件全绿：27 / 64 / 10 / 7 / 12
- [x] `AN` 加入 `IGNORED_NAMES`，`AI` 彻底排除
- [x] 数据集 8191 → 8408，版本号 1.8.7，dist 重建
- [x] 记忆记录已合并推送 `61ca5a7`；当前仓库状态见 working tree（改动已暂存，待提交）
- [x] worktree 已清理（按 2026-11-20 日志）

> 待办：javdatabase 缓存只抓了 2756 个 slug 中的约 430 个，可断点续传：
> `node tools/fetch-javdatabase-height.mjs --proxy http://127.0.0.1:21578 --delay 40`
