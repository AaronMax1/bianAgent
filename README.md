# bianAgent

基于币安 Agentic Wallet 的本地多账户工作台，包含网页前端、常驻钱包后端和 Codex skill。

网页管理账户与参与记录；CLI 和 skill 负责在明确授权范围内预览、执行和核验交易。默认使用 BNB Smart Chain（chain ID 56）。

## 功能

- **网页控制台**：账户总览、币安扫码登录、账户名称与备注、归档恢复、项目汇总、交易搜索及链上凭证。
- **多账户隔离**：各账户持有独立会话、钥匙串命名空间、加密密钥、数据库、执行队列和固定设备档案。
- **批量执行**：选择一个、多个或全部账户；保存逐账户预览、付款限额和批次授权；支持暂停、恢复和取消未提交任务。
- **项目参与**：通用 ABI 合约调用、BNAGENT Mint、币安聚合兑换、显式 V2 交易和受限的 EIP-712 SignIn。
- **交易恢复**：先持久化提交意图，幂等请求避免重复执行；结果不明时对账，不自动重发；确认回执后核验项目结果。

## 环境

- Node.js **23 或以上**；项目使用 `node:sqlite`。
- 已安装的官方 `@binance/agentic-wallet` CLI **1.12.0**。直连适配器核对版本与构建哈希，并复用其会话格式和钥匙串模块；其他版本须先审阅兼容性。
- 使用自己的币安 App 完成账户配对。仓库不包含任何已登录账户。
- 自动化测试另需 `anvil` 和原生 Solidity **0.6.x** 编译器 `solc`；浏览器测试另需 Google Chrome 与 Playwright。

## 安装与启动

```sh
git clone git@github.com:AaronMax1/bianAgent.git
cd bianAgent
npm ci --ignore-scripts
# 若尚未安装兼容的官方 CLI
npm install --global @binance/agentic-wallet@1.12.0
node scripts/install-skill.mjs
npm run web
```

打开 **http://127.0.0.1:4173**。钱包服务和网页进程会自动启动，网页只监听本机地址。

在“账户管理”点击“添加账户”，创建独立档案，再用对应的币安 App 扫码登录。已有兼容会话可作为 `default` 复用；账户名称只改变显示，不改变钱包绑定或设备档案。

网页的项目与交易历史来自当前服务保存的操作，未覆盖钱包在其他工具里的全部链上行为。领取结果表示历史到账，不表示实时持仓。未识别的项目显示合约地址。

## 配置

运行目录默认位于 `~/.local/share/codex-project-wallet/`。自定义位置使用 `CODEX_WALLET_HOME`；skill 安装位置可用 `CODEX_HOME` 指定。

将 [config.example.json](config.example.json) 复制到运行目录的 `config.json` 后按需修改。该示例不包含凭据或个人账户数据。

| 字段 | 作用 |
| --- | --- |
| `proxy` | 币安接口代理；空字符串表示直连 |
| `rpcProxy` | 只读 RPC 代理；省略时沿用 proxy，空字符串表示独立直连 |
| `rpcUrls` | BSC 只读 RPC 节点，逐个回退 |
| `batchConcurrency` | 跨账户并发数，范围 1–8 |
| `webPort` | 网页本机端口，默认 4173 |
| `confirmations` | 交易确认数，默认 3 |
| `quoteTtlMs` | 报价有效期，默认 120000 毫秒 |

网络需要代理时可在首次安装使用：

```sh
node scripts/install-skill.mjs --proxy http://127.0.0.1:7890
```

配置变更后重启相应进程。停止钱包服务使用 `node src/cli.mjs service.stop`；网页前台调试可运行 `node src/web-server.mjs`，用 Ctrl+C 停止。

## CLI 与多账户

```sh
./scripts/codex-wallet help
./scripts/codex-wallet accounts
./scripts/codex-wallet account.add account-a
./scripts/codex-wallet account.connect account-a
./scripts/codex-wallet status --account account-a
./scripts/codex-wallet submit --account account-a --file request.json
```

未指定账户时使用原账户 `default`。新账户首次连接后固定绑定钱包，后续不得静默换成其他地址。新增档案支持 direct transport。

批量任务先生成计划，再执行同一计划的授权：

```sh
./scripts/codex-wallet batch.plan --accounts account-a,account-b --file batch-action.json
./scripts/codex-wallet batch.run --file approved-batch.json
./scripts/codex-wallet batch.status <batch-id>
./scripts/codex-wallet batch.pause <batch-id>
./scripts/codex-wallet batch.resume <batch-id>
```

付款上限只限制 BNB 本金，gas 另计。服务重启后未完成批次暂停，已提交交易继续对账。归档是账户分组，不会注销会话、删除历史或取消已授权批次。

结构化请求、预算、合约事件校验及未知提交恢复见 [请求说明](skills/codex-project-wallet/references/requests.md)。

## Codex skill

skill 位于 [skills/codex-project-wallet](skills/codex-project-wallet/SKILL.md)，安装命令会同步至当前 Codex 的 skills 目录，并写入本机入口路径。项目移动后重新执行安装命令。

```sh
node scripts/install-skill.mjs
node ~/.codex/skills/codex-project-wallet/scripts/wallet.mjs web
```

可在 Codex 使用 `$codex-project-wallet`，指定项目、账户、操作与付款范围。安装 skill 或改造代码不会构成真实交易授权。

## 目录

```text
web/                          网页前端，无构建步骤
src/web-server.mjs            本机网页服务及受限 API
src/server.mjs                Unix socket 钱包服务
src/accounts.mjs              账户与设备档案隔离
src/batches.mjs               持久化批量任务
src/engine.mjs                预览、执行、幂等及对账
src/binance-*.mjs             币安接口与会话
skills/codex-project-wallet/   Codex skill 与请求文档
scripts/                      启动、安装和验证工具
test/                         隔离自动化测试
docs/                         架构与验证说明
```

## 验证

```sh
npm test
npm install --global playwright
npm run test:web
```

浏览器测试默认使用 macOS 的 Google Chrome；其他平台可设置 `CODEX_CHROME_EXECUTABLE` 指向本机 Chrome。测试使用临时目录、模拟币安接口和本地链，不使用真实登录或支付主网 gas。验证范围见 [docs/validation.md](docs/validation.md)。

`npm run smoke` 需要自行登录的钱包，执行真实接口读取和未提交的预览，随后取消预览；`npm run benchmark:wallet` 比较只读接口耗时。它们生成的报告包含本地钱包信息，默认已被 Git 忽略，不应上传。

## 数据边界

仓库只提供代码和通用文档，不包含运行目录、账户档案、密钥、cookie、签名、数据库、配对二维码、日志或个人交易记录。`.gitignore` 排除这些文件及本机验收笔记。

网页通过 Unix socket 调用当前钱包服务，只开放账户维护、扫码配对和历史查询；HTTP 接口没有通用签名或交易提交入口。写操作校验同源与 CSRF，登录二维码在本机生成。

更多实现边界见 [架构说明](docs/architecture.md)。
