# @local/dsh-agent-pack — 蜂群·狼群调度台

**dsh-agent-pack** turns every agent CLI installed on your machine (codex / opencode / claude / gemini / qwen / aider / goose / amp / cursor-agent / omp / …) into a dispatchable workforce: registry scan with real probing, capability routing on measured evidence (not hand-written priors), parallel research swarms, role-split implementation packs with verify/fix loops, heterogeneous review, deterministic eval suites — and a task ledger so an interrupted run can be resumed verbatim in a fresh session.

> English quickstart: `pack_registry_scan` → `pack_plan {objective}` → `pack_swarm` / `pack_wolf`. Everything below is documented in Chinese; tool parameters are self-describing in the schema.

把本机已安装的所有 agent CLI（codex / opencode / claude / gemini / qwen / aider / copilot / goose / amp / crush / cursor-agent / kimi …）变成可自由调度的小队。

**设计立场**：蜂后/狼王是**调用方 agent 本身**——它负责规划、拆解、综合；本插件只当"肌肉"：并行派发、限时收割、验收循环。目标级"不实现不罢休"循环由 DSH 原生 goals 承担；媒体生成由 magpie MCP 承担；本插件专注**外部 CLI 进程级编排**——这正是市面（Ralph/vibe-kanban/CrewAI…）都没打通的空白层。

## 工具

| 工具 | 作用 |
|---|---|
| `pack_registry_scan` | 扫描 PATH 探活所有已知 CLI（--version），写能力画像到 `~/.dsh/agent-pack/registry.json` |
| `pack_registry_list` | 只读查看画像与健康状态：手写先验标 `(prior — hand-written, untested)`，有实测时加 `measured:` 行（通过数/维度/中位耗时/成本） |
| `pack_plan` | 给目标建议蜂群/狼群编队（可编辑 JSON，直接喂给下面两个工具）。**按实测证据排，而不是手写先验**：rationale 里每位都标注 `measured(...)` 或 `prior` |
| `pack_dispatch` | 单发：一个 agent 跑一个任务，超时/字符预算内回收输出。三个健康 CLI 都走各自的机器可读输出（`--output-format json` / `--format json` / `exec --json`），输出尾附 `usage:` 行（token + 缓存读 + 成本） |
| `pack_swarm` | **蜂群**：N 只蜂并行各自调研角度，全部回传蜂后综合（`context` 注入项目上下文；`artifact:true` 写归档） |
| `pack_wolf` | **狼群**：分工狼（db/api/前端/测试…）并行实现 + 验收狼 `WOLF_VERDICT: PASS/FAIL`，FAIL 自动重派修复（默认 2 轮，硬顶 5）；可选 `verifyCommand`（确定性验收前置）、`frozen`（修复轮冻结路径 mtime 护栏）、`context`（上下文注入）、`artifact:true`（审计归档） |
| `pack_review` | **异构复审**：把同一份产物/设计/逻辑交给 **≥2 个不同 agent**，各自隔离审查、互不可见，最后跨审查者比对；每人必须输出 `REVIEW_VERDICT: AGREE/REJECT/UNCERTAIN` |
| `pack_eval` | **评测套件**：用真实任务回归 agent 配置——每个用例跑真派发 + 确定性断言（`contains`/`matches` 正则/`file`+`fileContains`/`exitOk`）；`agent:"*"` 展开到全部健康 agent；不传用例 = 内置 smoke 基线（每个健康 agent 一个 AGENT-OK 探针）；`suitePath` 读 `{"cases":[…]}` JSON；`tags` 过滤；断言确定性判定，没有 LLM 裁判裁判的问题。**registry 变更 / 模板编辑 / config.templates 改动后跑一遍，坏配置在这里变红，而不是在狼群跑到一半时爆炸** |
| `pack_resume` | **任务账本与续跑**：每次蜂群/狼群运行自动记账（`<cwd>/.agent-pack/ledger.json`，含 args 全量快照）；不带 `id` 列出最近任务与状态，带 `id` 把中断/失败的任务**按快照原样重派发**（`resumedFrom` 链）。会话死了、进程被杀了，新会话一句 `pack_resume{id}` 接着跑 |

### 异构复审（pack_review）与多验收狼

- **为什么隔离**：审查者看不到别人的意见，所以「两人指向同一处」才是证据，而不是互相回声。
- **共识怎么读**：多名审查者指向同一处 = 高置信缺陷；只有一人提出 = 低置信线索，自己去代码里核。
- 计票分四类：`agree` / `reject` / `uncertain` / **`missing`（崩溃、超时、输出无 verdict——按「未审查」计，绝不算认可）**。有 reject 时结论不会被当成已通过。
- `files` 参数**强烈建议传**（schema 上可选，但不传时无头 reviewer 倾向于漫游目录找文件，极易超时）；给了文件清单它才会读完立刻写报告。
- `pack_wolf` 的 `verify` 同样可传数组（多个验收狼并行，全部 PASS 才算 PASS）。

## 典型用法

```
1. pack_registry_scan                          ← 首次/装了新 CLI 后
2. pack_plan {objective:"…"}                   ← 拿建议编队
3. 按需编辑 → pack_swarm / pack_wolf            ← 真派发
```

## 安装

插件以本地目录形式挂进 DeepSeek Harness（DSH）的 profile：

1. 把本目录克隆/复制到任意路径，例如 `~/dsh-agent-pack`。
2. 编辑你的 profile `package.json`（`~/.dsh/profiles/<名字>/package.json`），在 `dependencies` 加一行指向该目录：

   ```json
   "@local/dsh-agent-pack": "link:~/dsh-agent-pack"
   ```

   （Windows 路径用正斜杠，如 `link:E:/tools/dsh-agent-pack`。）
3. 重启 DSH 或重载插件；会话里出现 `pack_registry_scan` 等 9 个 `pack_*` 工具即安装成功。
4. 第一次使用先跑 `pack_registry_scan`（只读探活 `--version`），再 `pack_plan` / `pack_swarm` / `pack_wolf`。

要求：Node ≥ 18（仅 node: 内置依赖）；至少一个已安装的 agent CLI。MIT 许可，见 [LICENSE](LICENSE)。

## 配置（Config）

`defaultTimeoutSec`(600) · `maxOutputChars`(12000) · `maxWorkers`(6) · `maxPromptChars`(24000，仅 `pack_dispatch` 单任务上限；蜂/狼任务书正文有内置 16000 字符预算，蜂/狼 prompt 超预算会在校验时直接拒绝) · `registryPath`(默认 `~/.dsh/agent-pack/registry.json`) · `templates`（按 CLI 名覆盖 argv 模板）。

手工维护画像：编辑 registry.json 加 `"manual": true`，之后 scan 不再覆盖该条。

## 边界

- 子进程 argv 永不经 shell（插件层强制：模板头校验 + 交接标志拒绝）；env 的凭据/DSH_* 剥离发生在**宿主** `subprocess.spawn` 契约层，插件不重复实现、也不在本层复核。
- 每路输出有字符预算，超长截尾保留末段（结论通常在末尾）。
- 取消：调用方 abort signal 会级联 terminate 子进程树（Windows 下 TERM→taskkill /F）。**例外**：若 terminate 连续失败，插件在超时+60s 后放弃该进程句柄（不再等待），该进程可能变成孤儿——这是知情的最后手段，宁可泄漏一个进程也不让一次派发永久卡住。
- `WOLF_VERDICT` 由验收狼自报，只认**行首锚定**的匹配且取**最后一次**；任务书指令行写成占位符形式（`WOLF_VERDICT: <PASS 或 FAIL>`），所以验收狼逐字回显指令造不出假 verdict。任务书截断只切中部、永久保留尾部协议行，超长任务书不会伪造出 "verdict missing"。
- `REVIEW_VERDICT` 同理取最后一次匹配；没给 verdict 的审查者计入 `missing`，不算 AGREE。
- 子智能体面板的目录条目是**只追加的历史事实**（与宿主同构）：一次会话跑过多少工人就留多少条，插件不清理、也不能改已写条目；`pack_eval` 不写。

## 在目标循环中使用（“不实现不罢休”）

本插件不自建循环——它挂在 DSH 原生 goal 上，每轮由 `goal-round-driver` 唤醒指挥官，循环体是这样：

```
/goal 实现 X（验收标准：…）
   ↓ 每轮唤醒
指挥官判断当前缺口 → pack_wolf{objective, wolves:[角色分工], verify}
   ↓ VERIFIED PASS？
   ├─ 否 → 下一轮继续（pack_wolf 内部已自行跑 maxFixRounds 修复回合）
   └─ 是 → 指挥官把 goal 标记完成
```

配套两种编队：

- **调研期**用 `pack_swarm`：多个角度并行，蜂后（就是指挥官）拿到全部报告再决策。
- **实现期**用 `pack_wolf`：角色互斥、各写各的文件；验收狼必须实际执行验证命令（跑测试、跑构建），不能只看代码。

实测记录（本机，Windows / DSH 0.2.1-rc.5）：`pack_wolf` 用一个 `impl` 狼 + 一个 `test` 狼并写 `calc.py` / `test_calc.py`，验收狼 `opencode` 实际执行 `py -m unittest discover -v` 得到 17 tests OK 后判 PASS，产物独立复核通过。

BUILD .8 回归（2026-11-04）：`pack_dispatch`（claude, R8-OK）、`pack_swarm`（2/2 蜂守约回传）、`pack_wolf` 全链路——verify-1 真实抓到实现/测试的 `safe_int` 签名契约不匹配（12 用例 8 过 4 ERROR）判 FAIL，fix 轮实现狼补上 `default` 形参，verify-2 重跑 12/12 OK 判 PASS。验收狼抓的是真 bug，不是走形式。同轮发现 claude 无头会话无法执行命令（见下），验收狼应选有执行能力的 agent。

BUILD .9 修复（2026-11-04，第 5 轮异构复审驱动，claude+opencode 双 AGREE 后顺手修掉共识缺陷）：①不传 `verify` 的狼群现在 `passed:false` + 渲染 `NOT VERIFIED (no verifier supplied)`——修复前会渲染 "VERIFIED PASS"（空真通过，goal 循环的最大隐患）；②`modelArgs` 修复为真正插到 `{prompt}` 槽位前（修复前插入点查找发生在替换之后，恒 miss，永远 append 尾部）；③`WOLF_VERDICT` 与 `REVIEW_VERDICT` 同强度行锚定 + 指令行占位符化（回显不可伪造）；④蜂/狼 prompt 校验上限对齐任务书真实预算（16000），过校验即完整送达、不再静默截断。回归：scan（build .9 装载）、无 verify 狼群（NOT VERIFIED + 产物独立复核真实）、带 verify 狼群（verify-1 PASS，验收狼真跑 `node --test` 2/2 绿）、dispatch ping（claude 13s OK）。

BUILD .10–.12 验收轮（2026-11-04，自我主导优化 + 完整验收，全过）：

- **优化（均由验收暴露的真问题驱动）**：`pack_plan` 狼群角色数封顶 n-1（保底留一个家族做独立验收，建议 verify 不再同族）+ 建议 verify prompt 占位符化；`runProcess` 在 done reject 时 terminate 残留进程；`OBJECTIVE_BUDGET`(6000) 防 objective 挤占任务正文；蜂群任务书加**时间纪律**（先已有知识作答、检索只做有边界的补充——真发现：带 websearch 的调研蜂会漫游超时颗粒无收）；验收任务书加**验收纪律**（先跑命令拿统计与失败清单、不深挖根因、诊断脚本放工作目录外、留时间输出协议行——真发现：验收狼钻 PowerShell 引号诊断牛角尖，两轮 verdict missing）；fix 任务书加「测试文件自身错误断言也是合法修法，但不得删测试或放松实质约束」；狼失败带原因（`failWhy`：`timed out in Ns` / `spawnError` 直接入 phaseLog，不再是裸 failed）。
- **验收测试**：T1 `pack_plan`（首跑暴露 4 角色占满 3 家族 → role-cap 修复后 2 狼 + 异构验收）；T2 超时（claude timeoutSec:4 → 4s 准时掐断优雅返回）；T3 model override（`--model haiku` 端到端 splice 生效）；T4 maxWorkers（7 蜂一行拒绝）；T5 registry 投毒双向量 0s 拒绝（`cmd` 解释器头 / `-c` 交接标志）+ 恢复验证；T6 全链路 scan→plan→swarm→wolf→review 真实场景 mdtable.js（CSV→列对齐 Markdown 表格、中英文混排宽度）。
- **T6 全链路证据**：蜂群 width 蜂产出 East Asian Width 完整规则；狼群验收狼抓到**测试文件自身的错误断言**（第 59 行注释宽 8、第 60 行期望串 7）→ fix 指导生效，修复狼修正测试文件而非改坏实现，VERIFIED PASS；异构复审 claude AGREE（逐区间核对 EAW 表）+ opencode 探针实证（verdict missing，正确按「未审查」计）**双异构汇聚确认 2 个真缺陷**（U+1F000 以下 W emoji 宽 1、全空列分隔行零短横）→ 回灌狼群修复（含一轮「min-3 修错位置被旧断言拦下」的真收敛）→ 终态 8/8 测试 + 3 组独立探针全绿 VERIFIED PASS，产物独立复核一致。
- **已知行为**：调研蜂带联网检索时仍可能超时（时间纪律是缓解不是根治）；claude 实现狼偶发 360s 超时（写盘慢）——狼群判定看**工作目录产物状态**而非狼的报告，超时狼已落盘的工作仍会被验收如实判定（实测出现 `implement: 0/1 (timed out)` + `VERIFIED PASS` 的诚实组合）。

BUILD .13 产物链与确定性验收（2026-11-04，源自 Anthropic《AI-native SDLC playbook》的模式落地；全部真跑验证）：

- **artifact 产物链**（`pack_wolf`/`pack_swarm` 传 `artifact: true`）：每次运行写审计归档到 `<cwd>/.agent-pack/<时间戳>-wolf|swarm-<slug>/`——`manifest.json`（目标/配置/结论）、`workers/`（每只狼的任务书+完整输出）、`verify/round-N.md`（每轮验收输出）、`phase-log.md`、`verdict.md`；蜂群对应 `reports/`。产物链即审计轨迹：goal 下一轮（或人）从归档恢复现场，不靠会话记忆。归档失败只记 artifactError，绝不拖垮已经成功的狼群。已真跑：狼群归档（manifest/workers/verify/verdict 四件齐全）与蜂群归档均落盘核验。
- **verifyCommand 确定性验收前置**：argv **数组**（不是 shell 字符串——守住「argv 永不经 shell」），implement 后立即运行。绿且无 LLM 验收狼 → `verdict:"command-verified"`（渲染 VERIFIED PASS 并注明是命令判定）；红且无 LLM 验收狼 → `"command-failed"`；有 LLM 验收狼时命令结果作为**事实基线**嵌入第一轮验收任务书，验收狼从事实出发而非靠猜。实测：`["node","--test"]` 1s 出结果、零 LLM token；红命令分支（exit 1）渲染 `NOT verified (verdict: command-failed, rounds: 0)`。注意 verdict 说明**谁**验的：`command-verified` 是命令判定，不是 LLM 判断——两者都诚实标注。
- **frozen 冻结路径护栏**（确定性，不依赖狼自觉）：fix 轮前对 `frozen` 路径做 size+mtime 快照，每轮修复后对比；创建/修改/删除任一冻结路径 → 立即确定性 FAIL（`verdict:"frozen-violation"`），不再继续烧轮。冻结线会写进 fix 任务书（「绝对不得创建、修改或删除」）。与 BUILD .12「允许修测试文件」的关系：.12 是默认修复自由度，frozen 是调用方**显式**加的确定性护栏——默认不冻结，冻结即强制。验证方式：真实狼群跑一轮（守约狼未触碰 → 无误报，循环正常继续）+ 对 shipped 源码逐字提取做探针（修改/删除/新建/绝对路径 6/6 全部正确触发）。
- **context 项目上下文注入**：`context` 文件路径数组进**每一个**任务书（狼/蜂/验收/修复轮），段名「项目上下文（动笔前先读这些文件）」，缺失路径如实标注（缺失）不臆造。实测：蜂读到 context 文件后直接按其中的约定汇报（约定生效），缺失文件被如实报告。
- 教训：**守约的狼永远不会触发确定性门禁**——门禁的 wiring（快照、无误报）可以 E2E，违规分支要靠对 shipped 源码的逐字探针覆盖，别指望靠「指示狼去违规」来测试护栏。

BUILD .14 评测套件（2026-11-04，源自 Anthropic《AI-native SDLC playbook》模式④「评测套件回归 agent 配置」；全部真跑验证）：

- **`pack_eval`** = 给 agent 配置的回归测试。用例形状 `{id, agent, prompt, expect?, tags?, cwd?, timeoutSec?, model?}`；`expect` 全部确定性判定：`contains`（子串）、`matches`（正则，默认忽略大小写，`matchesFlags` 可改）、`file`+`fileContains`（运行后磁盘上必须有这个文件且内容含子串）、`exitOk`（默认要求 exit 0，显式 `false` 接受任意退出码——但 **spawnError 与超时永远算失败**，进程没跑完不算「任意退出码」）。断言由代码判定，不存在「LLM 裁判放水」。
- **`agent: "*"`** 展开为 registry 里全部健康且可派发的 agent（与 pack_plan 的可用性过滤同一口径），展开后逐 agent 生成 `id-<agent>` 用例。不传 `cases` 也不传 `suitePath` = 内置 smoke 基线：对每个健康 agent 发一个 AGENT-OK 探针。这是「每次配置变更后跑一遍」的零配置默认。
- **`suitePath`** 指向 `{"cases":[…]}` JSON 文件，把「生产事件转永久评测」变成一行 JSON——真实事故里暴露的 agent 行为，加一个用例就永远被回归。`cases` 与 `suitePath` 二选一。
- **`tags`** 过滤：给了 tags 就只跑带匹配标签的用例（未打标签的用例不会被过滤命中）。
- 规模护栏：单次最多 50 用例（文章口径 20-50），并发受 `maxWorkers` 封顶（泳道池，不会 fork-bomb）。
- `artifact:true` 写归档：`manifest.json` + `cases/NN-<id>.md`（prompt、逐条 problems、完整输出）。
- 实测（build .14）：内置 smoke 2/3（codex 因其自身网络问题超时——套件如实报红，这正是它的职责）；inline 用例 `file+fileContains+contains` 三断言齐过（产物独立复核）、故意写错正则的用例精确报 `output does not match`；`suitePath`+`tags` 过滤（未打标签用例被正确排除）；**模板投毒回归环**：claude 正常 14s 绿 → 投毒 `['cmd','/c','{prompt}']` 后同用例 **0s 红**（零 LLM token，错误信息列出完整解释器黑名单并给出修法）→ 恢复后 19s 绿。坏配置在评测里现形，而不是在狼群中途爆炸。


BUILD .15 子智能体面板可见性（2026-11-04，由用户反馈「调度应该在顶部看到我的蜂群/狼群」驱动；全部真跑核对）：

- **接入点**：顶部「N 个子智能体」徽标与下拉 = 当前会话的 `subagentCatalog` projection，唯一数据源是**该会话上追加的 `subagent/catalog` 事件**。外部 CLI 在 DSH 眼里是「另一个进程里的子级、没有本地会话」，对应的目录事实模式就是 `mode:"external"`——UI 把这种行渲染成「外部任务」，不可点开（没有子会话可点，这是设计而非缺陷）。
- **实现**：每次派发前（profile 解析成功之后，避免拼错 agent 名留下幽灵条目）向父会话追加一条 `subagent/catalog`（`version:2 / mode:"external" / label`）。于是每只蜂、狼、验收狼、复审者都以 `蜂群·analysis (claude)`、`狼群·impl (opencode)`、`验收·第1轮 (opencode)`、`复审·安全 (opencode)`、`派发 (codex)` 的标签出现在面板与计数里。**不发消息、不唤醒任何人、不产生回合**。
- **为什么不用 `subagents.startActivation`**：那条路（`delivery:"parent"`）会在每个工人结算时向父会话收件箱投递一条结算通知（`notifySettlement`），对一次狼群就是每条工人一个通知的纯噪声；`delivery:"caller"` 则完全不写目录事实、面板看不见。直接追加目录事实是唯一「可见且安静」的解。
- **为什么不进「智能体团队」面板**：那个面板读 `agentTeam` projection，只显示**持久队友**（spawnTeammate 创建、自带 DSH 会话/模型/上下文、占真实 token）。把外部 CLI 塞进去等于伪造成员身份与其会话（点击即报错），概念上也是另一种东西：队友 vs 进程工人。本插件的工人在「子智能体」里，语义正好——外部任务。
- **不记录**：`pack_eval` 的用例不写目录事实（一次最多 50 用例，会把面板刷成流水账）。追加失败只记 warning，绝不影响派发。
- 实测（build .15）：`pack_dispatch` → `派发 (opencode)`；`pack_swarm` 2 蜂 → `蜂群·alpha (opencode)` / `蜂群·beta (claude)`；`pack_wolf`（带 `verifyCommand`）→ `狼群·impl (opencode)` / `验收·第1轮 (opencode)`，会话事件日志逐条核对；该狼群 VERIFIED PASS（verifyCommand exit 0，验收狼真跑命令后 PASS）。

BUILD .16 结构化输出与成本可见（2026-11-04；全部真跑验证）：

- **问题**：此前所有判定都靠模型在正文里写一行 `WOLF_VERDICT: PASS`——一句自然语言就把关，模型顺手复制模板行就能伪造，且拿不到 token/成本。
- **事实核对**：三个健康 CLI 本来就都能输出机器可读结果，加固文本协议属于顺序错误。claude `--output-format json` 出单个 envelope（`usage`、`total_cost_usd`、`permission_denials`、`session_id`），`--json-schema '<inline JSON>'` 直接收内联 schema、结构化结果落在 `structured_output`；opencode `--format json` 出 JSONL（`step_finish.part.tokens` / `cost`）；codex `exec --json` 出 JSONL（本机因自身网络问题拿不到成功样本，解析器按失败形状 + 惯例防御式写法，代码里如实标注「未验证」）。
- **适配层**：`OUTPUT_ADAPTERS = { claude, opencode, codex }`，按 `profile.output`（显式 `text` 可关闭）或 `template[0]` basename 选择；选不到就退回文本协议——**文本协议仍然可用**，只是不再是唯一的路。
- **效果**：`runOne` 返回 `structured` / `usage` / `sessionId` / `denials`；狼群与复审在有 schema 能力时把 `VERDICT_SCHEMA_WOLF`（`PASS|FAIL + reason`）、`VERDICT_SCHEMA_REVIEW`（`AGREE|REJECT|UNCERTAIN + reason`）交给 CLI，用 `structured.verdict` 判定，正则只做回退。渲染层把结构化结论写成人类可读一行（`verdict: PASS — note.txt 存在，内容为 "WOLF19-OK"`），不再吐裸 JSON。
- **成本可见**：每个工具输出多一行 `usage: … in / … out (cache read …) · ~$0.xxxx`，蜂群/狼群/复审是全体工人的汇总。
- 实测（build .16–.20）：`pack_dispatch opencode` → `usage: 14835 in / 16 out (cache read 44544)`；`pack_dispatch claude` → `usage: 6 in / 263 out (cache read 120101) · ~$0.4701`，且 `--allowedTools Bash` 下真的写出了文件；`pack_wolf` 验收狼用 claude 时 `structured verdict` 直接给出 `===== [verifier claude] PASS =====`；`pack_review` 两个审查者 AGREE 2 / REJECT 0 / UNCERTAIN 0 / NO VERDICT 0，claude 走 schema、opencode 走行锚定文本协议，两条路并存。**成本事实**：一次 claude 无头调用约 $0.44–0.47（缓存写入占大头），狼群里放一只 claude 就是实打实的钱。

BUILD .17–.20 实测能力反哺路由（2026-11-04；全部真跑验证）：

- **先验 → 证据**：`KNOWN_AGENTS` 里的 `scores` 是手写先验（对 CLI 的看法，从没测过）。`pack_eval` 是唯一真证据，所以 `pack_plan` 优先用实测，`pack_registry_list` 把两者分别标注 `(prior — hand-written, untested)` 与 `measured: …`，`pack_plan` 的 rationale 写成 `opencode(1 measured(1/1 untagged))`、`claude(0.9 prior)`——**排名是人能读懂的，能看出哪一条是证据、哪一条是猜测**。
- **存原始样本，不存算出来的分数**：每个 agent 保留最近 12 条 `{at, dimension, pass, durationMs, costUsd}` 样本，`summarizeSamples` 在读取时才聚合出通过率/中位数/成本。理由（都是修过的真 bug）：(a) 旧实现每次 `pack_eval` 覆盖整条记录，跑一次**无标签 smoke 就把已测出的 coding/research 维度全冲掉**；(b) 旧实现把「无维度样本的整体通过率」当维度分，导致一次 research 用例通过就抬高了 coding 排名。现在无标签样本只影响 general，**跨维度不串味**，且旧格式记录会被识别为 `legacy record, no samples` 并拒绝当维度证据。
- **维度靠标签**：用例 `tags` 里写 `coding` / `research` 才进对应维度，其余进 `general`。**标签必须诚实地描述用例本身**——给一句「回显这个 token」打 `coding` 标签，等于往路由里灌假证据（我在验收时就这么干过，随后清掉了）。
- **验收员也按证据挑**：`pack_plan` 在非狼家族里按分数挑验收员；若挑中的那位「所有实测用例都失败」，rationale 会追一句显式警告（`⚠ codex has failed every measured case … expect NO VERDICT: pass your own verifier or re-run pack_eval first`），而不是悄悄产出一堆 NO VERDICT 回合。
- 实测（build .17–.20）：3 用例套件（opencode coding 通过 / claude research 通过 / codex coding 超时失败）→ 记录后 `pack_plan` 从 `codex(0.9 prior), claude(0.9 prior), opencode(0.85 prior)` 变成 `opencode(1 measured(1/1 coding)), claude(0.9 prior), codex(0 measured(0/1 coding))`——**证据压过了先验**（research 通过没有泄漏进 claude 的 coding 排名）；随后跑一次无标签用例 → `2/2 passed (coding 1/1, general 1/1)`，**已有维度没被冲掉**；内置 smoke 复跑得到诚实的 general 样本（codex 0/1、opencode 1/1、claude 1/1）并给出上面那条验收员警告。

## BUILD .21–.22 真·本机发现层（不再只认 12 个写死的名字）

- **问题**：旧 `pack_registry_scan` 只对 `KNOWN_AGENTS` 里写死的 12 个名字做 `resolveExecutable`——本机装着的 `omp`（@oh-my-pi/pi-coding-agent）、`dsh headless` 全被漏掉，扫描结论「只有 3 个」是白名单的结论，不是机器的事实。
- **现在**：扫描 PATH + 常见全局 bin（`%APPDATA%\npm`、`~/.bun/bin`、Python Scripts、`~/.local/bin`、scoop shims、WindowsApps、cargo/deno bin、chocolatey），同名多扩展名（foo / foo.exe / foo.cmd / foo.ps1）折叠为一个候选。预设新增 `omp`（`omp {prompt}`，实测可派发）和 `dsh`（`dsh headless {prompt}`，argv 来自 `dsh --help`，**派发未实测**：每次都会启动一整个嵌套 DSH，慢且重）。
- **只探显式名单，不按词根猜**：探活 = **执行** `<bin> --version`。.21 初版按 `/agent|code|assistant/` 词根匹配，结果执行了 VS Code、pyside6-assistant，以及 Git 的 `start-ssh-agent`——后者真的清掉了 ssh-agent socket。.22 收紧为精确名单（`AGENT_NAME_HINT`），其余 CLI 用 `config.extraAgents` 显式声明。
- **找到 ≠ 能派发，如实分层**：scan 输出分五组——可派发 / 发现但无模板（插件不猜 prompt 怎么传，需在 `config.templates` 声明）/ 发现但不在 PATH（`not-on-path`，模板头必须是 PATH 可解析的裸名）/ 坏掉 / 未安装。发现的 CLI 没有手写先验，`scores: null`，路由显示 `unscored` 而不是假装 0 分。
- `config.discover: false` 关掉目录扫描；`config.extraAgents: ["name" | {name, template, kind, scores, modelArgs}]` 补非标准 CLI。
- 实测（build .22，本机）：可派发 5（codex / opencode / claude / omp / dsh），发现无模板 3（agent-reach / agently-cli / opencli），坏 1（copilot shim），未装 8。`pack_dispatch omp` → `ok in 40s`、`OMP-DISPATCH-OK`（omp 的 MCP 连接告警走 stderr，不影响答案）。
- **Magpie 不在这张表里是对的**：它是 LLM 网关（`our-free-model/catalog.json` 里是模型条目，不是可执行的 agent），模型数量不等于可派发的 agent 进程数。

## BUILD .23 任务账本与断点续跑（2026-11-05；全部真跑验证）

- **问题**：此前每次蜂群/狼群都是一次性的——会话断了、进程被杀了，做到一半的目标就丢了，恢复全靠人重写 prompt。这正是「自动接、自动续」缺失的那一半。
- **任务账本**：`<cwd>/.agent-pack/ledger.json`，每个 wolf/swarm 运行一条记录（id、目标、起止时间、状态 running/completed/failed/interrupted、verdict、args **全量快照**）。开始时保存快照是关键设计——哪怕进程中途死掉，账本里仍有「怎么原样重跑」的全部信息。`running` 超过 6 小时的条目读取时自动清扫为 `interrupted`。
- **`pack_resume`**：不带 `id` 列出最近任务（状态/outcome/失败原因）；带 `id` 从快照原样重派发，新任务经 `resumedFrom` 链到旧任务。续跑粒度是任务级（整个 pack 重跑），不依赖原会话存活。
- 实现：swarm/wolf 的 execute 由 `ledgerRun()` 包装——begin 记账、completed/failed 终态记账、抛错记录 failed；实现函数挂 `packImpls` 供同进程续跑。账本写入失败只静默跳过，绝不拖垮派发。
- 实测（build .23）：mock 冒烟 9 工具全注册、列表/清扫/空账本全过；**续跑端到端真跑通过**——resume 一个中断的 wolf 任务时真实重派发发生并正常完成记账（守卫测试的「意外成功」恰好证明链路是通的）。
- **崩溃韧性测试**（`tests/ledger-crash.test.mjs`，`node --test` 运行，4 项全过）：验证被杀进程可能留下的文件状态——残留 .tmp 不影响读取、截断的 ledger.json 降级为空而非崩溃、tmp+rename 循环后文件恒为合法 JSON、超时 running 条目被清扫为 interrupted。
- 未做（留给 .24+）：定时/事件触发的发起端（有了账本，接上 cron 即「自动接」）；wolf 内部中途断点（当前是任务级重跑）。

## 与 agent-autoloop 的关系（正交，可组合）

[agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 是常驻自动化中台：事件驱动接活、跨会话跟进、人不在时把决策卡片推到飞书/Slack。它和本插件回答的是两个不同的问题，且互相成就：

- **autoloop 管「活从哪来、断了谁续」**：cron/Webhook 发起任务，进程级挂起零消耗，会话级续接。
- **agent-pack 管「活怎么干得又快又好」**：单个任务内多 CLI 并行（蜂群/狼群）、实测能力路由、verify/fix 质量闭环、异构复审。
- **组合用法**：autoloop 的规则把任务派给 DeepSeek Harness（`dsh --profile headless {prompt}`，它内置 DSH 适配），DSH 会话里再调用本插件跑狼群——发起端是 autoloop，质量闭环是 agent-pack。

**明确不做**：本插件不做事件调度、不做后台常驻、不做会话级续接（那是 CLI 进程层的职责，超出插件边界；本插件的 `pack_resume` 是任务级原样重跑）。需要这些，请用 autoloop 这类中台，两者叠加而非重复造轮子。

## 环境注意（Windows）

- npm 装的 CLI 通常只有 `.cmd` shim；插件会解析 shim 指向的真实 `.exe`（或 `node + 脚本`）直接启动。经 `cmd /c` 中转会二次解析参数，把多行 prompt 截成第一行——所以解析不出真实目标时**直接拒绝派发**，不退回 shell。
- 宿主 spawn 不查 PATH，argv[0] 必须由 `resolveExecutable` 解析成绝对路径。
- 派发工作目录缺省为**系统临时目录**（不是用户主目录）——把 workspace-write 的 agent 扔进 home 等于把 `~/.ssh`、`~/.dsh` 交出去。始终显式传 `cwd`；传了不存在的目录会自动创建（不存在且创建失败时返回明确 spawnError）。
- **无头会话的命令执行能力取决于模板是否给权限，不是 CLI 的能力**：claude 默认策略会拦下 Bash（`requires approval`）；**给它 `--allowedTools "Bash"` 之后可以真实执行**——2026-11-04 实测 `claude -p "…用 Bash 运行 node -e …randomUUID…" --allowedTools "Bash"` 返回了只有真执行才可能得到的 UUID。所以「claude 只能静态核查」的旧结论作废：要它跑测试就在 registry 的 `template` 里带上权限参数。opencode / codex 默认无头即可执行。
- 本插件所有工具的 `parameters` 用**标准 JSON Schema**（对象级 `required` 数组），不用宿主 author-dialect 形状——部分模型网关会丢弃非标准 schema 工具的调用参数（症状：必填参数莫名缺失、prompt 里出现 `undefined`）。改动 schema 形状时保持标准形状。

## 安全边界

- `registry.json` 与 `config.templates` 是**不可信输入**：模板头必须是裸命令名（无路径、无 `{}`/`=`、无 shell 元字符），且不允许 `cmd`/`powershell`/`node`/`python`/`php`/`deno`/`awk`/`sed`/`wmic`/`ssh` 等解释器作头，也不允许 `/c`、`-c`、`-e`、`-r`、`eval`、`--eval=` 这类紧邻 `{prompt}` 的交接标志——否则 LLM 写的 prompt 会被当命令执行。**这份名单是纵深防御，不可能穷举**；真正的信任边界是「registry 与 config 由谁写」。
- `bees`/`wolves`/`verifiers`/`reviewers` 一律受 `maxWorkers` 封顶。
- 任务书按命令行安全长度（30000 字符）截断并注明，避免 Windows 32K 上限导致 spawn 静默失败；截断保留头与尾，协议行不会被切掉。
- `verify` 传了但全部无效（拼错字段、空 prompt）时**不会**报"通过"，而是 `passed:false` + `verdict:"invalid-verify"`——狼群代码照样回传，但绝不宣称已验证。干脆不传 `verify` 同理：`passed:false` + `verdict:"not-run"`，渲染 NOT VERIFIED。
- 交接标志检测把一切 `--opt=value` 内联形式一律按交接拒绝（fail-closed）：`--output-dir=x` 这类合法参数会被误拒，改用空格分隔写法（`--output-dir x`）即可。
