import {
  ACCIDENTALS,
  type BackingTracks,
  CHORD_TONES,
  type Chord,
  type ChordToneId,
  DRUM_KITS,
  DRUM_PATTERNS,
  NOTE_LETTERS,
  OCTAVES,
  type Octave,
  QUALITIES,
  CHORD_PATTERNS,
  chordLabel,
  drumPattern,
  randomChord,
} from '../../src/domain/backing.ts';
import { isAudibleInMixdown } from '../../src/domain/bounce.ts';
import { bindChips, swipeWheel } from './controls.ts';
import { DRUM_ICON, PIANO_ICON } from './icons.ts';
import { LR, el } from './kit.ts';

/**
 * The drum track and the chord bed (§2.6, §4.4) — "the same kind of object: non-recorded backing
 * the user plays over".
 *
 * **This is domain state now.** It used to own the progression, the tone and the chosen loop as
 * screen state that did not survive a reload, and handed the export screen nothing — so a backing
 * track muted here still exported a stem. Both tracks live on `Project` now; this edits them and
 * reports upward, exactly like a layer row.
 *
 * Every option comes from `src/domain/backing.ts`. Nothing here invents a pattern name or a tone,
 * which is what makes what you see identical to what gets scheduled.
 */
export function backingRows(opts: {
  backing: BackingTracks;
  onChange(next: BackingTracks): void;
}): HTMLElement {
  const rowsEl = el('div', 'backing');

  /** Local mirror, so a wheel can read the current value between renders. */
  let backing = opts.backing;

  function update(next: BackingTracks) {
    backing = next;
    opts.onChange(next);
  }

  const wheelItems = <T extends { id: string; name: string }>(xs: readonly T[]) =>
    xs.map((x) => ({ id: x.id, label: x.name }));

  /**
   * The shared half of a backing row: icon, body, speaker, and a panel that opens on a tap
   * anywhere else in the head. The drum row is only this; the chord row adds to it.
   *
   * **`track` is an accessor, not a value.** Passing the object captured the state at build time,
   * so `!track.muted` read a snapshot that never changed — muting worked once and unmuting was a
   * no-op that re-sent `muted: true`. Everything a handler reaches for has to go through
   * `backing`, which `update` replaces wholesale.
   */
  function backingRow(
    track: () => { level: number; muted: boolean },
    setTrack: (patch: { level?: number; muted?: boolean }) => void,
    icon: string,
    body: HTMLElement,
  ) {
    const row = el('div', 'lr-row');
    const head = el('div', 'lr-row-head', `<svg class="backing-icon" viewBox="0 0 24 24">${icon}</svg>`);
    head.appendChild(body);

    const vol = LR.VolumeControl({
      level: () => track().level * 100,
      muted: () => track().muted,
      onToggle() {
        setTrack({ muted: !track().muted });
        // §2.6's export rule: anything not muted sounds and exports; mute is how you exclude one.
        // `isAudibleInMixdown` is shared with bounce and export so the three cannot disagree.
        row.style.opacity = isAudibleInMixdown(track()) ? '1' : '0.62';
        vol.update();
      },
    });
    head.appendChild(vol);
    row.appendChild(head);

    const panel = el('div', 'lr-panel');
    const inner = el('div', 'lr-panel-inner');
    panel.appendChild(inner);
    row.appendChild(panel);

    const settings = el(
      'div',
      'lr-panel-row',
      '<span class="lr-panel-label">Volume</span>' +
        `<input class="level" type="range" min="0" max="100" value="${Math.round(track().level * 100)}" style="flex:1">`,
    );
    settings.querySelector('.level')!.addEventListener('input', (e) => {
      setTrack({ level: Number((e.target as HTMLInputElement).value) / 100 });
      vol.update();
    });

    /**
     * `max-height` is the kit's collapse mechanism, and a CSS value has to be a guess big enough
     * for the tallest panel it will ever hold. The guess costs time: 400 against 180px of content
     * means the first 55% of a collapse moves nothing, because `max-height` has to fall past the
     * content before the box starts shrinking. Measured per panel instead, so the transition is
     * the whole of the movement and a tap gets an immediate response.
     */
    function syncPanelHeight() {
      panel.style.maxHeight = row.classList.contains('is-open') ? `${panel.scrollHeight}px` : '0px';
    }

    row.style.opacity = isAudibleInMixdown(track()) ? '1' : '0.62';
    rowsEl.appendChild(row);
    return { row, head, panel, inner, settings, syncPanelHeight };
  }

  drumRow();
  chordRow();
  return rowsEl;

  // ------------------------------------------------------------------- drums --
  function drumRow() {
    const drums = () => backing.drums;
    const setDrums = (patch: Partial<BackingTracks['drums']>) =>
      update({ ...backing, drums: { ...backing.drums, ...patch } });

    // The head names the pattern, not the kit. A pattern is what the groove *is*; a kit is how it
    // is voiced, and naming both in a one-line row would put two nouns where the eye wants one.
    const detail = el('div', 'backing-detail', drumPattern(drums().patternId).name);
    const parts = backingRow(drums, setDrums, DRUM_ICON, detail);

    // Both wheels are **always in the panel**. There is nothing to pick first: a drum row has one
    // pattern where a chord row has four chords, so a picker here has no subject to be chosen and
    // no reason to appear and disappear. Which is also why this panel needs no divider —
    // everything in it belongs to the track.
    parts.inner.append(
      // Volume leads, as it does in every layer panel. A backing row is the same kind of row, so
      // the one control they share should not move depending on which row you opened.
      parts.settings,
      swipeWheel('Pattern', wheelItems(DRUM_PATTERNS), () => drums().patternId, (v) => {
        setDrums({ patternId: v });
        detail.textContent = drumPattern(v).name;
      }, { layout: 'row' }),
      // Independent of pattern (§2.6): any kit plays any pattern. Two wheels rather than one
      // combined list is the whole point — a single list of 24 would re-couple them.
      swipeWheel('Kit', wheelItems(DRUM_KITS), () => drums().kitId, (v) => setDrums({ kitId: v }), {
        layout: 'row',
      }),
    );

    parts.head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.lr-volume')) return;
      parts.row.classList.toggle('is-open');
      parts.syncPanelHeight();
    });
  }

  // ------------------------------------------------------------------ chords --
  function chordRow() {
    const bed = () => backing.chords;
    const setBed = (patch: Partial<BackingTracks['chords']>) =>
      update({ ...backing, chords: { ...backing.chords, ...patch } });
    const setSlot = (index: number, patch: Partial<Chord>) =>
      setBed({ slots: bed().slots.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

    const slots = el('div', 'chord-slots');
    const buttons = bed().slots.map((_, i) => {
      const b = el('span', 'chord');
      b.dataset.slot = String(i);
      slots.appendChild(b);
      return b;
    });
    const parts = backingRow(bed, setBed, PIANO_ICON, slots);

    /**
     * The panel has two shapes and one of them is per-chord, so which chord is being edited is
     * part of the open state rather than a mode the panel remembers. `null` is the track view.
     */
    let editing: number | null = null;

    const chordSection = el('div', 'chord-editor');
    const divider = el('div', 'lr-panel-divider');

    // All three are per project rather than per slot (§2.6), and they sit with Volume below the
    // divider — which is what the divider means: above it is the chord being edited, below it is
    // the whole track.
    //
    // **The chord row mirrors the drum row control for control**: Volume, then Pattern, then the
    // voicing. Tone is to the chord bed what Kit is to the drums — the same list of names doing
    // the same job — so it is the same control, a wheel. Octave has no counterpart on the drum
    // row and is only three fixed positions, so chips show the whole range at once and Low or
    // High is one tap instead of a step.
    const patternWheel = swipeWheel(
      'Pattern',
      wheelItems(CHORD_PATTERNS),
      () => bed().chordPatternId,
      (v) => setBed({ chordPatternId: v }),
      { layout: 'row' },
    );
    const toneWheel = swipeWheel(
      'Tone',
      wheelItems(CHORD_TONES),
      () => bed().tone,
      (v) => setBed({ tone: v as ChordToneId }),
      { layout: 'row' },
    );

    const octaveRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Octave</span>');
    const octaveChips = el('div', 'lr-chips');
    for (const octave of OCTAVES) {
      const chip = el('span', `lr-chip${octave.value === bed().octave ? ' is-active' : ''}`, octave.label);
      chip.addEventListener('click', () => setBed({ octave: octave.value }));
      octaveChips.appendChild(chip);
    }
    octaveRow.appendChild(octaveChips);
    bindChips(octaveRow);

    // A track setting rather than a per-chord one: it replaces the whole progression, and it is
    // reachable without first picking a chord — which is the point, since the blank slate is
    // four identical C majors (§6.1).
    const randomRow = el('div', 'lr-panel-row random-row');
    const randomBtn = el('button', 'lr-btn', 'Randomize chords');
    randomBtn.addEventListener('click', () => {
      setBed({ slots: bed().slots.map(() => randomChord()) });
      render(); // the open editor is showing one of the slots that just changed
    });
    randomRow.appendChild(randomBtn);

    parts.inner.append(
      chordSection,
      divider,
      parts.settings,
      patternWheel,
      toneWheel,
      octaveRow,
      randomRow,
    );

    function paintChords() {
      for (const [i, b] of buttons.entries()) {
        b.textContent = chordLabel(bed().slots[i]!);
        b.classList.toggle('is-editing', editing === i);
      }
    }

    /** Three fields inline, each scoped to the one chord being edited. */
    function paintEditor() {
      chordSection.innerHTML = '';
      if (editing === null) return;
      const index = editing;
      const chord = () => bed().slots[index]!;
      chordSection.append(
        swipeWheel('Note', NOTE_LETTERS.map((l) => ({ id: l, label: l })), () => chord().letter, (v) => {
          setSlot(index, { letter: v });
          paintChords();
        }),
        swipeWheel('Sign', ACCIDENTALS.map((a) => ({ id: a.id, label: a.label })), () => chord().accidental, (v) => {
          setSlot(index, { accidental: v as Chord['accidental'] });
          paintChords();
        }, { extraClass: 'lr-wheel--sign' }),
        swipeWheel('Type', QUALITIES.map((q) => ({ id: q.id, label: q.label })), () => chord().quality, (v) => {
          setSlot(index, { quality: v as Chord['quality'] });
          paintChords();
        }),
      );
    }

    function render() {
      parts.row.classList.toggle('is-editing-chord', editing !== null);
      paintEditor();
      paintChords();
      // Swapping between the chord view and the track view changes the content height, so the
      // measured cap has to follow it — otherwise the taller of the two is clipped.
      parts.syncPanelHeight();
    }

    /**
     * Closing a panel that is showing a chord has to unmount the editor **after** the collapse,
     * not with it. `is-editing-chord` hides the fields outright, so dropping it alongside
     * `is-open` shortened the content from 180px to 111px in one frame while `max-height` was
     * still animating — the panel jumped most of the way down and then eased the remainder.
     *
     * The chord button un-highlights immediately, because that is feedback for the tap and does
     * not move anything. Only the part that changes height waits.
     */
    parts.panel.addEventListener('transitionend', (e) => {
      if (e.propertyName !== 'max-height') return;
      if (parts.row.classList.contains('is-open')) return; // that was an open, or a reopen
      parts.row.classList.remove('is-editing-chord');
      paintEditor();
    });

    function close() {
      editing = null;
      paintChords();
      parts.row.classList.remove('is-open');
      parts.syncPanelHeight();
      // `is-editing-chord` deliberately stays; the transitionend above takes it off.
    }

    function show(next: number | null) {
      // Tapping the chord already open closes the panel; tapping a different one swaps the
      // editor without closing, so moving along the progression is one tap rather than two.
      if (parts.row.classList.contains('is-open') && editing === next) {
        close();
        return;
      }
      editing = next;
      parts.row.classList.add('is-open');
      render();
    }

    parts.head.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.lr-volume')) return;
      const chip = target.closest<HTMLElement>('.chord');
      if (chip) {
        show(Number(chip.dataset.slot));
        return;
      }
      // Outside the chord buttons the row is a plain toggle for the whole panel. An open panel
      // closes rather than falling back to the track view: that fallback made one tap on the
      // row do two different things depending on what the panel happened to be showing.
      if (parts.row.classList.contains('is-open')) close();
      else show(null);
    });

    paintChords();
  }
}
