// swift-tools-version: 6.0
import PackageDescription

#if TUIST
    import struct ProjectDescription.PackageSettings

    let packageSettings = PackageSettings(
        productTypes: [
            "ComposableArchitecture": .framework,
            "Dependencies": .framework,
            "DependenciesMacros": .framework,
            "Kingfisher": .framework,
            "GRDB": .framework,
            "SnapshotTesting": .framework,
            "Mockable": .framework,
            "OpenAPIRuntime": .framework,
            "HTTPTypes": .framework,
            "SocketIO": .framework,
            "WebRTC": .framework,
        ]
    )
#endif

let package = Package(
    name: "OurChat",
    dependencies: [
        .package(
            url: "https://github.com/pointfreeco/swift-composable-architecture",
            from: "1.17.0"
        ),
        .package(
            url: "https://github.com/pointfreeco/swift-dependencies",
            from: "1.6.0"
        ),
        .package(
            url: "https://github.com/pointfreeco/swift-snapshot-testing",
            from: "1.18.0"
        ),
        .package(
            url: "https://github.com/onevcat/Kingfisher",
            from: "8.0.0"
        ),
        .package(
            url: "https://github.com/Kolos65/Mockable",
            from: "0.3.0"
        ),
        .package(
            url: "https://github.com/groue/GRDB.swift",
            from: "7.0.0"
        ),
        .package(
            url: "https://github.com/apple/swift-openapi-runtime",
            from: "1.0.0"
        ),
        .package(
            url: "https://github.com/socketio/socket.io-client-swift",
            from: "16.1.0"
        ),
        .package(
            url: "https://github.com/stasel/WebRTC.git",
            .upToNextMajor(from: "149.0.0")
        ),
    ]
)
