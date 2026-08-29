import Foundation

/// One layer's sessions, indexed for pass lookup.
///
/// Pass numbering, availability, region lookup and axis stepping all derive from a
/// **single** walk of session order, computed once here. An earlier version had the
/// layer counting passes one way for its total and another way for availability; two
/// derivations of the same quantity are how they drift apart (§1.5).
///
/// Nothing about a pass is stored (§1.4). A pass exists if the audio for it exists, so
/// a freshly recorded layer, a compressed layer, a bounced layer and an imported one
/// are all handled identically, with no counter to maintain and no flag to clear.
public struct PassIndex: Sendable {
    public let timing: Timing
    private let sessions: [RecordingSession]
    /// `firstPass[i]` = 1 + Σ passCount(sessions[0..<i])   (§1.4)
    private let firstPass: [Int]

    public init(sessions: [RecordingSession], timing: Timing) {
        self.timing = timing
        self.sessions = sessions

        var starts: [Int] = []
        starts.reserveCapacity(sessions.count)
        var next = 1
        for session in sessions {
            starts.append(next)
            next += timing.passCount(frames: session.recordedFrames)
        }
        self.firstPass = starts
    }

    /// Total passes this layer holds, partial ones included.
    public var totalPasses: Int {
        sessions.indices.reduce(0) { total, i in
            total + timing.passCount(frames: sessions[i].recordedFrames)
        }
    }

    public var isEmpty: Bool { sessions.isEmpty }

    /// Which session owns a global pass number, and that pass's index within it.
    private func locate(pass: Int) -> (sessionIndex: Int, localPass: Int)? {
        guard pass >= 1 else { return nil }
        for i in sessions.indices {
            let count = timing.passCount(frames: sessions[i].recordedFrames)
            let local = pass - firstPass[i]
            if local >= 0 && local < count {
                return (i, local + 1)
            }
        }
        return nil
    }

    /// Every pass that has audio for this bar position, ascending.
    ///
    /// **The set can be non-contiguous** (§1.4). A session that stopped after 8 bars of
    /// a 16-bar loop gives bar 1 a pass that bar 12 does not have, so a later session's
    /// passes sit on the far side of a real gap. A tile can legitimately read `P4` with
    /// no `P3` behind it; the number preserves provenance.
    public func availablePasses(forBar relativeBar: Int) -> [Int] {
        var out: [Int] = []
        for i in sessions.indices {
            let frames = sessions[i].recordedFrames
            let count = timing.passCount(frames: frames)
            guard count > 0 else { continue }
            for local in 1...count
            where timing.barExists(localPass: local,
                                   relativeBar: relativeBar,
                                   inSessionOf: frames) {
                out.append(firstPass[i] + local - 1)
            }
        }
        return out
    }

    public func hasAudio(for ref: BarRef) -> Bool {
        region(for: ref) != nil
    }

    /// Resolve a `BarRef` to the physical audio behind it.
    ///
    /// Returns nil when that bar was never recorded — a gap in the available set, or a
    /// pass number past the end of the layer.
    public func region(for ref: BarRef) -> SourceRegion? {
        guard let (sessionIndex, localPass) = locate(pass: ref.pass) else { return nil }
        let frames = sessions[sessionIndex].recordedFrames
        guard timing.barExists(localPass: localPass,
                               relativeBar: ref.relativeBar,
                               inSessionOf: frames) else { return nil }

        let start = (localPass - 1) * timing.loopFrames
            + timing.frameOffsetInLoop(relativeBar: ref.relativeBar)

        // Clamp to what is actually on disk. `barExists` forgives a few milliseconds so
        // a pass played to completion is not lost to stop latency — but the forgiven
        // frames do not exist, and asking the scheduler for them reads past EOF.
        let available = frames - start
        guard available > 0 else { return nil }
        let count = min(timing.framesPerBar, available)

        return SourceRegion(sessionIndex: sessionIndex, startFrame: start, frameCount: count)
    }

    public func session(at index: Int) -> RecordingSession? {
        sessions.indices.contains(index) ? sessions[index] : nil
    }

    /// Step the vertical axis, wrapping through the passes that exist for **this bar**.
    ///
    /// §1.4: the swipe wraps through the available set for the bar being swiped,
    /// skipping absent passes rather than assuming a contiguous range. Returns nil when
    /// the bar has no audio at all, and the same ref when it has exactly one pass —
    /// which is also the state that disables the axis entirely on the Edit Layer
    /// screen (§4.3), derived from audio rather than from a flag.
    public func steppingPass(from ref: BarRef, by delta: Int) -> BarRef? {
        let passes = availablePasses(forBar: ref.relativeBar)
        guard !passes.isEmpty else { return nil }
        guard let current = passes.firstIndex(of: ref.pass) else {
            // Current pass has no audio here; land on the nearest one that does.
            let fallback = passes.first(where: { $0 > ref.pass }) ?? passes[passes.count - 1]
            return BarRef(pass: fallback, relativeBar: ref.relativeBar)
        }
        let n = passes.count
        let stepped = (((current + delta) % n) + n) % n
        return BarRef(pass: passes[stepped], relativeBar: ref.relativeBar)
    }
}
