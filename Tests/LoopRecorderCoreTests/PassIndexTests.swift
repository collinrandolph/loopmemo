import XCTest
@testable import LoopRecorderCore

/// The spec's own worked example (§1.4), 96 BPM / 16 bars / 44.1 kHz:
///
///   session 0 = 2 full passes + 8 bars  -> passes 1, 2, 3 (3 partial)
///   session 1 = 2 full passes           -> passes 4, 5
///
///   bars  1-8  -> 1, 2, 3, 4, 5
///   bars  9-16 -> 1, 2, -, 4, 5      the gap is real and must survive
final class PassIndexTests: XCTestCase {
    let timing = Timing(bpm: 96, barCount: 16, sampleRate: 44_100)

    var fpb: Int { timing.framesPerBar }        // 110_250
    var loop: Int { timing.loopFrames }         // 1_764_000

    private func session(frames: Int) -> RecordingSession {
        RecordingSession(audioFileURL: URL(fileURLWithPath: "/dev/null"),
                         recordedFrames: frames)
    }

    private var index: PassIndex {
        PassIndex(sessions: [session(frames: 2 * loop + 8 * fpb),
                             session(frames: 2 * loop)],
                  timing: timing)
    }

    // MARK: - Pass numbering follows session order

    func testTotalPassesCountsPartialPasses() {
        XCTAssertEqual(index.totalPasses, 5)
    }

    func testEmptyLayerHasNoPasses() {
        XCTAssertEqual(PassIndex(sessions: [], timing: timing).totalPasses, 0)
        XCTAssertTrue(PassIndex(sessions: [], timing: timing).availablePasses(forBar: 1).isEmpty)
    }

    // MARK: - Availability is per bar position, and can be non-contiguous

    func testEarlyBarsHaveEveryPass() {
        XCTAssertEqual(index.availablePasses(forBar: 1), [1, 2, 3, 4, 5])
        XCTAssertEqual(index.availablePasses(forBar: 8), [1, 2, 3, 4, 5])
    }

    func testLateBarsHaveAGapWhereTheSessionStopped() {
        XCTAssertEqual(index.availablePasses(forBar: 9), [1, 2, 4, 5])
        XCTAssertEqual(index.availablePasses(forBar: 16), [1, 2, 4, 5])
    }

    // MARK: - Region lookup: pass numbers are global, frame offsets are session-local
    //
    // This is the regression that motivated splitting Core out. Deriving the offset
    // from the absolute bar number across the whole layer asked for frame 5_292_000 of
    // a 3_528_000-frame file — 40 seconds past the end — and read silent garbage
    // rather than crashing.

    func testPassInLaterSessionResolvesToThatSessionsOwnFrameZero() {
        let region = index.region(for: BarRef(pass: 4, relativeBar: 1))
        XCTAssertEqual(region, SourceRegion(sessionIndex: 1, startFrame: 0, frameCount: fpb))
    }

    func testRegionNeverExceedsItsSessionsLength() {
        let sessions = [session(frames: 2 * loop + 8 * fpb), session(frames: 2 * loop)]
        for pass in 1...5 {
            for bar in 1...16 {
                guard let r = index.region(for: BarRef(pass: pass, relativeBar: bar)) else { continue }
                let length = sessions[r.sessionIndex].recordedFrames
                XCTAssertLessThanOrEqual(
                    r.startFrame + r.frameCount, length,
                    "P\(pass)/bar \(bar) reads past the end of session \(r.sessionIndex)")
            }
        }
    }

    func testPartialPassResolvesForEarlyBars() {
        XCTAssertEqual(index.region(for: BarRef(pass: 3, relativeBar: 1)),
                       SourceRegion(sessionIndex: 0, startFrame: 2 * loop, frameCount: fpb))
    }

    func testGapReturnsNoRegion() {
        XCTAssertNil(index.region(for: BarRef(pass: 3, relativeBar: 9)))
        XCTAssertFalse(index.hasAudio(for: BarRef(pass: 3, relativeBar: 16)))
    }

    func testPassBeyondTheLayerReturnsNoRegion() {
        XCTAssertNil(index.region(for: BarRef(pass: 6, relativeBar: 1)))
    }

    func testLastBarOfLastPass() {
        XCTAssertEqual(index.region(for: BarRef(pass: 5, relativeBar: 16)),
                       SourceRegion(sessionIndex: 1,
                                    startFrame: loop + 15 * fpb,
                                    frameCount: fpb))
    }

    // MARK: - Tolerance forgives stop latency without inventing audio

    func testToleranceIsAFewMillisecondsNotTensOfThem() {
        // A frame count large enough to admit a bar that is most of a beat short is not
        // a tolerance, it is a silent truncation. Spec §1.4: "a few milliseconds".
        XCTAssertEqual(timing.toleranceFrames, 176)
        XCTAssertLessThan(Double(timing.toleranceFrames) / timing.sampleRate, 0.010)
    }

    func testToleranceScalesWithSampleRate() {
        let high = Timing(bpm: 96, barCount: 16, sampleRate: 48_000)
        XCTAssertNotEqual(high.toleranceFrames, timing.toleranceFrames)
        XCTAssertEqual(Double(high.toleranceFrames) / high.sampleRate,
                       Double(timing.toleranceFrames) / timing.sampleRate, accuracy: 0.0005)
    }

    func testPassStoppedJustShortIsKeptButClampedToWhatExists() {
        let short = PassIndex(sessions: [session(frames: 2 * loop - 100)], timing: timing)
        XCTAssertTrue(short.availablePasses(forBar: 16).contains(2), "stop latency lost a pass")

        let region = short.region(for: BarRef(pass: 2, relativeBar: 16))
        XCTAssertEqual(region?.frameCount, fpb - 100,
                       "forgiven frames do not exist and must not be scheduled")
    }

    func testPassStoppedWellShortIsNotAdmitted() {
        // 40 ms short. A 2000-frame tolerance would wrongly admit this.
        let short = PassIndex(sessions: [session(frames: 2 * loop - 1764)], timing: timing)
        XCTAssertFalse(short.availablePasses(forBar: 16).contains(2))
    }

    // MARK: - The vertical axis wraps through the available set (§1.4)

    func testSwipeSkipsTheGap() {
        let from = BarRef(pass: 2, relativeBar: 9)
        XCTAssertEqual(index.steppingPass(from: from, by: 1)?.pass, 4)
    }

    func testSwipeWrapsAtBothEnds() {
        XCTAssertEqual(index.steppingPass(from: BarRef(pass: 5, relativeBar: 9), by: 1)?.pass, 1)
        XCTAssertEqual(index.steppingPass(from: BarRef(pass: 1, relativeBar: 9), by: -1)?.pass, 5)
    }

    func testSwipeIsContiguousWhereTheAudioIs() {
        XCTAssertEqual(index.steppingPass(from: BarRef(pass: 2, relativeBar: 1), by: 1)?.pass, 3)
    }

    func testSwipeNeverLeavesItsOwnBar() {
        let stepped = index.steppingPass(from: BarRef(pass: 2, relativeBar: 9), by: 1)
        XCTAssertEqual(stepped?.relativeBar, 9)
    }

    func testSwipeOnASingleAvailablePassStaysPut() {
        let one = PassIndex(sessions: [session(frames: loop)], timing: timing)
        XCTAssertEqual(one.steppingPass(from: BarRef(pass: 1, relativeBar: 4), by: 1),
                       BarRef(pass: 1, relativeBar: 4))
    }
}
