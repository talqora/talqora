# iOS 小程序「AI 问答」三个 bug 排查复盘 —— SSE 分帧、TCA 加载触发,与被证伪的连接池假设

> 范围:iOS 端(mobile-swift)小程序「知识库助手」三个 tab(对话/知识库/任务)在真机上的三类故障——**对话 AI 回复不实时渲染(退出重进才出现)**、**任务 tab 不产出**、**知识库 tab 一直转圈**——的完整排查与修复。重点在**底层技术细节**与**排查方法论**(如何用服务端日志做 ground truth、如何证伪错误假设)。
>
> 结论先行:三处是**两类根因**——① `URLSession.AsyncBytes.lines` 吞掉 SSE 的**空行分帧符**,使自研 `SSEParser` 永远吐不出帧(对话/任务共因,占核心);② 知识库 View **漏接 `.task` 加载触发**,`phase` 永停 `.idle` 一直转圈。过程中先后**证伪**了"网络抖动""连接池饥饿""`user_id=0` 异常"等假设——**靠 nginx 真实访问日志把它们逐一排除**。另有一个基于错误假设做的防御性改进(agent 独立 `URLSession`)予以保留。

---

## 0. 术语表(先读)

| 术语 | 全称 / 含义 | 通俗解释 |
|---|---|---|
| **SSE** | Server-Sent Events | 基于 HTTP 的"服务端→客户端单向流式推送"。一条响应里持续 `write` 多个事件,直到关闭。 |
| **SSE 帧格式** | — | 每个事件是若干 `field: value` 行,**以一个空行(`\n\n`)结束**。常见字段 `event:`(事件名)、`data:`(负载)。空行是**帧分隔符**。 |
| **EventSource** | 浏览器原生 SSE 客户端 | Web 端 `new EventSource(url)`,浏览器**自带**符合规范的 SSE 解析(正确处理空行分帧)。 |
| **`URLSession.AsyncBytes`** | Apple | `URLSession.bytes(for:)` 返回的**异步字节流**,可 `for await` 逐字节消费;`.lines` 是其"按行"封装。 |
| **`.lines`(AsyncLineSequence)** | Apple | 把字节流**按换行切成一行行**,**产出的行不含行尾换行符**。关键坑:**对空行的产出行为不可依赖**(见 §3)。 |
| **`res.flushHeaders()` / `res.write()`** | Node http | 立刻把响应头/数据块**冲刷**到 socket,不等缓冲攒满——SSE 逐字实时的前提。 |
| **`X-Accel-Buffering: no`** | nginx 约定 | 让 nginx **对该响应关闭代理缓冲**,SSE 才能穿透而不被攒批。 |
| **`proxy_buffering off`** | nginx 指令 | 同上,nginx 侧关闭对上游响应的缓冲。 |
| **TCA** | The Composable Architecture | 本项目 iOS 架构:单向数据流,`State`/`Action`/`Reducer`/`Effect`。 |
| **`@ObservableState`** | TCA | 让 `State` 可被 SwiftUI 精确观察;改哪个字段就只刷哪块视图。 |
| **Effect(`.run`)** | TCA | Reducer 返回的副作用(异步任务);内部 `await` 拉数据,再 `send` 回 Action 改 State。 |
| **`.cancellable(id:)`** | TCA | 给 Effect 挂可取消 id;`cancelInFlight: true` 表示同 id 的旧 Effect 先取消。 |
| **`.task { }` / `.onAppear`** | SwiftUI | 视图出现时执行;TCA 里常用来 `store.send(.onAppear)` 触发首屏加载。 |
| **JWKS 联合身份** | — | agent-server 用主站 JWKS 公钥验 token,按 `(iss,sub)` 映射到自己库里的联合用户。 |
| **`timeoutIntervalForRequest` / `ForResource`** | URLSession | 前者是"**两次数据到达之间**"的超时(默认 60s);后者是"**整个请求(含排队)**"的上限(默认 **7 天**)。区别是本次一个关键认知点(§6)。 |

---

## 1. 现象与背景

小程序「知识库助手」是一个 3-tab 容器(TabView):**对话**(RAG 流式问答)、**知识库**(文档上传+列表)、**任务**(异步 agent 任务,流式结果)。真机(登录用户「涂将」,id=0)上表现:

1. **对话**:发消息后 AI 回复**不逐字出现**;界面卡在"思考中…"。**退出该会话再进去,回复就整段出现了**。
2. **任务**:提交任务后**始终不产出结果**。
3. **知识库**:进入即**一直转圈**,永不加载出文档列表。

> 用户明确:①②③ 里,"慢/退出重进才出现"这些描述**都是针对对话**的;知识库/任务是各自独立的毛病。这条澄清后来把排查方向从"一个共性故障"纠正为"多根因"。

---

## 2. 排查方法论:别猜,先拿服务端 ground truth

真机端只有一串 Xcode 控制台日志(含大量系统噪音:`Hang detected`、`Received external candidate resultset`、`AX Lookup` 等无关项)。**光看客户端日志容易陷入猜测**。正确姿势是**先用服务端把"是不是服务端的锅""请求到底有没有成功"钉死**,再回到客户端。

### 2.1 逐层排除服务端(SSH 上生产机)

- `docker ps`:`agent-node-server`(NestJS RAG)`healthy`,`our-chat-server`(签 token)`healthy`;agent-server 是**独立 docker 栈**,经 nginx `/agent/` 反代。
- `docker logs agent-node-server`:近 3 小时**零 error/warn**,且有 `对话生成完成 conversation=3`——**RAG 管线真实跑通过**。
- nginx 配置(web 容器内 `nginx -T`):`location /agent/` 已 `proxy_buffering off` + `proxy_read_timeout 3600s`;HTTP/2。**服务端 SSE 通路正确**。
- agent-server SSE 实现:`conversations.controller` 用 `@Res()` 手写 SSE,设 `Content-Type: text/event-stream` + `X-Accel-Buffering: no` + `res.flushHeaders()` + 逐事件 `res.write('event: …\ndata: …\n\n')`。**逐字冲刷,无应用层缓冲**。

**小结:服务端从 nginx 到 agent-server 到 RAG,端到端正确。**

### 2.2 被证伪的假设(重要:错误假设也要记账)

| 假设 | 为何看似成立 | 如何被证伪 |
|---|---|---|
| **网络抖动** | 客户端日志有 `nw_resolver … did not receive all answers in time for tujiang.tech:443`(DNS 未按时返回) | 用户**换网络仍复现**;且 nginx 日志显示请求**照常 200 成功**。DNS 那条多为 IPv4/IPv6 双查询的良性噪音。 |
| **`user_id=0` 身份异常** | token 载荷 `{"id":0,"username":"涂将"}`,web 端是 id=1 | 查库 `users`:**id=0 是真实用户「涂将」**(id 1~5 皆真人)。身份链路正常,还成功生成过 conversation=3。红鲱鱼。 |
| **`URLSession.shared` 连接池饥饿** | socket.io 长轮询 + SSE 长连接共用 shared 池;REST 排队时长受 `ForResource`(默认 7 天)约束 → 疑似"无限转圈";退出取消 SSE 释放连接 → 重进就好 | **nginx 访问日志一锤定音**(见 2.3):REST 请求**根本都是 200/201 秒回**,没有排队、没有卡住。连接池不是本案主因。 |

### 2.3 一锤定音:nginx 访问日志(web 容器 `docker logs`)

```
"GET  /agent/api/conversations           HTTP/2.0" 200 111
"GET  /agent/api/conversations/3         HTTP/2.0" 200/304
"POST /agent/api/conversations/3/messages HTTP/2.0" 201 4183   ← 关键
```

- `POST …/messages` 返回 **201,body 4183 字节**:**服务端把整段流式回复(4183B)完整发给了设备**。
- **整段日志里没有任何 `/agent/api/documents`、`/tasks` 请求**:知识库/任务 tab 的请求**压根没发出去**。

**两个铁证**:
1. 对话:数据到了设备(4183B),但**客户端没渲染** → 客户端**解析/处理**层的锅。
2. 知识库:请求**没发** → 客户端**触发加载**层的锅。

方向由此彻底转向客户端,且分裂成两个独立根因。

### 2.4 一段"不能踩"的历史:`forceWebsockets`

排查中一度想给 socket 加 `.forceWebsockets(true)`(它卡在 polling)。查 git 史发现提交 `2758c7c fix(音视频): iOS socket 去掉 forceWebsockets`:**开启它会让 iOS socket 进不了服务端 presence、`call:start` 发不出、被叫收不到**——socket.io v4 的已知连接坑,当时**特意去掉、对齐 web 的"轮询→升级"**。故 **socket 卡 polling 是有意为之的可用态,不能动**;且与本案三个 bug 无关。

> 方法论沉淀:**改动前先翻相关文件的 git 史**,避免重踩已被修过的坑。

---

## 3. 根因一(核心):SSE 空行分帧被 `.lines` 吞掉

### 3.1 SSE 线格式与"空行分帧"

一个 SSE 事件在 wire 上长这样(注意**结尾是空行**):

```
event: token\n
data: {"type":"token","value":"你"}\n
\n                     ← 空行:帧分隔符(与上一行换行合成 \n\n)
```

**空行(`\n\n`)是帧边界**。解析器必须靠它切分事件。

### 3.2 客户端原实现(有 bug)

`AgentAPIClient.stream` + 自研 `SSEParser`:

```swift
// SSEParser:靠 "\n\n" 切帧
while let range = buffer.range(of: "\n\n") { … emit frame … }

// AgentAPIClient.stream(改前):
for try await line in bytes.lines {
    // bytes.lines 去掉了换行;补回 "\n"。指望"空行 → \n"凑出 "\n\n"
    for frame in parser.consume(line + "\n") { continuation.yield(frame) }
}
```

设计**默认 `bytes.lines` 会把空行也产出为一个 `""`**,于是"空行 + 补的 `\n`" = `"\n"`,与上一行的 `\n` 合成 `\n\n` 触发分帧。

### 3.3 底层真相:`AsyncLineSequence` 对空行的产出不可依赖

`URLSession.AsyncBytes.lines`(`AsyncLineSequence`)按换行切行、**行不含换行符**。问题在于:它对**连续换行/空行的产出行为并不保证会吐出空字符串**——实测下 SSE 的空行**被"吞"掉了**,没有作为 `""` 产出。

于是解析器实际喂入序列变成:

```
consume("event: token\n")
consume("data: {...}\n")
consume("event: token\n")   ← 空行没了,直接下一帧
consume("data: {...}\n")
…
```

`buffer` 累积成 `event:…\ndata:…\nevent:…\ndata:…\n`——**永远出现不了 `\n\n`**。结果:**`SSEParser` 一帧都吐不出来**,`continuation.yield(frame)` 从不触发。

沿数据流往上:

```
服务端 write 4183B  →  nginx 200 转发  →  设备收到 4183B
      →  bytes.lines 吞空行  →  SSEParser 不分帧  →  Effect 不 send(.streamEvent)
      →  Reducer 不改 messages[last].content  →  视图不渲染("思考中…"卡住)
```

而服务端 RAG **照常生成并入库**(与客户端连接无关);用户**退出会话再进 → 触发 `GET /conversations/:id` → 从库里取回整段回复** → "重进就出现了"。**Web 用浏览器原生 `EventSource`,分帧由浏览器负责,故不受影响**——完美解释"只有 iOS 挂"。

### 3.4 修复:逐字节读,保住空行分帧

不再依赖 `.lines` 的空行行为,改为**逐字节消费,遇 `\n` 就把「含该换行的整行」原样喂给解析器**——空行(单独一个 `\n`)因此被保留:

```swift
var parser = SSEParser()
var lineBytes = [UInt8]()
for try await byte in bytes {
    lineBytes.append(byte)
    guard byte == 0x0A else { continue }        // 0x0A = "\n"
    if let s = String(bytes: lineBytes, encoding: .utf8) {
        for frame in parser.consume(s) { continuation.yield(frame) }  // 含换行,\n\n 得以成形
    }
    lineBytes.removeAll(keepingCapacity: true)
}
if !lineBytes.isEmpty, let s = String(bytes: lineBytes, encoding: .utf8) {
    for frame in parser.consume(s) { continuation.yield(frame) }        // 冲刷残尾
}
```

要点:
- **UTF-8 安全**:换行符 `0x0A` 永不作为多字节 UTF-8 序列的一部分出现,故按 `\n` 切出的每段都是完整 UTF-8,`String(bytes:encoding:.utf8)` 必成功;中文 token 不会被拦腰截断。
- **仍是增量的**:每收到一个事件的空行即吐帧,逐字渲染不变。
- **任务 tab 同因同修**:`/runs/:runId/stream` 也走 `agentAPI.stream`,同一套解析,**本修复一并修好**"任务不产出"。

---

## 4. 根因二:知识库 tab 漏接加载触发(TCA + SwiftUI 生命周期)

### 4.1 现象到代码

`AgentDocumentsFeature` 的加载是**惰性**的——只有收到 `.onAppear` 才 `phase = .loading` 并发 `GET /documents`:

```swift
case .onAppear:
    guard state.phase == .idle else { return .none }
    state.phase = .loading
    return .run { … GET /documents … }
```

而 `AgentDocumentsView` 的 body**根本没有 `.onAppear`/`.task`** 去 `store.send(.onAppear)`。于是 `phase` 永远停在初始的 `.idle`;而视图对 `.idle` 与 `.loading` **都渲染 `ProgressView()`**:

```swift
switch store.phase {
case .idle, .loading: ProgressView()   // ← 永远命中 .idle
…
}
```

**加载动作从不触发 → 请求从不发出(与 §2.3 "nginx 无 /documents 记录"完全吻合)→ 永久转圈。**

### 4.2 修复

补上首屏加载触发(与对话列表页 `AgentChatListView` 的 `.task { store.send(.onAppear) }` 一致):

```swift
.task { store.send(.onAppear) }   // 首次出现即拉文档列表;缺它则 phase 永停 .idle 一直转圈
```

> 为何用 `.task` 而非 `.onAppear`:`.task` 绑定视图生命周期、退出自动取消,契合"进入即拉一次"的语义,也符合仓内 UX 规范。

---

## 5. 附:被证伪但保留的改进 —— agent 独立 `URLSession`

§2.2 的"连接池饥饿"假设虽被 nginx 日志证伪(**非本案主因**),但顺手做的加固**本身是良性最佳实践**,予以保留:

- 新增 `AgentHTTP`:给 agent 一套**与 `URLSession.shared`/socket.io 隔离的独立 `URLSession`**(独立连接池),避免长连接(socket 轮询、SSE)与 REST 互相挤占。
- `rest` 会话 `timeoutIntervalForResource = 30`:**即使将来真的排队/卡住,也 30s 内快速失败可重试**,而非默认 7 天(见 §6)。`stream`/上传会话放宽到 3600s。

### 6. 顺带厘清:`URLSession` 两个超时的语义(易错点)

| 配置 | 计时对象 | 默认 | 本案意义 |
|---|---|---|---|
| `timeoutIntervalForRequest` | **两次数据到达之间**的最长间隔 | 60s | 请求"已开始传输"后才计;**排队等连接的阶段不计入** |
| `timeoutIntervalForResource` | **整个资源请求(含排队)**的总上限 | **604800s(7 天)** | 一旦请求因连接池满而**长时间排队**,受这个约束——默认等于"几乎不超时",表面就像"无限转圈" |

这也是"连接池饥饿"假设当初**看起来很合理**的原因:它能自洽地解释"无限转圈 + 退出重进就好"。**但合理 ≠ 正确**——最终由日志证据推翻。教训:**假设要能被证据证伪,别停在"自洽"。**

---

## 7. 验证与边界

- 三处修复(SSE 逐字节分帧、知识库 `.task`、agent 独立会话)均 **`xcodebuild` BUILD SUCCEEDED**。
- **运行时需真机复测**:对话逐字流式出字、任务出结果、知识库能加载出列表。命令行只能验证**编译**,交互正确性要上设备(仓内规范:iOS 构建/交互以命令行 + 真机为准)。
- 若仍有残留:可临时给 agent-server 加**请求级日志**(状态码 + 耗时),把设备侧请求逐条钉死。

---

## 8. 经验教训(方法论沉淀)

1. **服务端日志是 ground truth**。客户端日志噪音大、易误导;`nginx 访问日志`(状态码 + body 字节)一条 `POST …/messages 201 4183` 就同时排除了"服务端故障"和"请求没到",把范围收敛到客户端解析层。
2. **红鲱鱼要主动排除**:`user_id=0` 看着可疑,查库发现是真实用户;DNS 超时看着像网络,换网仍复现。**存疑就去证据里查,别顺着猜下去**。
3. **假设必须可证伪**:"连接池饥饿"能自洽解释全部现象,但被日志证伪。自洽只是必要条件。
4. **改动前翻 git 史**:`forceWebsockets` 是被修过的坑,翻史避免重踩。
5. **跨端差异定位法**:"web 正常、iOS 挂"直接把矛头指向**两端不同的那一层**(浏览器 `EventSource` vs iOS 自研 `SSEParser`),快速锁定 SSE 解析。
6. **平台 API 的边角行为不可想当然**:`AsyncLineSequence` 对空行的产出行为就是本案元凶。**涉及协议分帧,宁可自己按字节保帧,也别赌高层封装的隐式行为。**
