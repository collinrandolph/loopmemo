import XCTest
@testable import LoopRecorderCore

final class SchedulePlanTests: XCTestCase {
    let timing = Timing(bpm: 96, barCount: 16, sampleRate: 44_100)
    var fpb: Int { timing.framesPerBar }
    var loop: Int { timing.loopFrames }

    private func session(frames: Int) -> RecordingSession {
        RecordingSession(audioFileURL: URL(fileURLWithPath: "/dev/null"), recordedFrames: frames)
    }

    /// Two sessions, as §1.4: passes 1-3 (3 partial, bars 1-8 only) then 4-5.
    private var index: PassIndex {
        PassIndex(sessions: [session(frames: 2 * loop + 8 * fpb), session(frames: 2 * loop)],
                  timing: timing)
    }

    /// Recorded order: slot n plays pass 1's bar n.
    private var identityArrangement: [BarRef] {
        (1...16).map { BarRef(pass: 1, relativeBar: $0) }
    }

    func testSegmentsAreContiguousInTheArrangement() {
        let plan = SchedulePlan(arrangement: identityArrangement, index: index)
        let segments = plan.segments(from: 0, count: 4)

        XCTAssertEqual(segments.map(\.slot), [0, 1, 2, 3])
        XCTAssertEqual(segments.map(\.startFrame), [0, fpb, 2 * fpb, 3 * fpb])
    }

    func testSlotAndSourceAreIndependent() {
        // §1.1: playback progress indexes on the slot, colour on the source. A
        // reordered arrangement must keep the slot ascending while the source jumps.
        var arrangement = identityArrangement
        arrangement[0] = BarRef(pass: 2, relativeBar: 9)

        let plan = SchedulePlan(arrangement: arrangement, index: index)
        let first = plan.segments(from: 0, count: 1)[0]

        XCTAssertEqual(first.slot, 0)
        XCTAssertEqual(first.startFrame, 0, "slot 0 always starts at the anchor")
        XCTAssertEqual(first.source, BarRef(pass: 2, relativeBar: 9))
        XCTAssertEqual(first.region.startFrame, loop + 8 * fpb, "but reads pass 2's bar 9")
    }

    func testHorizonWrapsAroundTheArrangement() {
        let plan = SchedulePlan(arrangement: identityArrangement, index: index)
        let segments = plan.segments(from: 14, count: 4)

        XCTAssertEqual(segments.map(\.slot), [14, 15, 0, 1])
        // startFrame keeps counting past the loop so the engine schedules forward in
        // time; it does not reset to 0 mid-horizon.
        XCTAssertEqual(segments.map(\.startFrame), [14 * fpb, 15 * fpb, 16 * fpb, 17 * fpb])
    }

    func testSlotPointingAtUnrecordedAudioIsSkipped() {
        var arrangement = identityArrangement
        arrangement[2] = BarRef(pass: 3, relativeBar: 12)   // in the gap

        let plan = SchedulePlan(arrangement: arrangement, index: index)
        XCTAssertEqual(plan.segments(from: 0, count: 4).map(\.slot), [0, 1, 3])
    }

    func testEmptyArrangementSchedulesNothing() {
        let plan = SchedulePlan(arrangement: [], index: index)
        XCTAssertTrue(plan.segments(from: 0, count: 4).isEmpty)
    }

    // MARK: - Mid-bar splice (§2.5)

    func testSpliceEntersTheNewSourceAtTheSameOffset() {
        let plan = SchedulePlan(arrangement: identityArrangement, index: index)
        let twoBeats = fpb / 2

        let region = plan.splice(into: BarRef(pass: 2, relativeBar: 5),
                                 offsetInBar: twoBeats,
                                 crossfadeFrames: 441)

        // Two beats into bar 5 becomes two beats into pass 2's bar 5.
        XCTAssertEqual(region?.startFrame, loop + 4 * fpb + twoBeats)
        XCTAssertEqual(region?.frameCount, fpb - twoBeats)
    }

    func testTailGuardSkipsASpliceTooCloseToTheBarEnd() {
        // §2.5: a swipe within ~15 ms of the end would splice into a region shorter
        // than the crossfade. Skip it and let the natural boundary handle it.
        let plan = SchedulePlan(arrangement: identityArrangement, index: index)
        let nearEnd = fpb - 100

        XCTAssertNil(plan.splice(into: BarRef(pass: 2, relativeBar: 5),
                                 offsetInBar: nearEnd,
                                 crossfadeFrames: 441))
    }

    func testSpliceIntoUnrecordedAudioIsRefused() {
        let plan = SchedulePlan(arrangement: identityArrangement, index: index)
        XCTAssertNil(plan.splice(into: BarRef(pass: 3, relativeBar: 12),
                                 offsetInBar: 1000,
                                 crossfadeFrames: 441))
    }

    func testSpliceAtTheDownbeatIsTheWholeBar() {
        let plan = SchedulePlan(arrangement: identityArrangement, index: index)
        let region = plan.splice(into: BarRef(pass: 1, relativeBar: 1),
                                 offsetInBar: 0,
                                 crossfadeFrames: 441)
        XCTAssertEqual(region, SourceRegion(sessionIndex: 0, startFrame: 0, frameCount: fpb))
    }
}
