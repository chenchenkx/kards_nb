# KARDS Web 试玩报告（v9 复测）

> 测试时间：2026-10-26 ｜ 环境：Node v22，本机 `localhost:8080` 已启动
> 范围：**对战（battle）** + **配卡组（deck-building）** + 联机/服务端权威

## 一、启动与联机（端到端）

| 检查项 | 结果 |
|---|---|
| 服务器启动 | ✅ `node server/index.js` 正常监听 `0.0.0.0:8080` |
| 静态资源 | ✅ `/` `/js/engine.js` `/css/kards.css` 均 HTTP 200；`/data/cards.json` 2.3MB 正常返回 |
| 联机对战 `tools/lantest.js` | ✅ **14/14 全过**：建房/加入、双方进入对局、视图隐藏对手手牌、回合权交接、越权动作被拒（服务端权威）、对局分出胜负、gameover 广播、重赛重启 |

**结论**：联机链路完整可用，服务端作为权威引擎裁决座位与动作，客户端无法伪造回合或作弊。

## 二、对战（引擎自对弈）

| 测试 | 结果 |
|---|---|
| 规则单测 `ruletest.js` | ✅ **36/36 通过**（含 4 张曾卡死游戏的卡的正则回溯回归测试） |
| 自对弈 `selftest.js 10` | ✅ 10 局全部正常结束，无卡死/死循环；德国 7:3 苏联 |
| 带日志详测（5 局 德/苏） | ✅ 全部结束、胜负分明；平均剩余 HQ **7.7**（对抗激烈、非一边倒） |
| op 审计 `opa_audit.js` | ✅ `parseOps` 产出的 64 类 op 全部被 `execOp` 处理，**0 缺口** |

每局量化指标（抽样）：出牌 31–49 张、部署单位 25–38、攻击 19–39、直伤 HQ 约 18–21。
战斗、移动至前线、HQ 直伤、疲劳等核心流程均按预期运转。

## 三、关键玩法发现：条件 / 触发式关键字机制缺失（重要）

这是本次试玩**最有价值的发现**。卡池里的 guard/fury/smoke 卡分为两类：

- ✅ **静态关键字**（写在卡牌 `keywords` 数组）：引擎正确生效。
  - 例：`ROYAL WEST KENTS` 静态含 `["blitz","guard"]` → 部署后 `has('guard')=true`，掩护相邻单位生效。
- ❌ **条件 / 触发式关键字**（只写在卡牌 `text` 字段）：引擎**不解析**，部署后机制失效，单位被降级为普通单位。
  - `VOLKSGRENADIER`：`"Deployment: Gets +2 defense and Guard if the enemy controls a Blitz unit."` → 实测部署后关键词仅 `["deployment"]`，`has('guard')=false`（无论敌方是否有 Blitz 单位）。
  - `SPITFIRE Mk IIa`：`"Gets Fury if not [enemy controls air unit]."` → 部署后 `attacksLeft=1`（未获得 Fury 的二次攻击）。
  - `HUDSON Mk III`：`"When Hudson destroys a unit, it gets Fury until end of turn."` → 击杀触发式 Fury 未实现。

**证据链**：`engine.js:65` `this.keywords = new Set(def.keywords||[])` —— 单位关键字只来自卡的静态 `keywords` 字段；`text` 里的条件/触发描述需要额外的触发器子系统解析，而该子系统（即之前 99% 分析中标注的"触发/条件类白板卡"）**尚未实现**。这类卡不会报错，但效果静默失效。

**影响**：卡池共 guard×20 / fury×5 / smoke×4 单位，其中相当比例为条件/触发式；5 局德/苏详测中 guard/fury/smoke **全程为 0 触发**，正源于此。这属于"能跑、不崩、但规则失真"的还原度缺口，对应此前评估的"99% 需补齐触发/条件子系统"。

## 四、配卡组（deck-building）

| 检查项 | 结果 |
|---|---|
| `autoDeck` 生成卡组 | ✅ 39 张合法卡组，`validateDeck` 返回 `{ok:true}` |
| 盟友超限（>12 张） | ✅ 正确拒绝，错误：`"110e RÉGIMENT MOTORISÉ 属于 France，不在 Germany / 中立 之内"` |
| 混入非本阵营主国卡 | ✅ 正确拒绝，错误：`"101st AIRBORNE 属于 USA，不在 Germany / 中立 之内"` |
| 卡组码 | 编码/解码函数位于前端 `main.js`（UI 层），引擎侧以 `validateDeck(ids, main, ally, db)` 校验 |

**结论**：配卡组的合法性与阵营/盟友约束校验完整、报错清晰，符合 KARDS 规则（39 张、盟友 ≤12、稀有度上限 4-3-2-1）。

## 五、综合结论

**可用性与稳定性：优秀。** 启动、联机、对战、规则、配卡组的主干流程全部通过，无崩溃、无卡死、无死循环，服务端权威保障公平。

**还原度瓶颈（对战层面）：条件/触发式关键字机制缺失。** 静态关键字正常，但"若/当…则获得 Guard/Fury"等表述型规则静默失效。这是从 ~92% 迈向 99% 必须补齐的触发器子系统（此前 99% 分析已归类），也是本次试玩新确认的实证缺口。

**建议优先级**：
1. （高）补齐"触发/条件关键字"子系统：解析卡牌 `text` 中的 if/when/until 条件，在部署、击杀、回合等事件点授予/撤销关键字。先覆盖 guard/fury/smoke 三类（影响 29 张单位卡）。
2. （中）将"白板卡"清单（`.work/uncovered.txt`，约 76 张）按机制分类，逐批接入解析器。
3. （低）前端拖拽用 `transform` 替代 `left/top`、治理 `will-change` 常驻、启动异步分包加载 2.3MB `cards.json`（见 `code_review_frontend_backend.md`）。

> 注：本次为程序化试玩（引擎 + 真实 WS 服务器）。浏览器无头模式在本环境不可用，故未做像素级 UI 截图对比；前端动画/交互的逐项评估见同目录 `code_review_frontend_backend.md`。
