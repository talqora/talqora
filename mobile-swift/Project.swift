import ProjectDescription

let project = Project(
    name: "OurChat",
    organizationName: "com.ourchat",
    options: .options(
        defaultKnownRegions: ["en", "zh-Hans"],
        developmentRegion: "zh-Hans"
    ),
    settings: .settings(
        base: [
            "SWIFT_VERSION": "6.0",
            "SWIFT_STRICT_CONCURRENCY": "complete",
            "SWIFT_UPCOMING_FEATURE_STRICT_CONCURRENCY": "YES",
            "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
            "DEAD_CODE_STRIPPING": "YES",
            "IPHONEOS_DEPLOYMENT_TARGET": "18.0",
        ],
        configurations: [
            .debug(name: "Debug"),
            .release(name: "Release"),
        ]
    ),
    targets: [
        // 共享领域模型(叶子模块:仅依赖 Foundation)。抽成独立 module → 边界由编译器强制。
        .target(
            name: "Models",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.models",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Models/**"]
        ),
        // OpenAPI 生成契约(单一契约源)。叶子模块,仅依赖 OpenAPIRuntime。
        .target(
            name: "Contracts",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.contracts",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Contracts/**"],
            dependencies: [
                .external(name: "OpenAPIRuntime"),
            ]
        ),
        // 设计系统(令牌 + 组件 + UX)。叶子模块,仅依赖 Kingfisher(头像缓存)。可被未来 Widget/扩展复用。
        .target(
            name: "DesignSystem",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.designsystem",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/DesignSystem/**"],
            dependencies: [
                .external(name: "Kingfisher"),
            ]
        ),
        // 基建层:网络(APIClient/APIRequest/信封)、Keychain、JWT、错误类型、工具。
        // 依赖倒置(TokenRefresher)后不再依赖 Services,是干净叶子。
        .target(
            name: "Core",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.core",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Core/**"],
            dependencies: [
                .external(name: "Dependencies"),
                .external(name: "DependenciesMacros"),
            ]
        ),
        // 领域客户端层(REST/Socket/WebRTC/Agent 各 client)。依赖 Core/Models/Contracts;
        // 反向依赖(MeProfile/CallType)已下沉 Models,故无 Services→Features 循环。
        .target(
            name: "Services",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.services",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Services/**"],
            dependencies: [
                .target(name: "Core"),
                .target(name: "Models"),
                .target(name: "Contracts"),
                .external(name: "Dependencies"),
                .external(name: "DependenciesMacros"),
                .external(name: "SocketIO"),
                .external(name: "WebRTC"),
            ]
        ),
        // 功能模块(pilot):登录/注册。依赖 Services/Core/Models/DesignSystem + TCA。
        .target(
            name: "Auth",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.feature.auth",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Features/Auth/**"],
            dependencies: [
                .target(name: "Core"),
                .target(name: "Models"),
                .target(name: "DesignSystem"),
                .target(name: "Services"),
                .external(name: "ComposableArchitecture"),
            ]
        ),
        // 小程序(叶子功能):授权门 + 知识库助手(对话/文档/任务三 tab)。MiniAppPanel 被 Chats 复用。
        .target(
            name: "MiniApp",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.feature.miniapp",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Features/MiniApp/**"],
            dependencies: [
                .target(name: "Core"),
                .target(name: "Models"),
                .target(name: "DesignSystem"),
                .target(name: "Services"),
                .external(name: "ComposableArchitecture"),
            ]
        ),
        // 通话(叶子功能):1:1 音视频状态机,编排 WebRTC + socket 信令。被 App 的 MainFeature 呈现。
        .target(
            name: "Call",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.feature.call",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Features/Call/**"],
            dependencies: [
                .target(name: "Core"),
                .target(name: "Models"),
                .target(name: "DesignSystem"),
                .target(name: "Services"),
                .external(name: "ComposableArchitecture"),
            ]
        ),
        // 我(叶子功能):个人页 + 设置/资料/外观导航栈。被 App 的 MainFeature 组合。
        .target(
            name: "Me",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.feature.me",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Features/Me/**"],
            dependencies: [
                .target(name: "Core"),
                .target(name: "Models"),
                .target(name: "DesignSystem"),
                .target(name: "Services"),
                .external(name: "ComposableArchitecture"),
            ]
        ),
        // 发现(叶子功能):静态入口聚合,无 reducer,仅依赖 DesignSystem。
        .target(
            name: "Discover",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.feature.discover",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Features/Discover/**"],
            dependencies: [
                .target(name: "DesignSystem"),
            ]
        ),
        // 搜索(叶子功能):精确查找用户 + 发起好友请求。被 Chats 呈现。
        .target(
            name: "Search",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.feature.search",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Features/Search/**"],
            dependencies: [
                .target(name: "Core"),
                .target(name: "Models"),
                .target(name: "DesignSystem"),
                .target(name: "Services"),
                .external(name: "ComposableArchitecture"),
            ]
        ),
        // 会话(域功能):会话列表 + 聊天详情栈。依赖 Search(搜索页覆盖)、MiniApp(下拉面板)。ChatDetail 被 Contacts 复用。
        .target(
            name: "Chats",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.feature.chats",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Features/Chats/**"],
            dependencies: [
                .target(name: "Core"),
                .target(name: "Models"),
                .target(name: "DesignSystem"),
                .target(name: "Services"),
                .target(name: "Search"),
                .target(name: "MiniApp"),
                .external(name: "ComposableArchitecture"),
            ]
        ),
        // 通讯录(域功能):联系人列表 + 好友资料/设置/备注/新的朋友导航栈。ChatDetail 复用自 Chats。
        // 注意:模块名不能叫 Contacts —— 会与 Apple 系统框架 Contacts.framework 同名,运行时 dyld 误加载系统框架导致启动崩溃。
        .target(
            name: "ContactBook",
            destinations: .iOS,
            product: .framework,
            bundleId: "com.ourchat.ios.feature.contactbook",
            deploymentTargets: .iOS("18.0"),
            sources: ["Sources/Features/Contacts/**"],
            dependencies: [
                .target(name: "Core"),
                .target(name: "Models"),
                .target(name: "DesignSystem"),
                .target(name: "Services"),
                .target(name: "Chats"),
                .external(name: "ComposableArchitecture"),
            ]
        ),
        .target(
            name: "OurChat",
            destinations: .iOS,
            product: .app,
            bundleId: "com.ourchat.ios",
            deploymentTargets: .iOS("18.0"),
            infoPlist: .extendingDefault(with: [
                "UILaunchScreen": [:],
                "ITSAppUsesNonExemptEncryption": false,
                "CFBundleShortVersionString": "0.1.0",
                "CFBundleVersion": "1",
                "CFBundleDisplayName": "OurChat",
                "UIApplicationSceneManifest": [
                    "UIApplicationSupportsMultipleScenes": false,
                ],
                "NSMicrophoneUsageDescription": "通话需要使用麦克风",
                "NSCameraUsageDescription": "视频通话需要使用摄像头",
                "UIBackgroundModes": ["audio"],
            ]),
            sources: [
                "Sources/App/**",
            ],
            resources: ["Resources/**"],
            dependencies: [
                .target(name: "Models"),
                .target(name: "Contracts"),
                .target(name: "DesignSystem"),
                .target(name: "Core"),
                .target(name: "Services"),
                .target(name: "Auth"),
                .target(name: "Search"),
                .target(name: "Discover"),
                .target(name: "Me"),
                .target(name: "Call"),
                .target(name: "MiniApp"),
                .target(name: "Chats"),
                .target(name: "ContactBook"),
                .external(name: "ComposableArchitecture"),
                .external(name: "Dependencies"),
                .external(name: "DependenciesMacros"),
                .external(name: "Kingfisher"),
                .external(name: "GRDB"),
                .external(name: "OpenAPIRuntime"),
                .external(name: "SocketIO"),
                .external(name: "WebRTC"),
            ],
            settings: .settings(
                base: [
                    "TARGETED_DEVICE_FAMILY": "1,2",
                    "GENERATE_INFOPLIST_FILE": "NO",
                ]
            )
        ),
        .target(
            name: "OurChatTests",
            destinations: .iOS,
            product: .unitTests,
            bundleId: "com.ourchat.ios.tests",
            deploymentTargets: .iOS("18.0"),
            sources: ["Tests/**"],
            dependencies: [
                .target(name: "OurChat"),
                .target(name: "Models"),
                .target(name: "Contracts"),
                .target(name: "DesignSystem"),
                .target(name: "Core"),
                .target(name: "Services"),
                .target(name: "Auth"),
                .target(name: "Search"),
                .target(name: "Me"),
                .target(name: "Call"),
                .target(name: "MiniApp"),
                .target(name: "Chats"),
                .target(name: "ContactBook"),
                .external(name: "SnapshotTesting"),
                .external(name: "Mockable"),
            ]
        ),
    ]
)
