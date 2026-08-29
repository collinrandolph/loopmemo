import XCTest
@testable import LoopRecorderCore

final class TimingTests: XCTestCase {
    func testFramesPerBarMatchesTheSpecFormula() {
        // round(44100 × 60 × 4 / 96) = 110250, exactly.
        XCTAssertEqual(Timing(bpm: 96, barCount: 16, sampleRate: 44_100).framesPerBar, 110_250)
    }

    func testFramesPerBarHonoursBeatsPerBar() {
        // §5.1 #1: beatsPerBar is a named constant, never a hardcoded 240.
        let fourFour = Timing(bpm: 120, barCount: 8, sampleRate: 44_100, beatsPerBar: 4)
        let threeFour = Timing(bpm: 120, barCount: 8, sampleRate: 44_100, beatsPerBar: 3)
        XCTAssertEqual(fourFour.framesPerBar * 3, threeFour.framesPerBar * 4)
    }

    func testLoopSecondsIsNotTruncated() {
        // Integer division silently rounds 9.6 s down to 9 — a 6% error in every size
        // projection at that tempo.
        let t = Timing(bpm: 100, barCount: 4, sampleRate: 44_100)
        XCTAssertEqual(t.loopSeconds, 9.6, accuracy: 0.0001)
    }

    func testLoopSecondsMatchesTheSpecTable() {
        XCTAssertEqual(Timing(bpm: 96, barCount: 16, sampleRate: 44_100).loopSeconds, 40, accuracy: 0.001)
        XCTAssertEqual(Timing(bpm: 84, barCount: 32, sampleRate: 44_100).loopSeconds, 91.43, accuracy: 0.01)
    }

    func testPassCountIncludesPartialPasses() {
        let t = Timing(bpm: 96, barCount: 16, sampleRate: 44_100)
        XCTAssertEqual(t.passCount(frames: 0), 0)
        XCTAssertEqual(t.passCount(frames: t.loopFrames), 1)
        XCTAssertEqual(t.passCount(frames: t.loopFrames + 1), 2)
        XCTAssertEqual(t.passCount(frames: 2 * t.loopFrames + 8 * t.framesPerBar), 3)
    }
}

final class BarRefTests: XCTestCase {
    func testTheSpecsVerifiedExamples() {
        // "absolute bar 17 in a 16-bar loop -> P2 / 1; bar 33 -> P3 / 1", 1-based.
        // fromAbsolute takes 0-based, so those are 16 and 32.
        XCTAssertEqual(BarRef.fromAbsolute(16, barCount: 16), BarRef(pass: 2, relativeBar: 1))
        XCTAssertEqual(BarRef.fromAbsolute(32, barCount: 16), BarRef(pass: 3, relativeBar: 1))
        XCTAssertEqual(BarRef.fromAbsolute(0, barCount: 16), BarRef(pass: 1, relativeBar: 1))
        XCTAssertEqual(BarRef.fromAbsolute(15, barCount: 16), BarRef(pass: 1, relativeBar: 16))
    }

    func testRoundTrip() {
        for bar in 0..<200 {
            let ref = BarRef.fromAbsolute(bar, barCount: 12)
            XCTAssertEqual(ref.toAbsolute(barCount: 12), bar)
        }
    }

    func testSteppingBarStaysInsideItsPass() {
        // §1.3: the two axes are independent. A horizontal swipe off the end of the
        // loop must not also change the pass — that conflates both coordinates into
        // one gesture, which is the whole reason the pair exists rather than a flat
        // index.
        let last = BarRef(pass: 2, relativeBar: 16)
        XCTAssertEqual(last.steppingBar(by: 1, barCount: 16), BarRef(pass: 2, relativeBar: 1))

        let first = BarRef(pass: 2, relativeBar: 1)
        XCTAssertEqual(first.steppingBar(by: -1, barCount: 16), BarRef(pass: 2, relativeBar: 16))
    }

    func testSteppingBarHandlesLargeAndNegativeDeltas() {
        let ref = BarRef(pass: 1, relativeBar: 1)
        XCTAssertEqual(ref.steppingBar(by: 17, barCount: 16).relativeBar, 2)
        XCTAssertEqual(ref.steppingBar(by: -17, barCount: 16).relativeBar, 16)
    }
}

final class ProjectSizeTests: XCTestCase {
    private func project(bpm: Int, bars: Int, quality: AudioQuality) throws -> Project {
        try Project(name: "t", bpm: bpm, barCount: bars, quality: quality)
    }

    func testTotalPassesSumsAcrossLayersRatherThanTakingTheMax() throws {
        // §2.7's table — 5 layers, 12 passes — only holds if this is the total. Taking
        // the max would report 3 here and understate the size by a factor of four.
        var p = try project(bpm: 96, bars: 16, quality: .high)
        let loop = p.timing.loopFrames
        let url = URL(fileURLWithPath: "/dev/null")
        for i in 0..<4 {
            p.layers[i].sessions = [RecordingSession(audioFileURL: url, recordedFrames: 3 * loop)]
        }
        XCTAssertEqual(p.totalPasses, 12)
        XCTAssertEqual(p.recordedLayerCount, 4)
    }

    func testCompressionSavesNothingWhenEveryLayerHoldsOnePass() throws {
        var p = try project(bpm: 96, bars: 16, quality: .high)
        let loop = p.timing.loopFrames
        let url = URL(fileURLWithPath: "/dev/null")
        for i in 0..<3 {
            p.layers[i].sessions = [RecordingSession(audioFileURL: url, recordedFrames: loop)]
        }
        // "Sometimes the honest answer is 'this won't help.'" (§2.7)
        XCTAssertFalse(p.sizeProjection.isWorthCompressing)
        XCTAssertEqual(p.sizeProjection.savingBytes, 0)
    }

    func testConfigurationLocksAfterTheFirstRecording() throws {
        var p = try project(bpm: 96, bars: 16, quality: .standard)
        XCTAssertNoThrow(try p.setBPM(120))

        p.layers[0].sessions = [RecordingSession(audioFileURL: URL(fileURLWithPath: "/dev/null"),
                                                 recordedFrames: 1000)]
        XCTAssertTrue(p.isConfigurationLocked)
        XCTAssertThrowsError(try p.setBPM(90)) { error in
            XCTAssertEqual(error as? Project.ConfigurationError, .lockedByRecording)
        }
    }

    func testInvalidConfigurationIsRejected() {
        XCTAssertThrowsError(try Project(name: "t", bpm: 59, barCount: 16, quality: .standard))
        XCTAssertThrowsError(try Project(name: "t", bpm: 241, barCount: 16, quality: .standard))
        XCTAssertThrowsError(try Project(name: "t", bpm: 120, barCount: 6, quality: .standard))
    }

    func testSevenLayersExactly() throws {
        XCTAssertEqual(try project(bpm: 120, bars: 8, quality: .standard).layers.count, 7)
    }
}
