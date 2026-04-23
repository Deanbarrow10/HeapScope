// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "HeapScope",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "heapscope", targets: ["heapscope"]),
        .executable(name: "LeakyVictim", targets: ["LeakyVictim"]),
    ],
    targets: [
        .target(
            name: "HeapScopeC",
            path: "Sources/HeapScopeC",
            publicHeadersPath: "include",
            cSettings: [
                // libmalloc's cross-task introspection lives under deprecated / SPI shims;
                // silencing the noise keeps the build at zero warnings.
                .unsafeFlags(["-Wno-deprecated-declarations", "-Wno-unused-function"]),
            ]
        ),
        .executableTarget(
            name: "heapscope",
            dependencies: ["HeapScopeC"],
            path: "Sources/heapscope"
        ),
        .executableTarget(
            name: "LeakyVictim",
            path: "Sources/LeakyVictim"
        ),
    ]
)
