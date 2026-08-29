import Foundation

/// Frame arithmetic for one project's grid.
///
/// Everything here is in **sample frames**, never seconds (§1.4). Each boundary is
/// derived from the absolute formula rather than by accumulating bar durations,
/// because accumulated rounding error walks the boundaries out of alignment over a
/// long recording.
public struct Timing: Equatable, Sendable {
    public let bpm: Int
    public let barCount: Int
    public let beatsPerBar: Int
    public let sampleRate: Double

    /// Stopping has latency, so a pass the user played to completion can land a hair
    /// short of the arithmetic and would otherwise vanish (§1.4).
    ///
    /// Expressed as a **duration**, not a frame count. A hardcoded frame count means a
    /// different amount of slack at 44.1 kHz than at 48 kHz, and the thing being
    /// forgiven is a physical delay measured in milliseconds.
    ///
    /// The spec says "a few milliseconds". Do not inflate this: the tolerance admits a
    /// bar whose audio does not fully exist, and the scheduler will then read past the
    /// end of the file for it. 45 ms — a plausible-looking 2000 frames — is enough to
    /// admit a pass that stopped most of a beat early.
    public static let toleranceSeconds: Double = 0.004

    public init(bpm: Int, barCount: Int, sampleRate: Double, beatsPerBar: Int = 4) {
        precondition(bpm > 0, "bpm must be positive")
        precondition(barCount >= 1, "barCount must be positive")
        precondition(sampleRate > 0, "sampleRate must be positive")
        precondition(beatsPerBar >= 1, "beatsPerBar must be positive")
        self.bpm = bpm
        self.barCount = barCount
        self.sampleRate = sampleRate
        self.beatsPerBar = beatsPerBar
    }

    /// `round(sampleRate × 60 × beatsPerBar / bpm)` — §1.4. Never hardcode 240 (§5.1 #1).
    public var framesPerBar: Int {
        Int((sampleRate * 60.0 * Double(beatsPerBar) / Double(bpm)).rounded())
    }

    public var loopFrames: Int { framesPerBar * barCount }

    /// Seconds for one traversal of the loop. Double throughout — integer division here
    /// silently truncates (4 bars at 100 BPM is 9.6 s, not 9).
    public var loopSeconds: Double {
        Double(barCount * beatsPerBar) * 60.0 / Double(bpm)
    }

    /// The end-of-session slack, in frames at this project's rate.
    public var toleranceFrames: Int {
        Int((sampleRate * Self.toleranceSeconds).rounded())
    }

    /// Frame offset of a bar within a single traversal of the loop.
    public func frameOffsetInLoop(relativeBar: Int) -> Int {
        precondition((1...barCount).contains(relativeBar),
                     "relativeBar \(relativeBar) outside 1...\(barCount)")
        return (relativeBar - 1) * framesPerBar
    }

    /// Total passes a session of `frames` holds, partial ones included (§1.4).
    public func passCount(frames: Int) -> Int {
        guard frames > 0 else { return 0 }
        let quotient = frames / loopFrames
        return frames % loopFrames == 0 ? quotient : quotient + 1
    }

    /// Does the `localPass`-th traversal of this session contain `relativeBar`?
    ///
    /// `barExists` from §1.4, verbatim:
    ///     ((localPass - 1) × loopFrames + (r - 1) × framesPerBar) + framesPerBar
    ///         <= session.frames + tolerance
    public func barExists(localPass: Int, relativeBar: Int, inSessionOf frames: Int) -> Bool {
        precondition(localPass >= 1, "localPass is 1-based")
        let start = (localPass - 1) * loopFrames + frameOffsetInLoop(relativeBar: relativeBar)
        return start + framesPerBar <= frames + toleranceFrames
    }
}
