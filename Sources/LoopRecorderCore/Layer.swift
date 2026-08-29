import Foundation

/// One of exactly seven recorded tracks (§5.1 #6).
public struct Layer: Identifiable, Codable, Equatable, Sendable {
    public static let nameCharacterLimit = 12

    public let id: UUID
    public let index: Int

    /// Empty means unnamed — the row shows a placeholder rather than a real name, so an
    /// unnamed layer does not require clearing text first (§3.9).
    public var name: String
    public var level: Float
    public var muted: Bool

    /// One per time the user records onto this layer. **Never concatenated** (§1.4).
    public var sessions: [RecordingSession]

    /// The arrangement: one `BarRef` per slot. There is deliberately no separate
    /// per-bar selection map — two structures describing the same thing is exactly how
    /// they drift apart (§1.5).
    public var barSources: [BarRef]

    public init(
        id: UUID = UUID(),
        index: Int,
        name: String = "",
        level: Float = 1.0,
        muted: Bool = false,
        sessions: [RecordingSession] = [],
        barSources: [BarRef] = []
    ) {
        self.id = id
        self.index = index
        self.name = String(name.prefix(Self.nameCharacterLimit))
        self.level = min(max(level, 0), 1)
        self.muted = muted
        self.sessions = sessions
        self.barSources = barSources
    }

    public var hasRecording: Bool { !sessions.isEmpty }
    public var totalRecordedFrames: Int { sessions.reduce(0) { $0 + $1.recordedFrames } }

    /// The single entry point for anything pass-shaped about this layer.
    public func passIndex(timing: Timing) -> PassIndex {
        PassIndex(sessions: sessions, timing: timing)
    }

    public func totalPasses(timing: Timing) -> Int {
        passIndex(timing: timing).totalPasses
    }

    /// The pass about to be captured: `Pass 1` for an empty layer, `passes + 1`
    /// otherwise (§3.9).
    public func nextPassNumber(timing: Timing) -> Int {
        totalPasses(timing: timing) + 1
    }

    /// Reset the arrangement to recorded order — slot *n* plays pass 1's bar *n*.
    public mutating func resetArrangement(barCount: Int) {
        barSources = (1...barCount).map { BarRef(pass: 1, relativeBar: $0) }
    }

    /// Remove every session and reset the arrangement (§4.2 "Clear layer").
    ///
    /// Self-contained: no other layer references this one's passes. It is the only way
    /// to discard a single layer's audio, because an individual pass cannot be deleted —
    /// `barSources` references pass numbers, and deleting one renumbers the rest and
    /// breaks every reference past it (§5.1 #2).
    public mutating func clear() {
        sessions.removeAll()
        barSources.removeAll()
    }
}
