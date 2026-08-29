// swift-tools-version:5.9
import PackageDescription

// Two targets, split on one line: whether the code needs AVFoundation.
//
// LoopRecorderCore is pure Foundation — bar identity, frame math, pass
// availability, and the session-relative region lookup. It builds and tests on
// any platform with a Swift toolchain, including Windows and Linux, so the
// arithmetic that everything else depends on can be verified without a Mac,
// a simulator, or a microphone.
//
// LoopRecorderAudio is the AVFoundation shell. It can only build on Apple
// platforms and can only be verified by running it, so it is kept as thin as
// possible: it executes decisions Core has already made.
let package = Package(
    name: "LoopRecorder",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "LoopRecorderCore", targets: ["LoopRecorderCore"]),
        .library(name: "LoopRecorderAudio", targets: ["LoopRecorderAudio"]),
    ],
    targets: [
        .target(name: "LoopRecorderCore"),
        .target(name: "LoopRecorderAudio", dependencies: ["LoopRecorderCore"]),
        .testTarget(name: "LoopRecorderCoreTests", dependencies: ["LoopRecorderCore"]),
    ]
)
