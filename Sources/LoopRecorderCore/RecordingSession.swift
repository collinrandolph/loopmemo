import Foundation

/// One continuous recording onto a layer, aligned to the loop grid at its own start.
///
/// Recording always begins at the top of the loop, so frame 0 of this file is the
/// downbeat of this session's first pass — **not** of the layer's first pass.
/// Sessions are never concatenated into one timeline (§1.4): a session containing a
/// partial pass would put every later boundary at the wrong offset.
public struct RecordingSession: Identifiable, Codable, Equatable, Sendable {
    public let id: UUID
    /// Where the audio lives. Derived from `id` so a save/load round trip cannot
    /// rename the file out from under itself.
    public var audioFileURL: URL
    public let recordedFrames: Int
    public let recordedAt: Date
    /// Cached peaks for drawing this session without reopening the file.
    public var waveformPeaks: [Float]

    public init(
        id: UUID = UUID(),
        audioFileURL: URL,
        recordedFrames: Int,
        recordedAt: Date = Date(),
        waveformPeaks: [Float] = []
    ) {
        precondition(recordedFrames >= 0, "recordedFrames cannot be negative")
        self.id = id
        self.audioFileURL = audioFileURL
        self.recordedFrames = recordedFrames
        self.recordedAt = recordedAt
        self.waveformPeaks = waveformPeaks
    }

    /// The file name a session's audio is stored under, given its identity.
    public static func fileName(for id: UUID) -> String { "\(id.uuidString).caf" }
}

/// Where a bar's audio physically is: which session file, and what range of it.
///
/// `startFrame` is an offset **within that session's file**. Pass numbers are global
/// across a layer's sessions; frame offsets are session-local. Converting one to the
/// other is the single easiest thing in this codebase to get wrong, which is why it
/// happens in exactly one place — `PassIndex.region(for:)` — and is tested.
public struct SourceRegion: Equatable, Sendable {
    public let sessionIndex: Int
    public let startFrame: Int
    public let frameCount: Int

    public init(sessionIndex: Int, startFrame: Int, frameCount: Int) {
        self.sessionIndex = sessionIndex
        self.startFrame = startFrame
        self.frameCount = frameCount
    }
}
