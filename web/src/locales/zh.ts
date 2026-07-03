// 中文文案。按 namespace 分桶,组件用 `useTranslation('common')` 或
// `t('auth.login.title')` 形式访问。
//
// 约定:
//   - common.*     : 跨页通用(确认 / 取消 / 加载 / 通用错误)
//   - http.*       : axios 拦截器里报错(非 React 上下文,用 i18n.t() 直接读)
//   - auth.*       : 登录 / 注册 / 简历落地页
//   - chat.*       : 聊天主体
//   - directory.*  : 通讯录
//   - settings.*   : 设置
//   - layout.*     : 左侧导航 / 菜单
//
// 结构化的简历数据(works / projects)不放这里,放 `views/authView/models.tsx`,
// 因为它本身是双语数据而非"翻译目标"。

const zh = {
  common: {
    confirm: '确认',
    cancel: '取消',
    save: '保存',
    delete: '删除',
    edit: '编辑',
    search: '搜索',
    loading: '加载中…',
    submit: '提交',
    submitting: '处理中…',
    retry: '重试',
    close: '关闭',
    yes: '是',
    no: '否',
    back: '返回',
    next: '下一步',
    invalid: '输入有误,请检查',
    networkError: '网络异常,请稍后再试',
  },

  http: {
    requestConfigError: '请求配置错误',
    unauthorized: '未授权,请重新登录',
    badRequest: '请求参数错误',
    forbidden: '拒绝访问',
    notFound: '请求的资源不存在',
    conflict: '数据冲突',
    unprocessable: '数据验证失败',
    serverError: '服务器内部错误',
    requestFailed: '请求失败 ({{status}})',
    timeout: '请求超时,请稍后重试',
    networkError: '网络错误,请检查网络连接',
  },

  auth: {
    brand: 'OUR · CHAT',
    eyebrow: '校招求职中',
    intro: '你好～',
    scrollHint: '继续往下',

    sections: {
      about: '关于',
      experience: '工作经历',
      skills: '技术栈',
      contact: '联系方式',
    },

    nav: {
      home: '主页',
      works: '作品',
    },

    works: {
      title: '作品集',
      subtitle: '',
      more: '更多在 GitHub @fdahk',
    },

    cells: {
      identity: '身份',
      track: '方向',
      award: '荣誉',
      online: '在线',
      targetingRoles: '移动端/前端的全栈岗位',
      nationalLevel: '全国级别',
      githubJuejin: 'GitHub · 稀土掘金',
      email: '邮箱',
      phone: '电话',
      juejin: '稀土掘金',
    },

    login: {
      title: '登录',
      sub: '欢迎回来,继续聊。',
      submit: '登录',
      submitting: '登录中…',
      ok: '欢迎回来',
      fail: '登录失败,请重试',
      switchToSignup: '没有账号?注册一个',
    },

    signup: {
      title: '注册',
      sub: '建一个账号,随时回来。',
      submit: '注册',
      submitting: '注册中…',
      ok: '账号已创建,即将跳转登录',
      fail: '注册失败,请检查输入',
      switchToLogin: '已有账号?直接登录',
    },

    fields: {
      username: '用户名',
      email: '邮箱',
      nickname: '昵称(可选)',
      password: '密码',
      confirmPassword: '确认密码',
      remember: '记住我',
      forgot: '忘记密码',
      agreement: '我已阅读并同意《用户协议》与《隐私政策》',
    },

    validate: {
      usernameRequired: '请输入用户名',
      usernameMin: '至少 2 个字符',
      usernameRule: '仅允许字母 / 数字 / 下划线 / 中文',
      usernameTaken: '用户名已存在',
      emailRequired: '请输入邮箱',
      emailRule: '邮箱格式不对',
      emailTaken: '邮箱已被注册',
      passwordRequired: '请输入密码',
      passwordRule: '需含大小写字母与数字,长度 ≥ 6',
      confirmRequired: '请再输一遍密码',
      confirmMismatch: '两次密码不一致',
      agreementRequired: '请勾选同意协议',
    },

    footer: {
      copy: '© 2026 涂将',
    },
  },

  chat: {
    placeholder: '请输入消息',
    send: '发送',
    download: '下载',
    sentFile: '发送了文件',
    noConversation: '请选择一个会话',
    searchPlaceholder: '搜索',
    iconLabels: {
      emoji: '表情',
      file: '文件',
      screenshot: '截图',
      record: '聊天记录',
      voice: '语音聊天',
      video: '视频聊天',
    },
    holdToTalk: '按住 说话',
    panel: {
      album: '相册',
      camera: '拍摄',
      videoCall: '视频通话',
      voiceCall: '语音通话',
      location: '位置',
      redPacket: '红包',
      gift: '礼物',
      transfer: '转账',
      voiceInput: '语音输入',
    },
    errors: {
      noActiveConversation: '没有选择聊天对象',
      noFriendInfo: '无法获取好友信息',
      uploadFailed: '文件上传失败',
    },
  },

  directory: {
    addSearchPlaceholder: '微信号/手机号',
    searchPlaceholder: '搜索',
    cancel: '取消',
    notFound: '无法找到该用户,请检查你填写的账号是否正确',
    searchPrefix: '搜索:',
    newFriend: '新朋友',
    region: '中国',
    title: {
      newFriendRequests: '新的朋友',
    },
    req: {
      accept: '同意',
      reject: '拒绝',
      pending: '等待验证',
      accepted: '已同意',
      rejected: '已拒绝',
    },
    hello: '你好,我是',
  },

  settings: {
    title: '设置',
    profile: '个人资料',
    avatar: {
      uploading: '加载中…',
      change: '更换头像',
      missingUrl: '上传响应缺少图片地址',
    },
    language: {
      title: '语言',
      zh: '中文',
      en: 'English',
    },
    theme: {
      title: '主题',
      light: '浅色',
      dark: '深色',
      system: '跟随系统',
    },
  },

  layout: {
    menu: {
      setting: '设置',
      logout: '退出登录',
    },
    tab: {
      chat: '聊天',
      directory: '通讯录',
      agent: '智能体',
      me: '我',
    },
  },

  profile: {
    wxid: '微信号',
    email: '邮箱',
    sendMsg: '发消息',
    voiceCall: '语音聊天',
    videoCall: '视频聊天',
  },

  agent: {
    brand: 'AI 助手',
    authError: '需要先登录 our-chat 才能使用 AI 助手,登录后刷新重试',
    tabs: {
      documents: '文档库',
      conversations: '知识对话',
      tasks: 'Agent 任务',
    },
    docs: {
      title: '文档库',
      upload: '上传',
      refresh: '刷新',
      empty: '还没有文档,上传第一个 PDF / Word / Markdown 试试',
      chunks: '{{count}} 片',
      uploadOk: '已加入队列,正在解析向量化',
      uploadFail: '上传失败',
      loadFail: '加载文档列表失败',
      deleteFail: '删除失败',
      confirmDelete: '确定删除该文档及其所有向量?',
    },
    chat: {
      list: '对话',
      new: '新建',
      empty: '还没有对话',
      pickOne: '选一个对话开始,或新建一个',
      firstMsgHint: '问个问题试试 ── 答案会基于你已上传的文档',
      placeholder: '问点什么…(Enter 发送,Shift+Enter 换行)',
      loadFail: '加载对话失败',
      createFail: '新建对话失败',
      deleteFail: '删除对话失败',
      sendFail: '发送失败',
      confirmDelete: '确定删除该对话?',
    },
    tasks: {
      placeholder: '描述一个任务,例如:总结我最新上传的文档,提取核心观点',
      submit: '提交',
      hint: 'Cmd / Ctrl + Enter 提交',
      empty: '提交一个任务,看看 agent 怎么调用工具完成它',
      submitFail: '任务提交失败',
      thinking: '思考中…',
      thinkProcess: '思考过程',
      steps: '{{count}} 步',
      failed: '任务执行失败',
    },
  },
};

// `typeof zh` 在没有 `as const` 时,TS 会把每个值 widen 成 `string`,刚好可以
// 作为 en.ts 必须实现的 schema:键结构一一对应,但值是开放的 `string`。
// 任何 zh 里新加的 key、en 里漏译都会编译期报错。
export type LocaleSchema = typeof zh;
export default zh;
