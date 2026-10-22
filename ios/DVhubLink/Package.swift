// swift-tools-version:5.10
// DVhubLink — Kopplung, Ende-zu-Ende-Verschlüsselung und Relay-Protokoll für
// die DVhub-iPhone-App. Protokoll: docs/HANDY-APP-PROTOKOLL.md (Repo-Wurzel).
import PackageDescription

let package = Package(
    name: "DVhubLink",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "DVhubLink", targets: ["DVhubLink"]),
    ],
    targets: [
        .target(name: "DVhubLink"),
        .testTarget(name: "DVhubLinkTests", dependencies: ["DVhubLink"]),
    ]
)
