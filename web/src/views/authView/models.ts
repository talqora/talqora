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
    tagline: { zh: '仿微信即时通讯,内嵌可对话的个人知识库 Agent', en: 'A WeChat-style messenger with an embedded, conversational personal-knowledge agent' },
    detail: {
      zh: '横跨多端的全栈系统:Go 高性能长连接网关 + React 前端 + Node(Express) 主服务 + Nest 微服务。把大模型当黑盒,其余核心子系统都自己实现了一遍,而非调库拼装。',
      en: 'A full-stack system across several surfaces: a Go realtime gateway + React web + a Node (Express) core + a Nest microservice. The LLM is a black box; every other core subsystem is implemented from scratch rather than glued from libraries.',
    },
    highlights: {
      zh: [
        '账号与鉴权:自建 OAuth2.1/OIDC IdP(授权码 + PKCE、JWKS 公钥分发、refresh token 轮换 + 重用检测);下游服务跨服务 JWKS 验签,server 自身即 IdP',
        '自建 ReAct Agent(不依赖 LangChain/LangGraph):Reason-Act-Observation 循环 + function calling;工具异常包成 observation 喂回模型自纠不崩、MAX_ITERATIONS 防失控烧 token;每步落库 + 广播形成可断线回放的审计轨迹',
        'RAG 摄入管线:pdf/docx/html 解析 → 递归字符切分 + overlap → 批量 embedding → Postgres 元数据与 Milvus 向量双写(先写 PG 拿 chunkId 再 upsert),按 document_id 清场做幂等',
        '大文件上传:MD5 秒传去重 + S3 multipart 分片上传 + 断点续传(查 S3 已传 part 只补缺片)',
        'IDL 工程治理:一份 Protobuf 经 buf 生成 TS / Go / Swift 四端类型,端到端类型安全、消除手写 DTO 漂移',
        '系统工程:nginx 同源反代消除跨域;Docker Compose + GitHub Actions 自动化部署;前端路由懒加载、状态下沉隔离高频输入、虚拟列表 + 分页',
      ],
      en: [
        'Auth: a self-built OAuth2.1/OIDC IdP (auth code + PKCE, JWKS key distribution, refresh-token rotation + reuse detection); the server is itself the IdP, downstream services verify via cross-service JWKS',
        'A from-scratch ReAct agent (no LangChain/LangGraph): Reason-Act-Observation loop + function calling; tool errors wrapped as observations for self-correction, MAX_ITERATIONS guard against runaway token burn; every step persisted + broadcast as a replayable audit trail',
        'RAG ingestion: pdf/docx/html parsing → recursive char splitting + overlap → batched embedding → dual-write Postgres metadata + Milvus vectors (PG first for chunkId, then upsert), idempotent via per-document cleanup',
        'Large-file upload: MD5 instant-dedupe + S3 multipart + resumable (probe uploaded parts, send only the gaps)',
        'IDL governance: one Protobuf generates TS / Go / Swift types for all surfaces — end-to-end type safety, no hand-written DTO drift',
        'Systems: same-origin nginx reverse proxy removing CORS; Docker Compose + GitHub Actions CI/CD; lazy routes, state push-down for hot inputs, virtualized + paginated message list',
      ],
    },
    role:  { zh: '独立开发', en: 'Solo' },
    stack: ['Go', 'React', 'Zustand', 'TypeScript', 'Node / Express', 'Nest', 'PostgreSQL', 'Redis', 'BullMQ', 'Milvus', 'Docker', 'Nginx'],
    year:  '2025',
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
    items: ['Vue', 'React', 'Flutter', 'Uniapp', 'TypeScript', 'Tailwind', 'SCSS', 'ElementPlus', 'AntD'],
  },
  {
    title: { zh: '后端', en: 'Back-end' },
    items: ['Node (Express / Nest)', 'Python (FastAPI / Flask)', 'Go'],
  },
  {
    title: { zh: '工程化', en: 'Tooling' },
    items: ['Vite', 'Git', 'Docker', 'Prisma', 'GitHub Actions', 'Nginx', 'Linux', 'Shell', 'Cursor / Claude'],
  },
  {
    title: { zh: '数据与中间件', en: 'Data & Middleware' },
    items: ['MySQL', 'MongoDB', 'PostgreSQL', 'Redis', 'Milvus', 'Neo4j', 'BullMQ', 'RabbitMQ'],
  },
];

// 给定当前语言,从 `{ zh, en }` 双语数据里挑出对应版本。
export function pick<T>(lang: AppLang, k: { zh: T; en: T }): T {
  return lang === 'zh' ? k.zh : k.en;
}
