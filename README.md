# issue-tracker

跨快照的问题追踪模块（TypeScript / Node.js 库，无接口层）。上层静态分析平台在每次扫描结束后调用 `ingest` 入库一个快照，用 `compare` 对比任意两个保留中的快照。数据存 SQLite（`node:sqlite`，零外部依赖）。

## 用法

```ts
import { Tracker } from 'issue-tracker';

const tracker = new Tracker('issues.db');

const result = tracker.ingest({
  project: 'my-project',
  seq: 42,                       // 同一项目内必须递增
  files: [{ path: 'src/a.ts', content: '...' }],
  findings: [{ rule: 'no-exec', file: 'src/a.ts', line: 17, message: 'avoid exec' }],
});
// result.findings[i] = { id, status: 'carried' | 'reopened' | 'new' }，与入参同序
// result.closed = 本次关闭的问题编号
// result.duplicate = true 表示该序号已入库，返回的是首次结果，数据未改动

const diff = tracker.compare('my-project', 40, 42);
// diff = { regression, added, resolved, unchanged }（问题编号升序）

tracker.close();
```

## 规则要点

- **行指纹**：文件按 `\n` 切行，取该行去掉全部空白字符后的文本。行号为 0、超出文件行数、文件不在本次源文件中时指纹为空。
- **四轮匹配**（同规则、同文件内，已配对双方退出后续轮次）：
  1. 行号 + 消息 + 指纹全同
  2. 指纹 + 消息相同
  3. 行号 + 消息相同
  4. 指纹相同且非空（`null` 与全空白行得到的空串都视为空）
- 每轮条件取值相同的一组，两侧按行号升序依次配对（新发现行号相同按列表先后，老问题按编号升序；重开匹配时老问题一侧按最后出现快照新到旧、行号、编号）。
- 先与上一快照匹配（沿用编号），剩余再匹配窗口内已关闭问题（重新打开、沿用编号），最后才是新增（项目内从 1 递增，按列表先后分配）。
- **保留窗口**：含本次在内最近 30 个快照。窗口外的快照不能参与对比，关闭发生在窗口外的问题不能被重新打开。
- **序号**：必须递增；已入库的序号再次提交原样返回首次结果（`duplicate: true`），其余不递增的一律抛 `SequenceError`。
- **对比**（A 早于 B，均在窗口内）：只在 B 中且首次出现不晚于 A → `regression`（回归），否则 `added`（新增）；只在 A 中 → `resolved`；两边都有 → `unchanged`（中间关闭过也算未变）。
- **原子性**：每个快照的入库在单个事务中完成，要么完整生效要么完全不生效。

## 性能

在 1 个快照 5001 个文件、20 万条发现（含单个生成文件 5 万条同规则发现）的规模下实测（开发机）：

- 首次入库约 1s，带全量匹配的第二次入库约 2s（要求 < 30s）
- 两个 20 万规模快照对比约 0.26s（要求 < 3s）

## 测试

```bash
npm test   # 先 tsc 构建，再用 node:test 跑全部测试
```

- `test/tracker.test.ts`：验收场景（顶部插行编号保持、重复行移动/删除、只改消息、窗口内/外重开、重复提交与乱序、对比四分类、窗口外对比拒绝、项目隔离）
- `test/differential.test.ts`：随机多轮快照（含跨窗口、重复提交、随机对比）与朴素直译版（`test/naive.ts`，不考虑性能）逐条比对，要求编号、状态、关闭列表、对比结果完全一致
- `test/perf.test.ts`：上述规模下的耗时断言

## 构建环境说明

本仓库依赖只有 `typescript` 和 `@types/node`（devDependencies）。本机无网络时，已从 pnpm 本地 store 离线提取到 `node_modules`；如需重建，可用 `tools/extract-from-pnpm-store.mjs`：

```bash
node tools/extract-from-pnpm-store.mjs <pnpm-store-index.json> node_modules/<pkg>
```
