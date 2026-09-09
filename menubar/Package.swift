// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Curated",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Curated",
            path: "Sources/Curated",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
