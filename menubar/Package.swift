// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CuratedBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "CuratedBar",
            path: "Sources/CuratedBar",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
