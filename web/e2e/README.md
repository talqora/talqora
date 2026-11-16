# 浏览器 E2E(Playwright CLI)

不引入 `@playwright/test` 依赖,直接用全局 `playwright-cli` 驱动真实浏览器跑仓库里的端到端断言。

## 运行

```bash
# 0) 前提:web(:5173)+ biz(:3007)+ gateway(:8090) 已起,数据库有可用账号
playwright-cli open https://localhost:5173

# 1) 登录(账号见下),再依次跑三段
playwright-cli run-code --filename=e2e/login.js        # 需自备登录脚本,或用页面上手动登录
playwright-cli run-code --filename=e2e/01-chat-directory.js
playwright-cli run-code --filename=e2e/02-group.js
playwright-cli run-code --filename=e2e/03-deeplink-search-theme.js

# 2) 读取断言结果
playwright-cli eval "window.__e2e1"   # 02 → __e2e2,03 → __e2e3
```

输出形如 `PASS 会话标题都非空` / `FAIL …` / `EXCEPTION …`;全部 PASS 才算通过。

## 覆盖范围

| 脚本 | 覆盖 |
|---|---|
| `01` | 登录跳转、会话列表标题非空(分页默认值回归)、单聊发消息、通讯录新朋友展开、联系人虚拟化 |
| `02` | 建群(+/发起群聊/勾选/完成)、群内发消息、⋯ 群资料面板、成员格等宽、改群名即时生效、改本群昵称 |
| `03` | 深链刷新保持会话、会话搜索过滤、通讯录好友详情、设置弹窗主题项 |
| `04` | 群名/昵称「点击才进入编辑」、**失焦自动取消且不落库**、改名后头部/列表同步、刷新后仍生效 |
| `05` | 群资料「添加」邀请入群:双栏尺寸/圆形勾选/已选 chip/禁用态/Esc + **候选分页与虚拟化**、排除群内成员、成员数增加、刷新保持(13 项) |

## 约定

- 脚本文件**结尾不能带分号**:`playwright-cli run-code` 会把文件包成 `await (<code>)(page)`,多余分号会报 `Unexpected token ';'`。
- 断言结果写 `window.__e2eN`,不要依赖 `console.log`(CLI 只回传 code 预览)。
- 账号:涂将(userId 10301);`03` 脚本里硬编码了该 id,换账号需同步改。
