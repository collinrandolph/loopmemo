import Foundation

/// Capture format. Global setting, **snapshotted into each project at creation and
/// immutable thereafter** (§2.7): a project's layers must share a sample rate, or a
/// splice between a 44.1k layer and a 48k one needs a resample at every join.
///
/// Capture stays PCM in both modes. Layers compound loss across seven tracks and a
/// bounce, and mid-bar splice wants a frame index rather than a decoded AAC packet.
/// Lossy encoding belongs at compression and export (§2.7).
public enum AudioQuality: String, Codable, CaseIterable, Sendable {
    case standard   // 16-bit / 44.1 kHz mono
    case high       // 24-bit / 48 kHz mono

    public var sampleRate: Double {
        switch self {
        case .standard: return 44_100
        case .high:     return 48_000
        }
    }

    public var bitDepth: Int {
        switch self {
        case .standard: return 16
        case .high:     return 24
        }
    }

    public var channelCount: Int { 1 }

    public var bytesPerSecond: Int {
        Int(sampleRate) * channelCount * (bitDepth / 8)
    }

    public func bytes(forFrames frames: Int) -> Int {
        frames * channelCount * (bitDepth / 8)
    }
}

/// What a project will occupy, and what compressing it would save (§2.7).
///
/// **Pass count drives size, not layer count** — a 5-layer project with 12 passes costs
/// more than a 7-layer project with 7. This is why the Library shows the pass count
/// beside the layer count: it is the number that explains the size.
public struct SizeProjection: Equatable, Sendable {
    public let uncompressedBytes: Int
    /// One loop per recorded layer — what survives a compress.
    public let compressedBytes: Int

    public var savingBytes: Int { max(0, uncompressedBytes - compressedBytes) }

    /// Compression saves nothing on a project with one pass per layer. Show the
    /// projection before confirming; sometimes the honest answer is "this won't help."
    public var isWorthCompressing: Bool { savingBytes > 0 }

    public init(
        totalPasses: Int,
        recordedLayerCount: Int,
        loopSeconds: Double,
        quality: AudioQuality
    ) {
        let perLoop = loopSeconds * Double(quality.bytesPerSecond)
        self.uncompressedBytes = Int((Double(totalPasses) * perLoop).rounded())
        self.compressedBytes = Int((Double(recordedLayerCount) * perLoop).rounded())
    }
}
