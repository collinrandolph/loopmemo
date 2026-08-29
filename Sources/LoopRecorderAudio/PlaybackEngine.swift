#if canImport(AVFoundation)
import AVFoundation
import LoopRecorderCore

/// The AVFoundation shell.
///
/// **Status: not implemented.** This file is a specification of what the engine must
/// do, not a working engine. Nothing here has been compiled or run — there is no Swift
/// toolchain on the machine this was written on, and AVFoundation cannot build off an
/// Apple platform in any case. Treat every line as a claim to be checked in Xcode.
///
/// It is deliberately thin. Everything decidable without audio hardware already lives
/// in `LoopRecorderCore` — `PassIndex.region(for:)` resolves a `BarRef` to a physical
/// range, `SchedulePlan` decides what plays when — because that is the part that can
/// be tested. What is left here is the part that genuinely needs a device.
///
/// ## What a first implementation has to get right
///
/// - **One shared sample-frame anchor.** All seven layers derive their bar starts from
///   the same `AVAudioTime` and schedule against it explicitly. Relative timing drifts
///   layers apart (§0.4, §2.4).
///
/// - **Two player nodes per layer, alternating**, so segment N+1 can overlap the tail
///   of N. Fourteen nodes is negligible.
///
/// - **A 5-10 ms equal-power crossfade on every join, unconditionally** — including a
///   splice into the same source. Bar boundaries in a live recording almost never land
///   on silence, so butt-joining clicks. A no-op fade costs nothing; branching costs a
///   special case (§2.4).
///
/// - **Beat-sized segments, not whole bars.** The committed horizon has to stay short
///   or a live splice waits out everything already queued (§2.4).
///
/// - **Nothing on the render thread.** No allocation, no locks, no file I/O, no UIKit.
///   Peaks come off an input tap via `vDSP_maxmgv` into a lock-free ring buffer, drained
///   on a `CADisplayLink` (§4.2). Note that the previous attempt described its buffer as
///   lock-free while using `NSLock`; a real one needs an atomic index and a fixed
///   allocation.
///
/// - **Latency compensation is mandatory, and was the thing most quietly missing.**
///   `outputLatency + inputLatency + ioBufferDuration`, read *after* the session is
///   active and the route has settled, shifting each recorded session earlier before
///   any bar boundary is derived. Uncompensated, the error compounds across seven
///   layers (§2.3).
///
/// - **A route change invalidates compensation mid-recording**: stop and warn rather
///   than silently producing a misaligned pass (§2.3).
///
/// - **One tap per bus.** `installTap(onBus:)` twice on the input without removing the
///   first throws. Metering and capture have to share one tap, or hand off explicitly.
public final class PlaybackEngine {

    /// Session configuration, which is the one part below that is settled.
    ///
    /// `.measurement` matters: voice isolation and noise suppression duck sustained
    /// notes and strip room tone, which is actively harmful for music (§2.2). Bluetooth
    /// microphones may apply their own processing regardless of mode.
    public static func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord,
                                mode: .measurement,
                                options: [.duckOthers, .defaultToSpeaker])
        try session.setActive(true)
    }

    /// Route-dependent. Read only after the session is active and the route settled.
    public static func totalLatency() -> TimeInterval {
        let session = AVAudioSession.sharedInstance()
        return session.outputLatency + session.inputLatency + session.ioBufferDuration
    }

    public static func latencyFrames(sampleRate: Double) -> Int {
        Int((totalLatency() * sampleRate).rounded())
    }
}
#endif
