import { type BackingTrack, isAudibleInMixdown } from '../../src/domain/bounce.ts';
import {
  ACCIDENTALS,
  type Chord,
  NOTE_LETTERS,
  QUALITIES,
  chordLabel,
  defaultChord,
  randomChord,
} from './chords.ts';
import { bindChips, swipeWheel } from './controls.ts';
import { DRUM_ICON, PIANO_ICON } from './icons.ts';
import { LR, el } from './kit.ts';

/**
 * The drum loop and the chord bed (§2.6, §4.4) — "the same kind of object: non-recorded backing
 * the user plays over".
 *
 * **None of this is domain state.** §2.6's backing tracks are unmodelled: there is no
 * `originalBPM`, no playback ratio and no chord settings anywhere in `src/domain`, so the
 * progression, the tone and the chosen loop live here and do not survive a reload. `bounce.ts`
 * defines the provisional subset it needs; when the real model arrives, this is what moves.
 */

/**
 * Editable working copy of the domain's shape — the fields are readonly there, as every domain
 * type is, so the screen owns a mutable mirror rather than reaching into one.
 */
type Row = { -readonly [K in keyof BackingTrack]: BackingTrack[K] };

const TONES = ['Rhodes', 'Pad', 'Nylon', 'Organ'];

/**
 * Placeholder library — §6.2 lists "drum loop library and selection UI" as not yet designed, so
 * these are names to swipe through, not a decided set.
 */
const DRUM_LOOPS = [
  'Dusty Break 02',
  'Tight Room 01',
  'Boom Bap 04',
  'Half-Time Shuffle',
  'Brush Kit 03',
  'Four on the Floor',
].map((name) => ({ id: name, label: name }));

export function backingRows(): HTMLElement {
  const rowsEl = el('div', 'backing');

  /**
   * The shared half of a backing row: icon, body, speaker, and a panel that opens on a tap
   * anywhere else in the head. The drum row is only this; the chord row adds to it.
   */
  function backingRow(ref: Row, icon: string, body: HTMLElement) {
    const row = el('div', 'lr-row');
    const head = el('div', 'lr-row-head', `<svg class="backing-icon" viewBox="0 0 24 24">${icon}</svg>`);
    head.appendChild(body);

    const vol = LR.VolumeControl({
      level: () => ref.level * 100,
      muted: () => ref.muted,
      onToggle() {
        ref.muted = !ref.muted;
        // §2.6's export rule: any enabled track sounds and exports; mute is how you exclude
        // one. `isAudibleInMixdown` is shared with bounce so the two cannot disagree.
        row.style.opacity = isAudibleInMixdown(ref) ? '1' : '0.62';
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
        `<input class="level" type="range" min="0" max="100" value="${Math.round(ref.level * 100)}" style="flex:1">`,
    );
    settings.querySelector('.level')!.addEventListener('input', (e) => {
      ref.level = Number((e.target as HTMLInputElement).value) / 100;
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

    rowsEl.appendChild(row);
    return { row, head, panel, inner, settings, syncPanelHeight };
  }

  drumRow();
  chordRow();
  return rowsEl;

  // ------------------------------------------------------------------- drums --
  function drumRow() {
    const ref: Row = { id: 'drums', muted: false, level: 0.7 };
    let loop = DRUM_LOOPS[0]!.id;

    const detail = el('div', 'backing-detail', loop);
    const parts = backingRow(ref, DRUM_ICON, detail);

    // The same wheel as the chord fields, and **always in the panel**. There is nothing to pick
    // first: a drum row has one loop where a chord row has four chords, so the picker has no
    // subject to be chosen and no reason to appear and disappear. Which is also why this panel
    // needs no divider — everything in it is the track's.
    parts.inner.append(
      swipeWheel('Loop', DRUM_LOOPS, () => loop, (v) => {
        loop = v;
        detail.textContent = v; // the row head names the loop, so it follows the wheel
      }),
      parts.settings,
    );

    parts.head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.lr-volume')) return;
      parts.row.classList.toggle('is-open');
      parts.syncPanelHeight();
    });
  }

  // ------------------------------------------------------------------ chords --
  function chordRow() {
    const ref: Row = { id: 'chords', muted: false, level: 0.55 };
    const progression: Chord[] = [defaultChord(), defaultChord(), defaultChord(), defaultChord()];
    let tone = TONES[0]!;

    const slots = el('div', 'chord-slots');
    const buttons = progression.map((_, i) => {
      const b = el('span', 'chord');
      b.dataset.slot = String(i);
      slots.appendChild(b);
      return b;
    });
    const parts = backingRow(ref, PIANO_ICON, slots);

    /**
     * The panel has two shapes and one of them is per-chord, so which chord is being edited is
     * part of the open state rather than a mode the panel remembers. `null` is the track view.
     */
    let editing: number | null = null;

    const chordSection = el('div', 'chord-editor');
    const divider = el('div', 'lr-panel-divider');

    const toneRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Tone</span>');
    const toneChips = el('div', 'lr-chips');
    for (const name of TONES) {
      const chip = el('span', `lr-chip${name === tone ? ' is-active' : ''}`, name);
      chip.addEventListener('click', () => {
        tone = name;
      });
      toneChips.appendChild(chip);
    }
    toneRow.appendChild(toneChips);
    bindChips(toneRow);

    // A track setting rather than a per-chord one: it replaces the whole progression, and it is
    // reachable without first picking a chord — which is the point, since the blank slate is
    // four identical C majors (§6.1).
    const randomRow = el('div', 'lr-panel-row random-row');
    const randomBtn = el('button', 'lr-btn', 'Randomize chords');
    randomBtn.addEventListener('click', () => {
      for (let i = 0; i < progression.length; i++) progression[i] = randomChord();
      render(); // the open editor is showing one of the slots that just changed
    });
    randomRow.appendChild(randomBtn);

    parts.inner.append(chordSection, divider, parts.settings, toneRow, randomRow);

    function paintChords() {
      for (const [i, b] of buttons.entries()) {
        b.textContent = chordLabel(progression[i]!);
        b.classList.toggle('is-editing', editing === i);
      }
    }

    /** Three fields inline, each scoped to the one chord being edited. */
    function paintEditor() {
      chordSection.innerHTML = '';
      if (editing === null) return;
      const chord = progression[editing]!;
      chordSection.append(
        swipeWheel('Note', NOTE_LETTERS, () => chord.letter, (v) => {
          chord.letter = v;
          paintChords();
        }),
        swipeWheel('Sign', ACCIDENTALS, () => chord.accidental, (v) => {
          chord.accidental = v as Chord['accidental'];
          paintChords();
        }, 'lr-wheel--sign'),
        swipeWheel('Type', QUALITIES, () => chord.quality, (v) => {
          chord.quality = v as Chord['quality'];
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
