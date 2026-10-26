# KARDS 网页复刻版 — 完善指令（目标：对战/配卡组还原度 90%）

你是一位资深游戏引擎工程师，熟悉 TCG 规则实现与正则安全。请按本文档改进 `E:/新建文件夹/` 下的 KARDS 网页复刻版。

**改动范围仅限：对战规则、配卡组、以及为支撑这两者所必需的数据/前端修复。不要重写 UI 框架，不要改动美术风格。**

---

## 一、项目事实（已逐条实测确认，勿凭本档猜测）

- 卡牌数据库：`data/cards.json`（1638 张，全部有图）、`data/hqs.json`（11 张 HQ，**硬编码假 id，如 `hq_germany`**）
- 规则引擎：`public/js/engine.js`（UMD，浏览器 `window.KardsEngine` / Node `module.exports`）
- 前端：`public/js/ui.js`、`public/js/main.js`、`public/css/kards.css`
- 服务端：`server/index.js`（权威引擎 + 每座位 `viewFor(seat)` 视角隔离 + 事件广播）
- 卡图库：`public/assets/cards/{img,thumb}` 与 `E:/新建文件夹/kards-img/`
- 测试：`node tools/ruletest.js`（规则断言）、`node tools/selftest.js 10`（AI 自对弈）、`node tools/uitest.js`（jsdom 打完整对局）

**权威基准在本地，不要联网查 wiki：**

| 目录 | 内容 | 用途 |
|---|---|---|
| `kards-sim/KardsSim/` | 从官方客户端 Kismet 字节码 1:1 直译的 C# 引擎（1670 资产） | 规则与卡牌效果的**唯一权威** |
| `kards-sim/cards.json` | 1906 张官方卡定义（完整字段，`raw` 含 `kredits/attack/defense/range/operationCost/heavyArmor/cipher`） | 卡牌数据基准 |
| `kards-sim/deckcodes.json` | 官方卡组码 2 字符码表（2499 条） | 卡组码解析基准 |

### ⚠️ 以下项已实测确认「已实现」，请勿改坏（历史版本曾误报为缺失）

- **`hqBuff`**：`execOp` 有 `case 'hqBuff'`（engine.js:944），给 `hqArmor` 加临时防御；`endTurn → expireTempBuffs`（engine.js:538/549）回合结束清零，逻辑正确。
- **副国规则**：`validateDeck`（engine.js:1290，含副国≤12、副国无精英、稀有度上限、阵营校验、39 张校验）、`autoDeck`（已支持 ally 参数 + 副国≤12 + 副国无精英）、`main.js` 构筑器（副国下拉 106–134、卡池 470–474、canAdd 校验 456–465）**全部已实现**。
- **gotcha 已入卡组**：50 张 `type==='gotcha'`，`autoDeck` 纳入（engine.js:1336/1376）、构筑器卡池纳入（main.js:470 不排除 gotcha）。**但激活逻辑缺失（见 3.1）。**
- **关键词体系已对齐**：`smokescreen`/`guard`/`ambush`/`shock`/`heavyArmor`/`fatigue` 均已实现（engine.js:455/762/812/816/850/531）。14 个关键词（alpine ambush blitz covert deployment destruction fury guard mobilize pincer salvage scrying shock smokescreen）与官方 `has*` 能力位对齐。
- **前线归属 / hqExposed / hqIsGuarded 语义已与官方一致**（已实测）：`frontlineOwner` 清零回 `-1`；不要改坏。
- **`opCost` 与官方 `raw.operationCost` 0 差异**（已实测）：改 `build_data.py` 时不得破坏。

---

## 二、验收标准（"90% 还原度"的可度量定义）

完成后必须同时满足：

| 维度 | 现状 | 目标 |
|---|---|---|
| 卡牌收录 | 1638 / 1906 | **1906 / 1906**（含 178 张 location/HQ、90 张单位/指令） |
| 效果覆盖率 | 578 / 932（62.0%） | **≥ 840 / 932（90%）** |
| HQ 系统 | 11 张硬编码假卡 + 兜底 | 读官方真实 location 数据，defense 支持多档位 |
| gotcha 反制 | 已入卡组，但激活缺失（死功能） | 反制可真实触发 |
| 联机安全 | 泄露对手手牌/抽牌（网络层） | 视角隔离完整 |
| 已知 bug | 1 个已修（灾难性回溯） | **0 个**（见第六节红线） |

效果覆盖率的测量脚本（**保持可复现，改进过程中反复跑**）：

```js
const cards = require('./data/cards.json');
const Engine = require('./public/js/engine.js');
let zero = 0, total = 0;
for (const c of cards) {
  if (c.type !== 'order' && !(c.keywords || []).includes('deployment')) continue;
  total++;
  const cl = Engine.parseClauses(c.text || '');
  const n = cl.reduce((a, x) => a + (x.ops ? x.ops.length : 0), 0);
  if (n === 0) zero++;
}
console.log(`${total - zero}/${total} 有覆盖，${zero} 张白板`); // 当前 578/932，354 张白板
```

---

## 三、P0 任务：修复已确认的真问题

### 3.1 gotcha 反制逻辑完全缺失（死功能，50 张受影响）

**证据**：全库 grep `gotchaActive` 仅在 `engine.js:76`（初始化）、`:96`（serialize）、`:638`（`c.gotchaActive = this.nextGotchaOrder++` 赋值）出现，**没有任何读取/匹配触发点**；`playCard` 也没有"一方出牌时检查对方 `gotchaActive` 是否匹配该卡类别/条件并触发"的逻辑。结果：50 张反制指令打出后只是标记为面朝下，**永远不被激活，等于废卡**。

- 修复：先读 `kards-sim` 的 gotcha 激活机制（官方：反制指令带 counter 类别/条件，对手打出**匹配类别**的卡时触发，取消该卡或执行反制效果）。在 `playCard` 出牌路径增加对**对方** `gotchaActive` 的匹配与触发。
- **联机视角隔离**：`gotchaActive` 值绝不能下发到对手（当前 `viewFor` players 数组双方都序列化，见 3.6）。触发反制时双方都应收到"反制发生"的事件，但反制卡的具体内容（除非已激活）不应泄露。
- 验收：打出一张"反制支援类"指令后，对手打出支援类指令被成功反制（取消/触发效果），且自对弈与联机均可复现。

### 3.2 效果解释器覆盖率 62% → 90%（最大短板）

`parseOps`/`parseClauses` 用英文文本正则解释卡牌效果，932 张效果卡中 **354 张解析不出任何 op，退化成白板**。白板按模式聚类（实测）：

- **部署式 100 张**：`parseClauses` 把 `Deployment:` 标为 `kind:'deployment'`（engine.js:124），但文本如 `"Deployment: Gain an extra kredit slot if deployed from left-most in hand"` 抽不出 ops（`parseClauses` 返回 `ops:[]`），`execCardText(c,'deployment')`（engine.js:686）执行空。需为 deployment 文本写专门解析与执行（extra kredit slot、fight target enemy unit、give all other friendly units +N 等）。
- **触发式 26 张**：`If ...` / `gets:` / `When ...` / `while` 的条件触发与持续效果、HQ 附加规则（如 `ATS`: `"The enemy HQ gets: \"If this HQ has taken 3+ damage...\""`）。解释器当前不支持条件/持续效果。
- **选择式 15 张**：`Choose a card in hand...` / `Choose one - X OR Y`。`choose` op 已生成，但 options/目标消费弱。
- **其他 ~191 张**：简单文本（give/heal/destroy/draw/kredit）未命中现有正则分支。

执行方式：
1. 先跑第二节脚本导出**完整 354 张白板清单**（id + name + text），按文本模式聚类分组，**按聚类批量处理**。
2. 每修一类，重跑脚本确认覆盖率上升，并跑 `tools/ruletest.js` 确认无回归。
3. 新增 op 时：`parseOps` 生成 `{op:'...'}` 后**必须在 `execOp` 里加对应 `case`**（参考已支持的 addDeck/addHand/buff/choose/copyToHand/damage/destroy/draw/enemyHandCost/forecast/friendlyUnit/hqBuff/hqDef/keyword/kredits/ownHandOrderCost/pin/randomEnemy/randomFriendly/retreat/return/slots/spawn/unit/veteran）。
4. 语义拿不准时，读 `kards-sim/KardsSim/Generated/**/<card_id>.g.cs` 直译代码。

### 3.3 补齐 268 张缺失卡

本地 1638 张，官方 1906 张，缺 268 张 = 178 张 location + 90 张单位/指令。

- 单位/指令缺的 90 张：先查是否因 `build_data.py` 的"无图即剔除"导致。若卡图库确无图，**保留卡牌数据但 `image: null`**，前端用占位图；不要因没图就丢数据。
- `opCost` 必须继续与官方 `raw.operationCost` 逐张一致（当前 0 差异，已实测）。
- 验收：`data/cards.json` 合计 1906 张，全部有官方 id。

### 3.4 HQ 系统是 11 张硬编码假卡 + 兜底，未接官方真实数据

现状：`data/hqs.json` 用假 id（`hq_germany` 等），与官方 `card_location_*` 无关；`engine.js:buildDb` 对 11 国用 `FIELD HQ`（defense=20）兜底（1244–1255 行）。`main.js:417` 选 HQ 时已显示真实 `h.defense`，但数据是假的/兜底的。官方 `type==='location'` 的 178 张卡 `raw.defense` 分布为 10/12/14/16/20 多档（TOBRUK 四档、ARNHEM 16、ALAM EL HALFA 20）。

- 修复：把 `build_data.py` 改为输出 `kards-sim/cards.json` 中有 `defense` 的 location 卡到 `hqs.json`，保留官方 `card_location_*` id、真实 `defense`、name。`image: null` 的保留条目（数据不是渲染资源）。
- `engine.js` 的 `RULES.HQ_DEFENSE=20` 保留为兜底；HQ 防御按所选 location 的 `raw.defense` 初始化。
- **`ui.js` 的 `HQ_IMAGES` 硬编码国家→图片映射（Germany→`Danzig.jpg`，但 HQ 名却是 `BERLIN`）改为按 HQ id 查图，缺图回落现有 12 张 `public/assets/hq/*.jpg` + 占位样式。**
- **卡图客观缺失 178 张 HQ 图，勿强求全有图**——保留数据 + 兜底图即可。
- 验收：构筑器能列该国家全部可选 HQ（含真实防御值）；对局中双方 HQ 显示所选 HQ 真实名称与防御值。

### 3.5 社区卡组补牌用随机卡污染官方卡组（真问题）

`public/js/main.js` 的 `applyPreset()`：卡组码解析不足 39 张时，用 `Engine.autoDeck(parsed.main, ...)` **随机补牌**塞满 39。让"官方社区卡组"实际一半随机牌。

- 修复：只补齐卡组码里真实存在但本地卡库缺失的牌（按 `kards-sim/cards.json` 的 id 补进本地卡库，这要求先完成 3.3）。若仍不足 39，**UI 明确标注"该卡组在本卡库缺 N 张"**，而非静默塞随机牌。
- 验收：导入 `jp-pol-boom` 得 39 张全真实牌；导入官方本身缺牌的卡组时显示"缺 N 张"提示。

### 3.6 联机信息泄露（安全瑕疵，网络层）

- `viewFor`（engine.js:1175）`players: [0,1].map(...)` **把双方 hand 内容（id/attack/defense/text）都序列化下发**。联机客户端只用 `players[me].hand`（ui.js:345/716/741），对手 hand 仅显示数量（ui.js:389 `handCount`），所以**界面不泄露**，但**网络层对手手牌经 devtools 可见**。
- `draw` 事件（engine.js:547）`this.ev({e:'draw', side, uid, name})` 带具体牌名，`handleAction` 的 `broadcast(room, {t:'events'})` 发给**双方**——对手抽到的具体牌名在网络层泄露。

- 修复：
  - `viewFor` 中对手的 `hand` 改为只下发 `handCount` + 占位（不暴露 id/attack/defense/text）；自己的 hand 照常。
  - `draw` 事件：仅对抽牌方带 `uid/name`，对对手方只发 `{e:'draw', side, count:1}`（或无 name 的占位），客户端据此只把对手手牌数 +1 不显示内容。
- 验收：联机时抓包/DevTools 看不到对手具体手牌内容与抽到的牌名。

---

## 四、P1 任务：战斗表现的规则细节

以下不影响胜负主体，但影响还原度：

1. `engine.js` 的 `attack()` 战斗伤害手写近似（816–850）。Shock（攻击方先手）/Ambush（防守方先手）已实现（812–819）；但 **Pinned/Suppressed 的反击抑制缺失**（官方 `CalculateDamage`：`atk.Pinned || atk.Suppressed → 无法反击`）。`pin` op 已实现（985 行置 `_pinned`），但 `attack()` 未检查 `_pinned` 来禁止反击。补齐。
2. `canAttackPair` 的 Guard 邻位判定（engine.js:497–515）是本地近似，官方 `UpdateGuarded` 只处理支援线且按 `locationNumber±1` 取紧邻、排除未明牌的 Covert。核对邻位定义一致。
3. 前线归属、`canEnterFrontline`、`hqExposed`、`hqIsGuarded` 已与官方语义一致（已实测），**保持，勿改坏**。
4. 回合结束临时加成过期：`endTurn → expireTempBuffs`（engine.js:538/549）已实现，保持。

---

## 五、前端特效（P2，仅在前述完成后做）

现状：全部特效是 2D CSS 渐变 + Web Animations API + FLIP 补间（`ui.js` 的 `fxSpark/fxSmoke/fxDamage/fxHQHit/turnBanner/killCard` + `kards.css` 的 `spark/ring/slash/smoke/screen-flash/turn-banner/dmg-number`）。**无 WebGL、无粒子系统、无 3D 卡牌。**

官方客户端是 3D 桌游视角。不改美术风格前提下提升：
1. 卡牌真实厚度感：`transform-style: preserve-3d` + 多层 `box-shadow`，hover 绕 X 轴轻微倾斜。
2. 攻击轨迹：补一条从攻击方到目标的运动轨迹（当前 `fxSpark` 只有目标点特效）。
3. 部署/移动进场保留 FLIP，补"卡牌从手牌飞出时带旋转"。
4. 不引入新的构建步骤或框架依赖（项目 `dependencies` 仅 `ws`）。

---

## 六、技术红线（踩了就是严重回归）

1. **绝对不要在正则里使用嵌套量词**（量词里再套量词，如 `((?:[a-z]+ ?)+)$`、`([a-z]+(?: [a-z]+)*)` 配 `$`）。会造成灾难性回溯，单条正则就能把 CPU 打满、**整局游戏永久卡死**。
   - 本项目已因此修掉一个 bug（4 张卡必中：`card_event_the_double_sunrise`、`card_event_sortie`、`card_event_bolster_the_ranks`、`card_event_overwhelming_force`），修复方式为关键词写进正则白名单。`tools/ruletest.js` 末尾有防回归段（子进程 + 30s 超时跑完全部效果卡）。**不要删**。
   - 改完任何正则，务必重跑 `node tools/ruletest.js`。
2. **视角隔离**：`viewFor(seat)` 决定客户端能看到什么。新增字段要同步进 `serialize()`（engine.js:89 附近）与 `viewFor`。本次 3.6 的泄露修复要同步更新 `viewFor`。
3. 联机模式下客户端没有本地引擎，`ui.js` 用 `netShadow(view)` 包装 `view.legal`。新增可行动作类型要同时更新 `server` 的 `legalFor` 与 `netShadow`。
4. `data/cards.json` 的 `opCost` 必须与 `kards-sim/cards.json` 的 `raw.operationCost` 逐张一致（当前 0 差异）。
5. 卡牌关键词体系（14 个）与官方 `has*` 能力位完全对齐，扩展时按官方 `flags` 命名走，不要自造。
6. 保持 `engine.js` 的 UMD 双端可用（浏览器 `window.KardsEngine` / Node `module.exports`）。

---

## 七、建议执行顺序

1. 先跑第二节脚本 + `tools/ruletest.js` + `tools/uitest.js` + `tools/selftest.js 10`，记录基线。
2. **3.6 联机泄露**（小改动，安全收益大）。
3. **3.1 gotcha 激活**（核心机制缺失，50 张废卡）。
4. 3.3 补 268 张卡 → 3.4 HQ 接真实数据 → 3.5 卡组补牌逻辑。
5. 3.2 效果覆盖率（工作量最大，按聚类推进，每类都回归）。
6. 第四节 P1 规则细节（Pinned/Suppressed 反击抑制等）。
7. 第五节 P2 特效。

每一步完成后跑：`node tools/ruletest.js && node tools/selftest.js 10 && node tools/uitest.js`，并重跑覆盖率脚本。**任何一步不得让已有测试从通过变为失败。**

---

## 八、交付说明

完成后请报告：
- 覆盖率数字（改进前 578/932 → 改进后 ?/932）
- 卡牌总数（1638 → 1906 是否达成）
- gotcha 反制是否在自对弈+联机均可触发
- 联机抓包确认对手手牌/抽牌不再泄露
- 新增/修改的文件清单与每处改动的理由
- 测试结果（规则断言数、UI 测试数、自对弈局数与胜率分布）
- 仍未能覆盖的效果卡清单及原因（预期会有，如实列出，不要谎报 100%）
