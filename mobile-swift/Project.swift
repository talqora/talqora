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
            sources: ["Sources/**"],
            resources: ["Resources/**"],
            dependencies: [
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
                .external(name: "SnapshotTesting"),
                .external(name: "Mockable"),
            ]
        ),
    ]
)
