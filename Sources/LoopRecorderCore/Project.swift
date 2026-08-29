import Foundation

public struct Project: Identifiable, Codable, Equatable, Sendable {
    public static let layerCount = 7
    public static let validBarCounts = [4, 8, 12, 16, 20, 24, 28, 32]
    public static let bpmRange = 60...240

    public let id: UUID
    public var name: String
    public let createdDate: Date
    public var lastModified: Date

    /// Locked after the first recording — every derived value depends on them
    /// (§5.1 #4). Guarded by `isConfigurationLocked`.
    public private(set) var bpm: Int
    public private(set) var barCount: Int
    public let beatsPerBar: Int
    public let audioQuality: AudioQuality

    /// A label and a storage fact only; cleared by recording. **Never gate UI on it** —
    /// the pass axis re-enables on its own because availability derives from audio
    /// (§1.4), not from this flag.
    public var isCompressed: Bool
    public var bouncedFromProjectId: UUID?

    public var drumLoop: DrumLoop?
    public var chordProgression: ChordProgression?
    public var layers: [Layer]

    public init(
        id: UUID = UUID(),
        name: String,
        bpm: Int,
        barCount: Int,
        quality: AudioQuality,
        beatsPerBar: Int = 4,
        drumLoop: DrumLoop? = nil
    ) throws {
        guard Self.bpmRange.contains(bpm) else { throw ConfigurationError.bpmOutOfRange(bpm) }
        guard Self.validBarCounts.contains(barCount) else {
            throw ConfigurationError.invalidBarCount(barCount)
        }
        self.id = id
        self.name = name
        self.createdDate = Date()
        self.lastModified = Date()
        self.bpm = bpm
        self.barCount = barCount
        self.beatsPerBar = beatsPerBar
        self.audioQuality = quality
        self.isCompressed = false
        self.drumLoop = drumLoop
        self.layers = (0..<Self.layerCount).map { Layer(index: $0) }
    }

    public enum ConfigurationError: Error, Equatable {
        case bpmOutOfRange(Int)
        case invalidBarCount(Int)
        case lockedByRecording
    }

    public var timing: Timing {
        Timing(bpm: bpm, barCount: barCount,
               sampleRate: audioQuality.sampleRate, beatsPerBar: beatsPerBar)
    }

    public var hasRecordings: Bool { layers.contains(where: \.hasRecording) }

    /// Setup is the last point at which BPM and bar count can change (§4.5).
    public var isConfigurationLocked: Bool { hasRecordings }

    public mutating func setBPM(_ value: Int) throws {
        guard !isConfigurationLocked else { throw ConfigurationError.lockedByRecording }
        guard Self.bpmRange.contains(value) else { throw ConfigurationError.bpmOutOfRange(value) }
        bpm = value
        lastModified = Date()
    }

    public mutating func setBarCount(_ value: Int) throws {
        guard !isConfigurationLocked else { throw ConfigurationError.lockedByRecording }
        guard Self.validBarCounts.contains(value) else {
            throw ConfigurationError.invalidBarCount(value)
        }
        barCount = value
        lastModified = Date()
    }

    /// **Summed across layers, not maxed.** §2.7's worked example — 5 layers, 12 passes,
    /// 66 MB — only holds if this is the total, and the whole point of showing it in the
    /// Library is that it, not the layer count, explains the size.
    public var totalPasses: Int {
        let t = timing
        return layers.reduce(0) { $0 + $1.totalPasses(timing: t) }
    }

    public var recordedLayerCount: Int { layers.filter(\.hasRecording).count }

    public var sizeProjection: SizeProjection {
        SizeProjection(totalPasses: totalPasses,
                       recordedLayerCount: recordedLayerCount,
                       loopSeconds: timing.loopSeconds,
                       quality: audioQuality)
    }
}

/// A reference track: non-recorded backing the user plays against (§2.6).
public struct DrumLoop: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public var audioFileURL: URL
    public let duration: Double
    /// Immutable. Playback rate is `targetBPM / originalBPM`.
    public let originalBPM: Int
    public let channels: Int

    public init(id: String, name: String, audioFileURL: URL,
                duration: Double, originalBPM: Int, channels: Int) {
        self.id = id
        self.name = name
        self.audioFileURL = audioFileURL
        self.duration = duration
        self.originalBPM = originalBPM
        self.channels = channels
    }

    public func stretchRatio(targetBPM: Int) -> Double {
        Double(targetBPM) / Double(originalBPM)
    }

    /// `AVAudioUnitTimePitch` covers 0.5–2.0×; warn on quality outside it (§2.6).
    public func isRatioWithinQualityRange(targetBPM: Int) -> Bool {
        (0.5...2.0).contains(stretchRatio(targetBPM: targetBPM))
    }
}

/// Generated, not sampled — so changing BPM changes only when chords trigger, never how
/// they sound, and the time-stretch ratio limits do not apply (§2.6, §4.4).
public struct ChordProgression: Codable, Equatable, Sendable {
    public enum Scale: String, Codable, CaseIterable, Sendable {
        case major, minor, dorian, mixolydian, phrygian, lydian, harmonicMinor
    }
    public enum Tone: String, Codable, CaseIterable, Sendable {
        case pad, keys, pluck
    }

    public var enabled: Bool
    public var scale: Scale
    public var tone: Tone
    public var level: Float
    /// Exactly four — a 4-bar progression tiles evenly into every valid bar count, so
    /// no partial-progression case exists (§4.4).
    public var slots: [ChordSlot]

    public init(enabled: Bool = false, scale: Scale = .major, tone: Tone = .pad,
                level: Float = 0.7, slots: [ChordSlot]? = nil) {
        self.enabled = enabled
        self.scale = scale
        self.tone = tone
        self.level = level
        self.slots = slots ?? Array(repeating: ChordSlot(root: .c, accidental: .natural), count: 4)
    }
}

/// **Scale plus root is enough.** The scale determines each chord's quality from its
/// root — D in C major is D minor; D in D major is D major. The user never picks
/// "minor" or "diminished". Do not add a quality picker to the primary interface: it
/// doubles the decisions and undoes the entire benefit (§4.4).
public struct ChordSlot: Codable, Equatable, Sendable {
    public enum Root: String, Codable, CaseIterable, Sendable { case c, d, e, f, g, a, b }
    public enum Accidental: String, Codable, Sendable { case natural, flat, sharp }

    public var root: Root
    public var accidental: Accidental

    public init(root: Root, accidental: Accidental) {
        self.root = root
        self.accidental = accidental
    }
}
