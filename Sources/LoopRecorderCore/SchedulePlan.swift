import Foundation

/// What to hand the audio engine, decided without touching it.
///
/// Segment-scheduled playback (§2.4) is two separable jobs: working out which regions
/// of which files play when, and calling `scheduleSegment` to make it happen. The first
/// is arithmetic and lives here, where it can be tested on any machine. The second is
/// AVFoundation and lives in `PlaybackEngine`, which is deliberately thin.
public struct ScheduledSegment: Equatable, Sendable {
    /// Position in the arrangement. Playback progress indexes on this (§1.1).
    public let slot: Int
    /// Where the audio comes from. Colour indexes on this. Never the same thing.
    public let source: BarRef
    /// The physical range, resolved against the owning session's own file.
    public let region: SourceRegion
    /// Frame at which this segment starts, relative to the shared anchor.
    public let startFrame: Int

    public init(slot: Int, source: BarRef, region: SourceRegion, startFrame: Int) {
        self.slot = slot
        self.source = source
        self.region = region
        self.startFrame = startFrame
    }
}

public struct SchedulePlan {
    public let timing: Timing
    private let index: PassIndex
    private let arrangement: [BarRef]

    public init(arrangement: [BarRef], index: PassIndex) {
        self.arrangement = arrangement
        self.index = index
        self.timing = index.timing
    }

    /// The next `count` slots from `slot`, wrapping around the arrangement.
    ///
    /// The horizon is kept short on purpose (§2.4): everything committed to the engine
    /// is work a live edit has to either wait out or tear down, so a splice is never
    /// far behind the gesture.
    ///
    /// Slots whose source has no audio are **skipped, not silenced with a shorter
    /// segment** — a gap in the available set means that bar was never recorded, and
    /// the arrangement should not have pointed at it.
    public func segments(from slot: Int, count: Int) -> [ScheduledSegment] {
        guard !arrangement.isEmpty, count > 0 else { return [] }
        var out: [ScheduledSegment] = []
        out.reserveCapacity(count)

        for step in 0..<count {
            let absolute = slot + step
            let wrapped = ((absolute % arrangement.count) + arrangement.count) % arrangement.count
            let source = arrangement[wrapped]
            guard let region = index.region(for: source) else { continue }
            out.append(ScheduledSegment(slot: wrapped,
                                        source: source,
                                        region: region,
                                        startFrame: absolute * timing.framesPerBar))
        }
        return out
    }

    /// Where a mid-bar splice should enter the new source (§2.5).
    ///
    /// Swiping the bar that IS playing splices immediately: two beats into bar 5 becomes
    /// two beats into the alternate pass of bar 5. Returns nil when the splice should be
    /// skipped and the natural boundary left to handle it — either the bar has no audio,
    /// or the playhead is inside the tail guard, where the remaining region would be
    /// shorter than the crossfade.
    public func splice(
        into source: BarRef,
        offsetInBar: Int,
        crossfadeFrames: Int
    ) -> SourceRegion? {
        guard offsetInBar >= 0, offsetInBar < timing.framesPerBar else { return nil }
        guard timing.framesPerBar - offsetInBar > crossfadeFrames else { return nil }
        guard let region = index.region(for: source) else { return nil }

        let start = region.startFrame + offsetInBar
        let remaining = region.frameCount - offsetInBar
        guard remaining > crossfadeFrames else { return nil }

        return SourceRegion(sessionIndex: region.sessionIndex,
                            startFrame: start,
                            frameCount: remaining)
    }
}
