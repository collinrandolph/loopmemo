import Foundation

/// Where a bar's audio came from: which traversal of the loop, and which bar within it.
///
/// Both fields are 1-based. This pair exists rather than a flat absolute bar number
/// because the two swipe axes map directly onto it (§1.3) — vertical steps `pass`,
/// horizontal steps `relativeBar`.
///
/// A `BarRef` is a *source*. Where it sits in the arrangement is its *slot*, which is
/// just its index in `Layer.barSources`. The two are never the same thing (§1.1).
public struct BarRef: Hashable, Codable, Sendable {
    public let pass: Int
    public let relativeBar: Int

    public init(pass: Int, relativeBar: Int) {
        precondition(pass >= 1, "pass is 1-based, got \(pass)")
        precondition(relativeBar >= 1, "relativeBar is 1-based, got \(relativeBar)")
        self.pass = pass
        self.relativeBar = relativeBar
    }

    /// Decompose a 0-based absolute bar number.
    ///
    /// Spec §1.3 states this with 1-based absolute bars; this takes 0-based, which is
    /// what array indices and frame arithmetic actually produce. The verified examples
    /// still hold: 1-based bar 17 in a 16-bar loop is 0-based 16, and gives P2 / 1.
    public static func fromAbsolute(_ absoluteBar: Int, barCount: Int) -> BarRef {
        precondition(absoluteBar >= 0, "absolute bar is 0-based, got \(absoluteBar)")
        precondition(barCount >= 1, "barCount must be positive")
        return BarRef(pass: (absoluteBar / barCount) + 1,
                      relativeBar: (absoluteBar % barCount) + 1)
    }

    /// Recompose to a 0-based absolute bar number.
    public func toAbsolute(barCount: Int) -> Int {
        (pass - 1) * barCount + (relativeBar - 1)
    }

    // MARK: - Axis stepping
    //
    // The two axes are independent, and each stays on its own (§1.3, §3.7). Stepping
    // `relativeBar` off the end does NOT roll into the next pass: that would change
    // both coordinates at once from a single horizontal swipe, which is exactly the
    // conflation the {pass, relativeBar} pair exists to prevent.
    //
    // Availability is not consulted here. §1.4 requires the vertical axis to wrap
    // through the *available* set for the bar being swiped, skipping absent passes —
    // that needs the recorded audio, so it lives on `PassAvailability.steppingPass`.

    /// Step the horizontal axis, wrapping within the same pass.
    public func steppingBar(by delta: Int, barCount: Int) -> BarRef {
        precondition(barCount >= 1, "barCount must be positive")
        let zeroBased = relativeBar - 1 + delta
        let wrapped = ((zeroBased % barCount) + barCount) % barCount
        return BarRef(pass: pass, relativeBar: wrapped + 1)
    }
}
