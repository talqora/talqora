// authView 的简历数据。
//
// 这里**只放结构化双语数据**(姓名 / 工作 / 项目 / 技能),它们本质就是"双语
// 内容"而非"翻译目标",故保持 `{ zh, en }` 形状,由 useLang() 选语言读取。
//
// 纯 UI 文案(按钮、标题、校验提示等)统一在 src/locales/{zh,en}.ts,由
// react-i18next 的 useTranslation('translation', { keyPrefix: 'auth' }) 读取。
import type { AppLang } from '@/i18n';

export interface I18nText { zh: string; en: string }
export type I18nBullets = { zh: string[]; en: string[] };

export const PROFILE = {
  name:   { zh: '涂将', en: 'Tu Jiang' },
  pinyin: 'TU JIANG',
  age:    { zh: '20 岁', en: '20 y/o' },
  school: { zh: '东华理工大学 · 28 届本科', en: 'East China Univ. of Tech · Class of 2028' },
  intent: { zh: '全栈开发 · 偏前端', en: 'Full-stack · Front-end leaning' },
  slogan: { zh: 'Hi!', en: 'Hi!' },
  award:  { zh: '蓝桥杯算法竞赛 · 国奖', en: 'Lanqiao Algorithm Contest · National Award' },
  phone:  '+86 185 7919 4952',
  email:  '3235159187@qq.com',
  github: 'fdahk',
  juejin: 'fdahk',
} as const;

export interface WorkItem {
  role:       I18nText;
  company:    I18nText;
  period:     string;
  location:   I18nText;
  highlights: I18nBullets;
  stack:      string[];
}

export const WORKS: WorkItem[] = [
  {
    role:     { zh: '全栈工程师', en: 'Full-stack Engineer' },
    company:  { zh: '北京智源人工智能研究院', en: 'Beijing Academy of AI (BAAI)' },
    period:   '2025.09 — 2026.05',
    location: { zh: '北京', en: 'Beijing' },
    highlights: {
      zh: [
        '全栈 owner 十余个模块:实时定位/电子围栏、性能压测体系、可观测性、鉴权账号、推送、AI Camera/ChatBot、对象存储客户端等(Flutter + React + Node/Python)',
        '硬件↔服务端实时定位:裸 TCP + MQTTS 双通信链路、多源定位融合、WGS84↔GCJ02 坐标变换(椭球 + 不动点迭代求逆保证往返不漂移)、Ray Casting 电子围栏判定',
        '账号与鉴权体系:AuthIdentity 纯身份模型 + AT/RT 双 token;服务端校验三方登录(Apple 拉 JWKS 验签、Google verifyIdToken、Facebook Graph);邮箱撞号二次确认防账号接管',
        '后端性能与稳定:k6 + WebSocket + 微基准三层压测,对 335 条路由建分层延迟基准;熔断器 + 指数退避重试 + Keep-Alive 连接池;热读路径引入 fail-open Redis 缓存,缓解 MySQL 连接池耗尽',
        '可观测性闭环:Prometheus + Grafana + 前端 RUM + 飞书告警;自建基于 Dart VM Service 的帧耗时诊断工具定位 jank',
        'BLE 通信与端侧性能:自定义二进制协议(per-opcode Completer 关联请求/响应 + 分包重组)、串行命令队列 + 退避自动重连;图片解码移出主 isolate 消除掉帧、相机 Texture RepaintBoundary 隔离重绘',
        '自研 COS 分片上传器(自适应并发 + 指数退避 + 断点续传);独立负责一个 React 营销网站从开发到部署上线(路由懒加载 + 内容哈希长缓存 / shell no-cache 即时发版)',
      ],
      en: [
        'Full-stack owner of 10+ modules: realtime locating/geofencing, load-testing, observability, auth & accounts, push, AI Camera/ChatBot, object-storage client — across Flutter + React + Node/Python',
        'Device↔backend realtime locating: raw TCP + MQTTS dual link, multi-source fusion, WGS84↔GCJ02 coordinate transform (ellipsoid + fixed-point inverse for drift-free round-trips), Ray-Casting geofence checks',
        'Auth & account system: AuthIdentity pure-identity model + access/refresh tokens; server-side verification of Apple (JWKS) / Google (verifyIdToken) / Facebook sign-in; identity-collision re-confirmation against account takeover',
        'Backend perf & resilience: 3-tier load testing (k6 + WebSocket + micro-bench) baselining latency for 335 routes; circuit breaker + exponential-backoff retry + Keep-Alive pool; fail-open Redis cache on hot reads easing MySQL pool exhaustion',
        'Observability loop: Prometheus + Grafana + web RUM + Feishu alerting; a self-built Dart VM Service frame-time profiler to locate jank',
        'BLE protocol & client perf: custom binary protocol (per-opcode Completer correlation + packet reassembly), serial command queue + backoff auto-reconnect; image decode moved off the main isolate, camera Texture isolated via RepaintBoundary',
        'A self-built COS chunked uploader (adaptive concurrency + exponential backoff + resumable); solely shipped a React marketing site end-to-end (lazy routes + content-hash long-cache / shell no-cache for instant releases)',
      ],
    },
    stack: ['Flutter', 'React', 'Node / Express', 'Python / FastAPI', 'TCP / MQTT', 'Redis', 'Prometheus', 'Grafana', 'k6'],
  },
  {
    role:     { zh: '前端工程师', en: 'Front-end Engineer' },
    company:  { zh: '成都小来空间科技', en: 'Chengdu Xiaolai Space Tech' },
    period:   '2025.08 — 2025.09',
    location: { zh: '成都', en: 'Chengdu' },
    highlights: {
      zh: [
        '微信小程序前端开发(Uniapp + Vue 3)',
        '搭建并桥接影视服务商与终端用户的业务模块',
      ],
      en: [
        'WeChat mini-program front-end development (Uniapp + Vue 3)',
        'Built modules bridging film/TV service providers with end users',
      ],
    },
    stack: ['Uniapp', 'Vue 3'],
  },
];

export interface ProjectItem {
  name:    I18nText;
  tagline: I18nText;
  detail:  I18nText;
  highlights?: I18nBullets;
  role:    I18nText;
  stack:   string[];
  year:    string;
}

export const PROJECTS: ProjectItem[] = [
  {
    name:    { zh: 'our-chat · 实时 IM + 知识库 AI 助手', en: 'our-chat · Realtime IM + KB AI Assistant' },
    tagline: { zh: '自研实时 IM + 个人知识库 Agent:分布式全 Go 实时层 + 双仓库工程治理', en: 'A self-built realtime IM + personal-knowledge agent: distributed all-Go realtime tier, two-repo engineering governance' },
    detail: {
      zh: '横跨双仓库(our-chat + agent-server)的全栈系统:Go 长连接网关 + Go 无状态业务层 + React Web + iOS 端。消息链路、IdP 鉴权、ReAct Agent、RAG 摄入、压测体系全部自研;架构演进由实测压测数据驱动——从 Node 单点逐步演进出分布式全 Go 实时层。',
      en: 'A two-repo full-stack system (our-chat + agent-server): a Go long-connection gateway + stateless Go business tier + React web + iOS. The messaging path, IdP, ReAct agent, RAG pipeline and load-testing harness are all built from scratch; the architecture evolved under measured load-test data — from a single Node instance to a distributed all-Go realtime tier.',
    },
    highlights: {
      zh: [
        '实时消息链路(Go):原生 WebSocket 网关 + gRPC 双向流接入业务层(userId 哈希分片、in-flight 背压);业务层无状态多副本,seq 发号/幂等/通话态/presence 全部外置 Redis/PG,副本故障自动降级零失败;下行按 presence 定位网关副本定向直发(实测 direct 占比 99.9998%),pub/sub 兜底',
        '性能优化闭环(实测驱动):三轮压测定位「seq 发号 DB 行锁」为 p99 2 秒根源 → Redis INCR 发号 + messages 哈希 64 分区(359 万行回填原子切换)+ 读写分离(25 处读切只读池)+ 四级进程内缓存;最终 33 轮 32.5 万条消息零错误、p99 2075ms→65ms、过载错误率 79.9%→0%',
        '分布式健壮性与监测:kill 副本演练 980/980 零失败、1 万连接爬坡 100% 成功(31.5KB/连接)、300 连接惊群重连 p99=42ms;会话热点限流、慢消费者逐出、keepalive 治理;Prometheus + Grafana 10 面权威面板,压测 SOP 化',
        '账号与鉴权:自建 OAuth2.1/OIDC IdP(授权码 + PKCE S256、Discovery、JWKS 分发、refresh token 轮换 + 重用检测);会话经 /oauth/agent-token 铸下游 scope token,agent-server 用 JWKS 验签,两端解耦独立扩缩容',
        '自建 ReAct Agent(不依赖 LangChain/LangGraph):Reason-Act-Observation 循环 + function calling(检索/列文档/摘要/筛选);工具异常包成 observation 喂回模型自纠不崩、MAX_ITERATIONS 防失控烧 token、参数 JSON 兜底解析;每步事件落库 + 广播,断线按事件序列号回放',
        'RAG 摄入管线:pdf/docx/html 解析 → 递归字符切分(段落/行/空格/字符分隔符层级 + overlap)→ 批量 embedding → PG 元数据 + Milvus 向量双写(先写 PG 拿 chunkId 再 upsert);Pulsar 异步消费,开写前按 document_id 清场保证重试幂等;多租户 user 过滤收口唯一检索出口',
        '大文件上传:MD5 秒传去重 + S3 multipart 分片上传 + 断点续传(查询 S3 已传 part 只补缺片)+ 流式/压缩端点',
        'IDL 工程治理:Protobuf 单一契约源,经 buf 生成 TS(web/server)、Go(gateway/biz)、Python(rag-server)多端类型,发布 @talqora/agent-contracts 类型包,CI 校验生成物不漂移;前端路由懒加载、输入框草稿态下沉隔离重渲染、RUM(Web Vitals + 实时 RTT)三层性能防线',
      ],
      en: [
        'Realtime messaging (Go): raw-WebSocket gateway + gRPC bidi streams into the business tier (userId-hash sharding, in-flight backpressure); stateless multi-replica business tier with seq/idempotency/call/presence state fully externalized to Redis/PG — replicas fail over with zero loss; downlink routed directly to the gateway replica owning the peer (99.9998% direct), pub/sub as fallback',
        'Measurement-driven performance loop: three load-test rounds pinpointed the DB row-lock seq generator as the 2s-p99 root cause → Redis INCR sequencing + 64-way hash-partitioned messages table (3.59M rows backfilled with atomic cutover) + read/write split (25 reads on a read-only pool) + 4-tier in-process caches; end state: 325K messages across 33 rounds with zero errors, p99 2075ms→65ms, overload error rate 79.9%→0%',
        'Distributed robustness & observability: kill-replica drills 980/980 zero failures, 10K-connection ramp 100% success (31.5KB/conn), 300-connection thundering-herd reconnect p99=42ms; per-conversation hot-path rate limiting, slow-consumer eviction, keepalive tuning; a 10-row authoritative Grafana board plus SOP-ized load-test reporting',
        'AuthN/AuthZ: self-built OAuth2.1/OIDC IdP (authorization code + PKCE S256, Discovery, JWKS, refresh-token rotation + reuse detection); the session mints a downstream scoped token via /oauth/agent-token, verified by agent-server through JWKS — decoupled and independently scalable',
        'From-scratch ReAct agent (no LangChain/LangGraph): Reason-Act-Observation loop + function calling (retrieve / list documents / summarize / filter); tool errors wrapped as observations for self-correction, MAX_ITERATIONS guard against token burn, lenient JSON arg parsing; every tool_called/tool_result/final_answer persisted + broadcast, replayable after disconnects by sequence number',
        'RAG ingestion: pdf/docx/html parsing → recursive character splitting (paragraph/line/space/char separators + overlap) → batched embedding → dual-write PG metadata + Milvus vectors (PG first for chunkId, then upsert); async via Pulsar, idempotent via per-document cleanup before writing; multi-tenant user filtering funneled into a single retrieval exit',
        'Large-file upload: MD5 instant-dedupe + S3 multipart + resumable (probe uploaded parts, send only the gaps) + streaming/compression endpoints',
        'IDL governance: Protobuf as the single contract source, buf-generating TS (web/server), Go (gateway/biz) and Python (rag-server) types, publishing the @talqora/agent-contracts package with drift-checked CI; front-end perf: lazy routes, draft-state push-down isolating hot inputs, RUM (Web Vitals + realtime RTT) defense line',
      ],
    },
    role:  { zh: '独立开发', en: 'Solo' },
    stack: ['Go', 'TypeScript', 'React', 'Redux Toolkit', 'gRPC / Protobuf', 'Python / FastAPI', 'PostgreSQL', 'Redis', 'Pulsar', 'Milvus', 'Docker', 'Nginx'],
    year:  '2025 — 2026',
  },
  {
    name:    { zh: '掘金风格技术博客', en: 'Juejin-style Tech Blog' },
    tagline: { zh: '把技术博客的核心从零重写一遍', en: 'Re-implementing the core of a tech-blog site' },
    detail: {
      zh: 'Vue 全家桶,从内容管理、评论、关注到搜索的全链路,练手关系型数据建模与缓存策略。',
      en: 'A full Vue stack: content, comments, follows, search — practice on relational modeling and caching strategy.',
    },
    role:  { zh: '独立开发', en: 'Solo' },
    stack: ['Vue', 'ElementPlus', 'Pinia', 'MySQL', 'Redis'],
    year:  '2024',
  },
  {
    name:    { zh: '电商小程序', en: 'E-commerce Mini-program' },
    tagline: { zh: '把云开发跑通的一次轻量练习', en: 'A lightweight pass on WeChat Cloud Dev' },
    detail: {
      zh: '基于 Uniapp 与微信云开发的简易电商小程序,跑通商品-购物车-下单闭环。',
      en: 'A simple e-commerce mini-program on Uniapp + WeChat Cloud Dev, covering the catalog-cart-order flow.',
    },
    role:  { zh: '独立开发', en: 'Solo' },
    stack: ['Uniapp', 'WeChat CloudDev', 'uvui'],
    year:  '2024',
  },
];

export interface SkillGroup { title: I18nText; items: string[] }

export const SKILLS: SkillGroup[] = [
  {
    title: { zh: '前端', en: 'Front-end' },
    items: ['Vue', 'React', 'Flutter', 'Uniapp', 'TypeScript', 'Tailwind', 'SCSS', 'ElementPlus', 'AntD', 'WebRTC'],
  },
  {
    title: { zh: '后端', en: 'Back-end' },
    items: ['Go', 'Node (Express / Nest)', 'Python (FastAPI / Flask)'],
  },
  {
    title: { zh: '工程化', en: 'Tooling' },
    items: ['Vite', 'Git', 'Docker', 'Prisma', 'GitHub Actions', 'Nginx', 'Linux', 'Shell', 'Cursor / Claude', 'gRPC / Protobuf', 'Prometheus / Grafana'],
  },
  {
    title: { zh: '数据与中间件', en: 'Data & Middleware' },
    items: ['MySQL', 'MongoDB', 'PostgreSQL', 'Redis', 'Milvus', 'Neo4j', 'BullMQ', 'RabbitMQ', 'Pulsar'],
  },
];

// 给定当前语言,从 `{ zh, en }` 双语数据里挑出对应版本。
export function pick<T>(lang: AppLang, k: { zh: T; en: T }): T {
  return lang === 'zh' ? k.zh : k.en;
}
