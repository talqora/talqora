# iOS 开发计划(Commit 级)

> 本文把 `06-音视频深度项目规划.md` 的 M0–M6 拆成**逐 commit 的执行清单**,每条给:提交信息 + 做什么 + 验证。样式统一参考**飞书/Lark**(IM、通话、知识库、文档与本项目形态一一对应)。
> 执行顺序自上而下;同一组内若无依赖可并行。深度层(M3+)的原理/踩坑以 `myReact/docs/音视频技术/项目规划-自研播放器内核.md` 与对应 KB 章为准。

---

## 0. 提交约定与每个 commit 的完成标准(DoD)

**提交信息格式**:`type(scope): 中文描述`
- `type` ∈ feat / fix / refactor / test / perf / build / chore / docs
- `scope`(iOS):auth / im / chat / assistant / doc / call / player / media / audio / core / ui;(后端):server-auth / socket / gateway / infra
- **一事一提**,细粒度;**不带 Co-Authored-By 署名**。

**DoD(每个 commit 提交前必须满足)**:
1. **业务代码与其测试在同一个 commit**(TDD 最佳:先写测试;底线:同 commit)。纯 UI/shader 类无单测的,补快照测试或在 PR 描述写明人工验证步骤。
2. 通过:`swift build` + `swift test` + swiftformat + swiftlint(后两者 mobile-swift 已配 PostToolUse hook)。后端 commit 过其 `make test/lint/build`。
3. 不破坏既有功能(our-chat `dev` 分支,不砍功能)。

**仓库/分支**:iOS 在 `our-chat/mobile-swift`;后端在 `our-chat/server`、`our-chat/gateway`;agent-server 无需改。统一 `dev` 分支(或各自 feature 分支后合 dev)。

**架构基线**:每个功能 = TCA 切片(`@Reducer` State/Action + Service 依赖[protocol+live+mock] + View)。Service 走 swift-dependencies 注入,单测用 mock。

---

## 1. 前置:后端 dual-accept Bearer(在 server/ 与 gateway/)

> iOS 无 cookie jar,必须先让后端认 `Authorization: Bearer`。依据 `docs/技术方案/Web与多端鉴权方案.md` §6.3。**这一组不做,M0 无法起步。**

| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| B-1 | `feat(server-auth): HTTP 鉴权中间件 dual-accept(先 Bearer 后回退 cookie+CSRF)` | 改 server 鉴权中间件:有 `Authorization: Bearer` 则验签(不校验 CSRF),否则走原 cookie+CSRF | 单测:Bearer 通过 / cookie 通过 / 都无则 401;web 原路径不回归 |
| B-2 | `feat(server-auth): 登录接口返回 AT/RT(JSON,供原生端)` | `/user/login` 在保留 Set-Cookie 的同时,按 `Accept`/`client=mobile` 返回 `{accessToken, refreshToken}` JSON | 单测:web 仍拿 cookie、mobile 拿 JSON |
| B-3 | `feat(server-auth): POST /oauth/refresh 用 RT 换 AT(轮换 + 复用检测)` | 新增刷新端点,复用现有 RT 轮换/reuse detection 逻辑 | 单测:有效 RT 换新 AT/RT;旧 RT 复用被拒 |
| B-4 | `feat(socket): Socket.io 握手兼容 Bearer(从 auth/query 取 token)` | `server/src/utils/socket.ts` 握手:cookie 无 token 时从 `handshake.auth.token` 或 query 取并验签 | 单测:Bearer 握手成功;无 token 拒连 |
| B-5 | `feat(gateway): WS 握手兼容 Bearer token` | gateway(Go)握手从 `Authorization` 头或 `?token=` 读并验签(共享 JWT 验证) | Go 单测:Bearer 握手通过 |

---

## 2. M0 · iOS 地基(登录 + 连 socket + 收发文本)

| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M0-1 | `chore(core): App 入口 + RootFeature/AppView 骨架` | Tuist App target 入口,`RootFeature`(占位)+ `AppView` | 空壳能启动到占位页 |
| M0-2 | `feat(core): APIClient(URLSession + baseURL + 统一错误模型)` | HTTP 客户端封装、环境配置(dev/prod baseURL)、错误枚举;含单测 | 单测:200/4xx/5xx/解码失败映射正确 |
| M0-3 | `feat(auth): Keychain 封装 AT/RT 读写` | `KeychainStore`(存/取/删 token);含单测 | 单测:写后可读、删后为空 |
| M0-4 | `feat(auth): AuthService protocol + live(login/refresh/logout)+ mock` | 调 B-2/B-3 接口;token 落 Keychain;含单测 | 单测(mock):登录存 token、刷新更新、登出清空 |
| M0-5 | `feat(auth): AuthFeature reducer(表单/校验/loading/错误)` | TCA 登录状态机;含单测 | 单测:输入→提交→成功/失败 action 流 |
| M0-6 | `feat(ui): 登录页 LoginView(飞书风格)` | SwiftUI 登录界面(对齐飞书登录视觉) | 人工:真机走通登录 |
| M0-7 | `feat(core): Bearer 注入 + 401 静默刷新拦截器(single-flight)` | APIClient 自动带 AT;401→refresh→重放;并发刷新单飞;含单测 | 单测:401 触发一次刷新、并发只刷一次、刷新失败登出 |
| M0-8 | `feat(core): RootFeature 鉴权路由(登录态切换)` | 有 token→主界面、无→登录页;含单测 | 单测:token 存在/缺失路由正确 |
| M0-9 | `feat(im): SocketService 封装(连接/重连/Bearer 握手/事件总线)` | Socket.io 客户端(带 token 握手、自动重连、事件订阅);含单测(mock transport) | 单测:握手带 token、断线重连、事件分发 |
| M0-10 | `feat(chat): 文本消息收发最小闭环(message.send/receiveMessage)` | 发 `message.send`(带 clientMsgId)、收 `receiveMessage`;最小 ChatFeature | 人工:真机与 web 互发文本 |

**M0 验收**:真机登录 → 连上 socket → 与 web 端互收发文本消息。

---

## 3. M1 · 基线 IM + 知识库助手

### 3.1 本地存储与契约
| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M1-1 | `feat(core): GRDB 接入 + 迁移(conversation/message/read 表)` | DB 初始化 + migration;含单测 | 单测:迁移后表存在、增删查 |
| M1-2 | `feat(im): 消息契约模型(对齐 server/contracts/message.ts)` | Codable 模型(clientMsgId/seq/serverMsgId/type/conversationId/extra/fileInfo…);含单测 | 单测:与后端样例 JSON 互转 |

### 3.2 会话列表
| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M1-3 | `feat(im): ConversationService(列表/详情,HTTP + 本地缓存)+ mock` | 拉会话、落 GRDB、读缓存;含单测 | 单测(mock):首屏读缓存、后台刷新 |
| M1-4 | `feat(im): ConversationListFeature(未读/置顶/排序)` | TCA 列表状态机;含单测 | 单测:未读计数、按最后消息排序 |
| M1-5 | `feat(ui): 会话列表 UI(飞书风格:头像/最后消息/未读角标/时间)` | SwiftUI 列表 | 人工:对齐飞书视觉 |

### 3.3 单聊/群聊
| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M1-6 | `feat(chat): ChatFeature(消息流/发送/clientMsgId 幂等/乐观更新)` | 发送乐观插入、回执替换、按 seq 排序;含单测 | 单测:乐观→确认替换、去重 |
| M1-7 | `feat(ui): 聊天页 UI(气泡/时间分隔/输入栏,飞书风格)` | 消息气泡、日期分隔、输入栏(文本/+面板) | 人工:对齐飞书气泡 |
| M1-8 | `feat(chat): 离线增量同步(GET /user/sync since=seq)` | 进会话/重连后按 seq 补拉;含单测 | 单测:断点续拉无空洞 |
| M1-9 | `feat(chat): 已读上报与同步(read.report/read.sync)` | 进会话上报 lastReadSeq、多端同步;含单测 | 单测:单调推进、多端一致 |
| M1-10 | `feat(im): 在线状态 presence 显示` | 订阅 presence、列表/聊天页展示在线 | 人工:对端上下线变化 |
| M1-11 | `feat(chat): 群聊支持(group_ 前缀/成员/@mention)` | 群消息渲染、成员、@;含单测 | 单测:群消息路由、mention 解析 |

### 3.4 知识库助手(消费 agent-server)
| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M1-12 | `build(assistant): swift-openapi-generator 生成 agent-server 客户端类型` | 从 `/api/docs-json` 生成类型与 client | 编译通过、类型可用 |
| M1-13 | `feat(core): SSEClient(URLSession bytes 流式解析 event/data)` | 解析 SSE(支持 POST body、`?access_token=` 兜底);含单测 | 单测:分包/多事件/[DONE] 解析 |
| M1-14 | `feat(assistant): AgentService RAG 问答(SSE: token/done/citations)+ mock` | `POST /api/conversations/:id/messages` 流式;含单测 | 单测(mock):token 累积、done 带 citations |
| M1-15 | `feat(assistant): AssistantFeature(流式累积/停止/错误)` | TCA 流式状态机;含单测 | 单测:逐 token 更新、可中断 |
| M1-16 | `feat(ui): 知识库问答 UI(流式渲染 + 引用卡片)` | 打字机式渲染 + citations 卡片(参考飞书智能伙伴/Perplexity) | 人工:流式 + 引用展示 |
| M1-17 | `feat(assistant): Agent 任务流(POST tasks→runId,GET runs/:id/stream)` | 提交任务、订阅 run 事件;含单测 | 单测(mock):step/tool/final 事件流 |
| M1-18 | `feat(ui): Agent 步骤/工具调用展示(step/tool_called/tool_result 折叠)` | 可展开的步骤/工具调用 UI | 人工:看到工具调用过程 |
| M1-19 | `feat(doc): 文档管理(列表/上传 multipart/摄取状态/删除)+ mock` | 文档 CRUD + 上传进度 + ready/processing 状态;含单测 | 单测:上传进度、状态轮询 |
| M1-20 | `feat(assistant): SSE 断线重连(Last-Event-ID 回放)` | 断线带 Last-Event-ID 续订、去重;含单测 | 单测:重连不重不漏 |

**M1 验收**:完整聊天(单/群/已读/离线)+ 流式问知识库(带引用)+ 看到 agent 工具调用 + 管理文档。

---

## 4. M2 · 基线音视频通话(WebRTC)

| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M2-1 | `chore(infra): 部署 coturn + server ICE 配置下发接口` | 自建 TURN;新增接口下发 `{stun, turn, username, credential}` | NAT 下 ICE 能用 relay 候选 |
| M2-2 | `build(call): 引入 WebRTC iOS SDK(SPM)` | 加 WebRTC 二进制依赖(如 stasel/WebRTC) | 编译链接通过 |
| M2-3 | `feat(call): CallSignaling(复用 SocketService 收发 call:*)` | `call:start/accept/ice/reject/end` 编解码;含单测 | 单测:事件序列化、双向收发 |
| M2-4 | `feat(call): CallService 语音(RTCPeerConnection/音频轨/ICE)+ mock` | PC 生命周期、getUserMedia 音频、ICE 配置取自 M2-1;含单测 | 单测(mock):offer/answer/ice 流程 |
| M2-5 | `feat(call): CallFeature 状态机(呼叫/振铃/接通/挂断/拒接)` | TCA 通话状态机;含单测 | 单测:状态迁移完整 |
| M2-6 | `feat(call): CallKit 集成(系统来电界面/AVAudioSession)` | 来电用 CallKit、配置音频会话 | 人工:锁屏来电界面 |
| M2-7 | `feat(ui): 语音通话 UI(飞书/FaceTime 风格 + 悬浮窗/最小化)` | 通话页 + 最小化悬浮窗 | 人工:对齐飞书通话 |
| M2-8 | `feat(call): 升级视频通话(video transceiver/本地预览/远端渲染)` | 加视频轨、本地预览、远端 RTCMTLVideoView;含单测 | 单测(mock):视频协商 |
| M2-9 | `feat(ui): 视频通话 UI(画中画/前后摄/静音/挂断)` | 视频通话界面 | 人工:iOS↔web 视频互通 |
| M2-10 | `fix(call): pendingIceCandidates 暂存(SDP 前到达的 candidate)` | candidate 早到先存、setRemoteDescription 后补加;含单测 | 单测:乱序 candidate 不丢 |

**M2 验收**:iOS ↔ Web 互打音/视频电话,跨 NAT(经 TURN)接通,CallKit 来电正常。

---

## 5. M3 · 深核 A:视频消息 + 自研播放器内核(项目核心)

> 对应 `项目规划-自研播放器内核.md` iOS M0–M4。**这是"讲得透"的主深核。**

### 5.1 视频消息(录制/上传/气泡)
| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M3-1 | `feat(im): 视频消息 type=video 契约(时长/缩略图/尺寸)` | 扩展 message type;含单测 | 单测:序列化兼容 |
| M3-2 | `feat(player): 小视频录制(AVCaptureSession + AVAssetWriter H.264/AAC)` | 录制+编码落文件;含单测 | 单测:产出可解析 MP4 |
| M3-3 | `feat(im): 视频消息上传(复用 S3 分片/断点续传)+ 缩略图` | 上传 + 首帧缩略图;含单测 | 单测:断点续传、缩略图生成 |
| M3-4 | `feat(ui): 视频消息气泡(缩略图 + 时长,点击进播放)` | 气泡 UI | 人工:发送/展示 |

### 5.2 播放器 M0 跑通(先靠系统组件出画面)
| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M3-5 | `feat(player): 骨架 + AVAssetReader demux + VTDecompressionSession + AVSampleBufferDisplayLayer 出画面` | 最朴素链路跑通(无同步) | 人工:小视频能出画面 |

### 5.3 播放器 M1 自解封装(深核·KB 09)
| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M3-6 | `feat(player): 手写 MP4 box 遍历(moov/trak/mdia)` | box 解析;含单测(对照 AVAsset) | 单测:box 树正确 |
| M3-7 | `feat(player): stbl 五表解析(stts/stsc/stsz/stco/stss)` | 解析为 sample 表;含单测 | 单测:sample 偏移/大小正确 |
| M3-8 | `feat(player): 时间→字节偏移 + 最近关键帧定位` | seek 索引;含单测 | 单测:任意时间定位到正确 IDR |
| M3-9 | `feat(player): NAL 分割 + SPS 解析(分辨率/Exp-Golomb)+ avcC` | 码流解析;含单测 | 单测:分辨率提取正确 |
| M3-10 | `refactor(player): 用自研解封装喂解码器(替换 AVAssetReader)` | 切到自研 demux | 人工:仍正常出画面 |

### 5.4 播放器 M2 解码 + Metal 渲染(深核·KB 08/20)
| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M3-11 | `feat(player): VTDecompressionSession 驱动 + DPB 重排(回调乱序)` | 异步解码 + 按 PTS 重排;含单测 | 单测:乱序回调重排为序 |
| M3-12 | `feat(player): Metal NV12 渲染 + CVMetalTextureCache 零拷贝` | 自写渲染层 | 人工:画面正常 |
| M3-13 | `feat(player): YUV→RGB shader(BT.601/709 + range,处理 stride)` | shader 色彩转换 | 人工:无绿边/无偏色,601/709 可切换 |

### 5.5 播放器 M3 音频实时线程(深核·KB 21)
| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M3-14 | `feat(player): lock-free SPSC ring buffer(原子指针 + 内存序)` | 无锁环形缓冲;含单测 | 单测:并发读写不丢/不脏读 |
| M3-15 | `feat(player): AURenderCallback 实时音频输出(欠载补静音)` | 实时回调取 PCM 播放 | 人工:连续播放无爆音 |

### 5.6 播放器 M4 A/V 同步(深核灵魂·KB 17/03)
| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M3-16 | `feat(player): Clock(pts_drift + serial + speed)` | 时钟抽象;含单测 | 单测:时钟推进/重置 |
| M3-17 | `feat(player): A/V 同步(音频主时钟 + compute_target_delay 三阈值)` | 同步内核;含单测 | 单测:diff 正负各分支;人工长跑不漂 |
| M3-18 | `feat(im): 视频消息接入自研播放器(替换系统播放)` | 气泡点击→自研内核播放 | 人工:小视频用自研内核播放 |

**M3 验收**:发送的视频消息**用自研播放器内核**播放,音画对齐、色彩正确、无爆音。

---

## 6. M4 · 深核 A:随机访问(seek/起播/缓冲/倍速)

> 对应播放器内核 M5。给"视频文件消息"加进度条交互。

| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M4-1 | `feat(player): seek(回退 IDR + flush 解码器 + queue_serial 丢旧帧)` | 精准/关键帧 seek;含单测 | 单测:serial 丢旧帧;人工:不串帧花屏 |
| M4-2 | `feat(player): 起播秒开(小起播缓冲 + 优先解首个 IDR)` | 起播优化 | 人工:起播 <1s |
| M4-3 | `feat(player): buffering 双阈值滞回状态机` | 缓冲水位状态机;含单测 | 单测:进入/退出阈值 |
| M4-4 | `feat(player): 倍速(时钟 speed + 音频时域伸缩)` | 倍速播放;含单测 | 单测:speed 生效;人工:变速不变调 |
| M4-5 | `feat(ui): 播放器进度条/手势(seek 跟手)` | 全屏播放器 UI | 人工:拖动跟手 |

**M4 验收**:拖进度条跟手不花屏,起播 <1s,弱网进 buffering 能恢复。

---

## 7. M5 · 深核 B:视频通话实时美颜(Metal 管线)

> 对应 KB 20/22。插在 M2 视频通话的采集与编码之间。

| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M5-1 | `feat(media): 自定义 RTCVideoCapturer(AVCaptureSession 喂 WebRTC)` | 替换默认采集;含单测 | 单测(mock):帧回调贯通 |
| M5-2 | `feat(media): CMSampleBuffer→Metal 纹理(CVMetalTextureCache 零拷贝)` | 零拷贝纹理 | 人工:原始帧上屏 |
| M5-3 | `feat(media): YUV→RGB compute shader` | 色彩转换 | 人工:无绿边/偏色 |
| M5-4 | `feat(media): 磨皮 shader(双边/高斯)` | 磨皮 | 人工:磨皮可见 |
| M5-5 | `feat(media): LUT 滤镜(可切换)` | 滤镜 | 人工:切换滤镜 |
| M5-6 | `feat(media): 处理后 CVPixelBuffer→RTCVideoFrame 喂编码` | 接回 WebRTC;含单测 | 单测:输出帧格式正确;人工:对端看到美颜 |
| M5-7 | `feat(ui): 通话美颜入口(开关/强度/滤镜)` | 美颜面板 UI(参考飞书/微信) | 人工:实时调节 |
| M5-8 | `perf(media): 管线帧率 + surface 释放优化 + benchmark` | 性能优化 | benchmark:不掉帧、无内存增长 |

**M5 验收**:视频通话实时美颜/滤镜,不掉帧、无绿边色偏。

---

## 8. M6 · 深核 C(可选)+ 打磨

| # | 提交信息 | 做什么 | 验证 |
|---|---|---|---|
| M6-1 | `feat(audio): 变声 ring buffer 接入通话音频轨` | 音频处理管线;含单测 | 单测:缓冲贯通 |
| M6-2 | `feat(audio): 变调/混响音效(实时线程禁 malloc/锁)` | 音效;含单测 | 单测:处理正确;人工:无爆音 |
| M6-3 | `feat(ui): 变声入口` | 通话变声 UI | 人工:实时变声 |
| M6-4 | `perf(player): 大视频/弱网 benchmark + 优化` | 播放器压测优化 | benchmark 达标 |
| M6-5 | `test(core): 关键路径快照测试补齐` | snapshot 测试 | CI 快照通过 |
| M6-6 | `chore(core): 弱网注入(Network Link Conditioner)联调修复` | 弱网回归 | 弱网不崩、能自适应 |

---

## 9. 依赖关系与关键检查点

**强依赖(必须先做)**:
- 前置后端组(B-1…B-5)→ M0。
- M2-1(TURN)→ M2 视频通话真机互通。
- M3-5(跑通)→ M3-6…(逐步替换为自研)。M3-11(解码重排)与 M3-12(渲染)→ M3-17(同步)。
- M2 视频通话 → M5 美颜(美颜插在通话采集链路)。

**可并行**:M1 的 IM 组(M1-3…11)与 知识库组(M1-12…20)互不依赖;M3 录制组(M3-1…4)与播放器组(M3-5+)可并行起步。

**三个"硬核大山"检查点(过不了别往下)**:
1. **M3-17 A/V 同步**:长跑(>10 分钟)口型不漂 = 立住。
2. **M3-14/15 音频实时**:故意在回调里 malloc 能复现爆音并解释 = 真懂内存序。
3. **M4-1 seek**:快速来回拖动不花屏/不串帧 = serial 机制正确。

**与 KB/规划的回查**:卡住时回 `项目规划-自研播放器内核.md`(深度/踩坑/双端对照)与对应 KB 章(M3 表已标);通话/信令背景见 KB 12/15/25。

---

## 10. 范围护栏(防偏离)

1. 深度只钉在自实现环节(解封装/解码驱动/渲染/音频/同步/美颜),**WebRTC 通话内核当黑盒**,不假装自研 RTC。
2. **先基线后深核**,基线(M0–M2)尽快过,别在调库上耗时间。
3. **深核 A 优先级最高**,B 次之,C 可选;不三线并行。
4. 不自建 SFU、不一上来做直播、不手写编解码器。
5. 后端改动最小化(B 组 + TURN + 视频消息 type),遵守 our-chat「不砍功能、长连接走 gateway」。
