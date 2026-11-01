# 结构化请求

金额内部字段是整数十进制字符串；quote 可用人类单位 amount。输入 native 表示 BNB，token 地址必须是完整地址。滑点 slippageBps=100 表示 1%。每个新意图使用稳定且唯一的 idempotencyKey，同一次请求重试复用该键；旧操作失败后重新准备使用新键。

## 多账户与批量任务

单号使用 `--account a`，旧账户为 default。账户创建：`account.add a`；配对：`account.connect a`；列表：`accounts`。账户文件可选 expectedAddress 和 deviceProfile，例如：

~~~json
{"alias":"a","expectedAddress":"<该账户预期钱包>","deviceProfile":{"mac":"02:19:41:ab:cd:ef","hostname":"wallet-a","platform":"darwin","release":"24.6.0","language":"zh-CN","timezone":"Asia/Tokyo"}}
~~~

expectedAddress 不清楚时省略，首次连接后固定绑定。deviceProfile 可整个省略，服务自动创建不同且固定的档案；MAC、hostname、platform+release 与其他账户冲突会拒绝。新档案不自动登录。

`account.add` 可选 displayName、notes。`account.update --account a --file metadata.json` 接受 `{"displayName":"空投账户","notes":"账户用途","archived":false}`；只改显示名称、备注和分组，不修改 alias、绑定钱包或设备档案。归档不注销登录、不删除历史，也不取消已经授权的任务。网页使用 `web` 命令启动，仅监听本机；配置 webPort 可改变端口，rpcProxy 可独立设置只读链上请求的代理（空字符串为直连），不改变钱包接口使用的 proxy。

批量计划示例（batch-action.json）：

~~~json
{
  "idempotencyKey":"<本次批次稳定 UUID>",
  "action":"project.mint",
  "params":{"url":"https://bnagent.onrender.com","shares":"1","maxCostUsdt":"<每账户允许的表价上限>"},
  "limits":{"maxValueWeiPerAccount":"<每账户 BNB 付款上限 wei>","maxTotalValueWei":"<全部选中账户合计付款上限 wei>"}
}
~~~

执行 `batch.plan --accounts a,b --file batch-action.json`。选择单号可用 `--accounts a`，全选用 `--accounts all`；也可省略该选项，在 JSON 放 `"accountIds":["a","b"]` 或 `"accountIds":"all"`，两处不要重复指定。

明确 ABI 的合约批量用 `"action":"submit","params":{"request":{...}}`，request 格式与普通 submit 一致，不必提供子任务幂等键。ABI 参数或预期事件接收人中的完整字符串 `"$wallet"` 会逐账户替换；不会替换嵌在其他文本内的字符串。计划返回每账户的实际预览与 confirmationToken。

聚合卖出用 `"action":"sell","params":{"token":"<完整代币地址>","slippageBps":1000,"gasLevel":"MEDIUM"}`。省略 amountRaw 时按各账户计划时的实际余额固定数量；执行不会把新增余额自动加进去。非 BNB 输入的付款 limits 可为 "0"；BNB 输入必须显式 amountRaw 并设置足够的付款 limits。BNB 买入稳定币的滑点沿用用户本次选择。market 不传 gasLimit 或 limits.maxGasLimit。

batch.plan 只生成预览，不签名或广播。获得用户对该列表、动作、金额和新增风险的授权后，调用 batch.run：

~~~json
{"id":"<返回的 batch id>","planToken":"<原计划 planToken>","approved":true}
~~~

批次内的合约操作绑定 batchId，必须通过 batch.run 执行；不能单独 confirm 子操作来绕过批次预算。可以使用各账户的 operation / reconcile 查询和核对已提交结果。

批次预算只限制原生币本金付款，gas 另计。合约自定义 gasLimit 须不高于 limits.maxGasLimit；gas 单位上限不是总费用上限。计划过期或参数变化须新建计划；先核对旧批次成功/待核实项，避免重新给它们付款。数量、授权和风险超出原授权范围时先说明。

查询 `batch.status <id>`，暂停 `batch.pause <id>`，继续 `batch.resume <id>`，取消未提交任务 `batch.cancel <id>`。服务重启后的批次暂停，已提交操作自动对账；resume 沿用原授权，不绕过预览期限。账户在计划时未登录的任务需重新生成计划，不会因后来登录而被旧授权自动执行。

本版多账户支持独立币安授权会话；同一币安登录内部任意选择子钱包和通用第三方项目 cookie/token 管理尚未实现。设备字段不同只表示客户端上报档案不同，真实设备登记与并行登录限制需实际授权验收。

## 已授权的一次提交

`submit` 一次完成内部 preview 和 execute。先确认用户已授权当前目标、数量和付款范围；没有授权不能设 approved=true。maxValueWei 是实际 BNB 付款硬上限，不含网络费；自定义 gas 仅在用户授权后传，同时给 maxGasLimit。

~~~json
{"request":{"kind":"contract","idempotencyKey":"<稳定 UUID>","to":"<已核实合约>","abi":["function mint(uint256 quantity) payable"],"method":"mint","args":["1"],"value":"<付款 wei>","expected":{"kind":"event","abi":["event Minted(address indexed receiver,uint256 quantity)"],"event":"Minted","args":{"receiver":"<当前钱包>","quantity":"1"}}},"authorization":{"approved":true,"maxValueWei":"<用户授权付款上限 wei>"}}
~~~

成功只返回状态 / 哈希等摘要；needsReview=true 时返回完整解析、模拟、风险和权限变化，等待具体新增风险的确认。网络超时不自动重发，也不换 CLI；明确模拟拒绝的重新报价 / 重建请求由下面 sell 流程处理。相同请求重用同一 idempotencyKey，已有提交不会再次 execute。

## 卖出：币安聚合，默认 10% 滑点

`sell` / `sell.quote` 默认通过币安 CLI 同一套聚合 API（quote / place-order / batch-query-market-orders），由本地服务直连 HTTPS，复用会话和连接，不启动 CLI 子进程。路由、税费和钱包授权策略由币安返回，不固定到 PancakeSwap V2。

~~~json
{"token":"0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB","idempotencyKey":"<本次卖出 UUID>","slippageBps":1000,"mev":true,"gasLevel":"MEDIUM","authorization":{"approved":true}}
~~~

默认卖出当前全部余额换 BNB；指定部分数量用 amountRaw（整数原始单位）。toToken 可选 BNB、USDT 或 USDC。服务将 amountRaw 按 decimals 精确转成 CLI 的人类单位；slippageBps=1000 转为币安 API 的 slippage="0.1"，不是 "10"。显式滑点优先，默认 MEV 开启。

BNB 换 USDT / USDC 也可走同一聚合 sell 入口：token 用原生 BNB 地址 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE，toToken 填目标稳定币，必须显式给 amountRaw（wei），不支持自动卖光 BNB，以保留网络费。BNB 买入稳定币时显式指定适合该次交易的滑点，不把卖出默认 10% 自动套用到买入。此接口为 exact-input，目标买入数量只能按新鲜报价估算，实际到账以回执和订单为准。

只询价用 `sell.quote`：`{"token":"<完整地址>"}`。已卖光后也可以用 `{"token":"<完整地址>","amountRaw":"<历史数量原始单位>"}` 验证聚合是否支持该币，这不检查持仓够不够、不下单。

聚合订单仅支持 gasLevel=LOW / MEDIUM / HIGH，不传合约调用用的 gasLimit / authorization.maxGasLimit。普通加密代币走此路径；tokenized securities 需要份额换算，直连版尚未适配，不能把原始余额当份额下单。

- 用户授权卖出时，一次调用完成余额、聚合报价、下单和订单 / 回执核验。orderId 不是成交；PENDING / MARKET_PENDING 不重复下单。FINISHED 且规范回执成功、足够确认后才返回 CONFIRMED。
- 返回 receivedAmount / receivedBnb、remainingTokenRaw、partialFill。有效 refund 或仍有剩余余额时报告部分成交，不能仅因 refund 字段缺失就宣称全部成交。
- 953401 / 351805 等明确模拟拒绝、且没有提交证据时，立即刷新聚合报价重新下单，最多 3 次；保持原数量和 10% 或用户指定滑点。
- 网络超时 / 未知响应不重发；带 orderId 的错误转为查询该订单，避免重复。平台拦截不改走手工合约调用。
- 单协议卖出仅保留显式入口 sell.v2 / sell.v2.quote，需用户指定；不得在聚合失败时自动回退。普通 quote / submit 的旧 V2 路径也不是默认卖出入口。

## BNAGENT 固定适配

`project.mint.quote` 为只读：`{"url":"https://bnagent.onrender.com","shares":"max"}`。可用量为 min(10, 剩余额度, 剩余供应)。当前额度已用完会直接返回 QUOTA_EXHAUSTED。

已授权的 `project.mint` 输入：

~~~json
{"url":"https://bnagent.onrender.com","shares":"max","idempotencyKey":"<本次意图 UUID>","maxCostUsdt":"<允许的当前表价上限>","gasLimit":800000,"authorization":{"approved":true,"maxValueWei":"<允许的 BNB 付款上限 wei>","maxGasLimit":800000}}
~~~

800000 仅演示本次用户主动提高 gas 的授权，不是全局默认。固定官网、mint / token 地址和运行时代码哈希；服务自动读取当前 walletStatus、paused、供应、costOf 和 bnbQuote，按 BNB 报价的 102% 封顶调用 mintWithBnb，referrer 为零，核验 BNAGENT Transfer 到本钱包。没有额外 USDT approve。

maxCostUsdt 限制**读取时的表价**；BNB 路径的实际硬上限是 maxValueWei，包含 2% BNB 报价余量。出块前美元价格或阶梯价格可能变动，不宣称存在合约级 USDT 价格锁。需要严格 USDT 锁价时使用已核实的 USDT mint(maxCost) 路径及独立限额授权。

## 用户明确授权的未知提交恢复

只有用户明确接受重复付款风险并要求重试，才在 submit / project.mint 的 authorization 或 confirm 顶层加入：

~~~json
{"acknowledgedUnknownOperationIds":["<具体 UNKNOWN_SUBMIT 操作 ID>"],"duplicatePaymentRiskAccepted":true}
~~~

这只解除点名 UNKNOWN_SUBMIT 的本地阻塞，旧操作保留真实状态；钱包锁、真实广播任务、金额限制和币安风险拦截不受影响。不得把旧恢复授权自动用于新的未知提交。

## 报价 / 买卖

~~~json
{"tokenIn":"native","tokenOut":"0x55d398326f99059fF775485246999027B3197955","amount":"0.001","slippageBps":100}
~~~

quote 使用上述请求。prepare 再加 "kind":"swap","idempotencyKey":"<本次意图的 UUID>"。卖出 tokenIn 是代币地址，tokenOut 可为 native 或另一代币。普通 V2 路径仅比较直连及经 WBNB 的两跳，不保证覆盖新内盘、V3、转账税或全市场最优路由。

通用 V2 swap 返回 APPROVAL_REQUIRED 时，需要本次卖出量的限额 approve，确认授权生效后再换币。默认卖出优先用聚合 sell，由币安处理路由和钱包授权策略；不要把 V2 的手工 approve 套到聚合流程。

## 明确 ABI 的合约调用

~~~json
{
  "kind":"contract",
  "idempotencyKey":"project-mint-20261029-01",
  "label":"项目 mint",
  "to":"<已核实的目标合约完整地址>",
  "abi":["function mint(uint256 quantity)"],
  "method":"mint",
  "args":["1"],
  "value":"0",
  "expected":{
    "kind":"event",
    "abi":["event Minted(address indexed receiver,uint256 quantity)"],
    "event":"Minted",
    "args":{"receiver":"<当前钱包地址>","quantity":"1"}
  }
}
~~~

ABI、方法和事件必须来自项目真实接口。没有 expected 时只核实成功回执，返回 businessResult.verified=false，不能宣称已得到 NFT 或奖励。

## 项目 SignIn

prepare 的 kind=message、purpose=project-login、origin=官方项目 origin，walletRequest 为项目原样返回的 eth_signTypedData_v4 wrapper。仅支持 primaryType=SignIn；message 中须有匹配钱包的 wallet、匹配 origin host 的 audience 和未过期 expiresAt。domain.chainId=56。当前不支持 Permit/Permit2 与任意 personal_sign。

## 确认、恢复和项目研究

`project.preflight <url>` 也接受 `--file` / `--stdin`：`{"url":"https://agentshift.lol/#genesis"}`。已注册项目返回实时检查结果和分段 timings；未注册项目返回 UNADAPTED 及已有同源研究。SOLD_OUT / CLOSED 后停止当前参与流程，不继续签名。此命令不读取钱包、不签名、不缓存供应。

~~~json
{"id":"<operation-id>","confirmationToken":"<展示过的原预览 token>","approved":true}
~~~

没有预先明确的执行授权时，先展示具体预览，再在用户确认后传 confirm；已有当前金额 / 数量的直接执行授权优先用 submit，避免重复确认。它们都不是测试开关。

reconcile 请求：{"id":"<operation-id>"}；有可靠交易哈希时可加 txHash。events 请求：{"after":0}，按 seq 接续。

project.fetch：{"url":"https://example.com/"}；不带项目凭据，只抓公开文本。

inspect：{"contract":"<完整合约地址>"}，返回链上代码哈希和可读元数据。

project.import：

~~~json
{"name":"项目名","sources":[{"url":"https://example.com/"}],"contracts":[],"summary":"Codex 核实后的项目说明","actions":[],"unverified":["尚未核实的 ABI 或参与条件"]}
~~~
