# 部署到公网（不需要双币信用卡）

本项目是 **Node 长驻进程 + WebSocket**（联机房间靠 WS），所以只能用「能跑 Node 进程」的平台。
纯静态托管（GitHub Pages / Netlify / Vercel 静态）页面能开，但**联机一定连不上**。

> **仓库结构**：项目就在仓库根目录（`package.json`、`server/` 在根），任何平台克隆下来直接 `npm start` 即可，**不需要填 Root Directory**。
>
> **单实例限制**：房间数据在内存里，不要开多副本/自动扩缩容。

---

## 一、Bonto（bonto.dev）—— 免费、不要卡、原生支持 WebSocket

免费额度：**75 运行小时/月、512MB 内存、256MB 存储**、HTTPS 域名，不需要信用卡。
30 分钟无访问会休眠，下一次访问自动唤醒（约几秒~十几秒）。

### 创建应用时的填写方式

在「创建新应用」弹窗里：

| 字段 | 填什么 |
|---|---|
| 模板 | 选 **从 Git 导入**（右侧那个） |
| 应用名称 | `kards-nb` |
| 子域名 | `kards-game` → 最终地址 `https://kards-game.bonto.run` |
| 仓库网址 | `https://github.com/chenchenkx/kards_nb.git` |
| 个人访问令牌 | **留空**（仓库是公开的） |
| 分支 | `main`（留空也会自动检测） |

点 **Create 应用** 后它会自动：克隆仓库 → `npm install` → 读 `package.json` 的 `"start": "node server/index.js"` → 注入 `PORT` → 起服务。

部署完打开 `https://kards-game.bonto.run`，页脚应显示 **「构建 v6」**。

> 存储 256MB：项目工作区约 46MB（卡图 43MB），够用。但**不要**把卡图原仓库 `kards-img/` 传上去。

---

## 二、Zeabur —— 免费额度，香港节点国内最快

1. zeabur.com → GitHub 登录 → New Project
2. 选 `chenchenkx/kards_nb`（根目录就是项目，不用改任何设置）
3. 区域选**香港 / 新加坡 / 日本** → Deploy

每月 $5 额度，跑这个项目大约 1~2 美元/月；额度耗尽会暂停但数据保留。

---

## 三、Render —— 免费 750 小时/月，官方明确不要卡

1. render.com → GitHub 登录 → New → **Blueprint** → 选仓库（会自动读仓库根的 `render.yaml`）
2. Apply → 等 3~5 分钟

免费实例 15 分钟无访问休眠，冷启动约 1 分钟。

---

## 四、Hugging Face Spaces —— 完全免卡，16GB 内存

1. huggingface.co → New → Space → SDK 选 **Docker**（仓库可设为 Public）
2. 把本仓库推上去：

```bash
git remote add hf https://huggingface.co/spaces/<用户名>/<space名>
git push hf main
```

3. Space 根目录 `README.md` 开头要有 YAML（端口对上 Dockerfile 的 8080）：

```yaml
---
title: KARDS Web
sdk: docker
app_port: 8080
---
```

免费 Space 48 小时无访问休眠；2 vCPU / 16GB 内存，比其它免费方案宽裕。

---

## 五、只想今晚玩？本机穿透（0 账号 0 卡）

```bash
npm start
# 另开终端
cloudflared tunnel --url http://localhost:8080
```

拿到 `https://xxx.trycloudflare.com`，支持 WebSocket，朋友立刻能联机。缺点：电脑要一直开着，重启后 URL 会变。

---

## 上线后自检清单

1. 打开域名 → 开始界面出现，页脚有 **「构建 v6」**
2. 人机对战 → 手牌**有卡图**（不是黑块）、能拖拽出牌、动画正常
3. 两个浏览器窗口：一个「创建房间」拿 4 位码，另一个「加入房间」输入 → 能进对局
4. 若第 3 步失败：检查平台是否把实例数设成了 1（多实例会导致两个玩家不在同一个进程里）

---

## 常见部署报错对照

| 日志现象 | 原因 | 处理 |
|---|---|---|
| `jsdom@30.x: The engine "node" is incompatible ... Got "18.x"` 然后 `Cannot find module 'ws'` | 平台 Node 18 装不了 jsdom@30，导致整次 `yarn install` 中断，`ws` 也没装上 | **已修复**：`jsdom` 已移出 `package.json`，改为只有 `ws` |
| `Cannot find module 'ws'`（单独出现） | 平台没跑安装，或安装被跳过 | 确认平台的 Install / Build 命令是 `npm install --omit=dev`（或 `yarn install --production`）；若仍不行，页面仍可打开玩人机，日志里会有「未安装 ws 模块」提示 |
| `EADDRINUSE` / 端口占用 | 起了多个进程 | 重启实例 |
| `Cannot find module '../data/cards.json'` | 启动目录不是仓库根 | 启动命令用 `npm start` |
| 页面能开但房间连不上 | 实例数 > 1，两个玩家落在不同进程 | 把副本数/自动扩缩容关掉，保持 1 个实例 |

---

## 仓库说明

- 仓库根即项目根：`server/`、`public/`、`data/`、`package.json`
- 卡图统一使用 `public/assets/cards/thumb/`（300×421），仓库里没有 `img/` 大图
- **生产依赖只有 `ws` 一个**（安装后 `node_modules` 约 207KB），没有原生模块、不需要编译
- `jsdom` 已从 `package.json` 移除（只用于本地跑 `tools/uitest.js`，需要它时单独 `npm i -D jsdom@26`）
- `.yarnrc` 写了 `ignore-engines true`：万一平台用 yarn 安装、且某个包声明了引擎版本限制，也不会让安装中断
- `server/index.js` 对 `ws` 做了**降级保护**：即使 `ws` 没装上，网页照常打开、人机对战正常，只是联机房间不可用（不会整站崩溃）
- `Dockerfile` 已备好（任何支持 Docker 的平台或自己的 VPS 都能用）
- 已忽略：`kards-img/`（719MB 原始图库）、`node_modules/`、`shots/`、参考资料目录
