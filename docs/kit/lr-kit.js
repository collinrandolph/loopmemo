/* ============================================================================
   Loop Recorder — shared kit (classic script, exposes window.LR)

   Terminology follows the spec glossary:
     bar     one bar of music; the grid unit, swipe axis and splice unit
     pass    one traversal of the loop during a continuous recording
     loop    the project's repeating structure (and the drum loop)
     layer   one of the seven recorded tracks
     slot    a bar's position in the arrangement, vs where its audio came from
     tile    one bar's cell on the Edit Layer screen
     lane    one layer's full-loop strip on the Playback screen
   ========================================================================= */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ gradient -- */
  /* Anchors are interpolated to however many stops are needed. The stop count
     is always DERIVED from the line count, never the other way round — song
     length must never be limited by how many colours are defined. The greens
     and blues are load-bearing: an orange-to-purple ramp hid the joins. */
  var ANCHORS = [
    [255,138, 91], [255,178, 89], [255,217,102], [214,230,110],
    [124,224,142], [ 79,209,197], [ 86,194,255], [122,168,255],
    [169,140,255], [229,140,224], [255,143,176]
  ];

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clamp01(v) { return clamp(v, 0, 1); }

  var ramp = {
    anchors: ANCHORS,
    /** rgb triple at position t (0-1) along the ramp */
    rgb: function (t) {
      var seg = (ANCHORS.length - 1) * clamp01(t);
      var i = Math.min(Math.floor(seg), ANCHORS.length - 2);
      var f = seg - i, a = ANCHORS[i], b = ANCHORS[i + 1];
      return [
        Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f)
      ];
    },
    css: function (t) { var c = ramp.rgb(t); return 'rgb(' + c + ')'; },
    /** the slice of the ramp belonging to layer `i` of `n` */
    slice: function (i, n) { return [i / n, (i + 1) / n]; },
    /** blend an rgb triple toward a spent target */
    toSpent: function (rgb, t, spent) {
      return 'rgb(' +
        Math.round(rgb[0] + (spent[0] - rgb[0]) * t) + ',' +
        Math.round(rgb[1] + (spent[1] - rgb[1]) * t) + ',' +
        Math.round(rgb[2] + (spent[2] - rgb[2]) * t) + ')';
    },
    /** read an rgb triple out of a CSS custom property */
    tokenRGB: function (name) {
      return getComputedStyle(document.documentElement)
        .getPropertyValue(name).split(',').map(function (v) { return +v.trim(); });
    }
  };

  /* -------------------------------------------------------------- motion -- */
  /* One model for every height change on every screen. Each source produces an
     activation; activations map to scale factors; factors compose. */
  var motion = {
    PLAYED_SCALE: 0.8,   // a line settles to 80% once the playhead passes
    SWIPE_REST:   0.6,   // a swipe contracts to 60% of current height
    COLOR_FEATHER: 2.5,  // lines over which colour fades to spent
    TAU: { swipe: 70, release: 120, reset: 180, mute: 110 },

    easeIn: function (t) { return t * t * t; },   // holds, then snaps on the beat

    /** frame-rate independent approach toward a target */
    approach: function (value, target, tau, dt) {
      return value + (target - value) * (1 - Math.exp(-dt / tau));
    },

    /** playback scale for a line `passed` units beyond the playhead */
    playScale: function (passed) {
      return 1 - (1 - motion.PLAYED_SCALE) * motion.easeIn(clamp01(passed));
    },

    /** swipe scale from an activation of 1 (rest) to 0 (fully contracted) */
    swipeScale: function (activation) {
      return motion.SWIPE_REST + (1 - motion.SWIPE_REST) * activation;
    },

    /* Snap a rendered height to an even whole pixel. Centre alignment puts a
       line's midpoint on the container centreline, so an odd or fractional
       height lands its edges on half-pixels — which antialiases the capsule
       caps into hairlines above and below the line. */
    snapEven: function (px, min) {
      return Math.max(min || 2, Math.round(px / 2) * 2);
    }
  };

  /* -------------------------------------------------------------- sizing -- */
  var sizing = {
    /* Whole-pixel line widths are mandatory: fractional widths put some lines
       on device-pixel boundaries and not others, so identical lines render at
       visibly different weights.

       Two strategies:
         fitToCount  fixed line count, width follows  (edit tiles: 16 per bar)
         fitToWidth  target a line count, width and count both follow the
                     container (playback lanes, which are an overview) */
    fitToCount: function (containerPx, lineCount, minWidth) {
      var w = Math.max(minWidth || 2, Math.floor(containerPx / (2 * lineCount)));
      return { width: w, count: lineCount };
    },
    fitToWidth: function (containerPx, targetLines, minCount) {
      var w = Math.max(1, Math.round(containerPx / (2 * targetLines)));
      var n = Math.max(minCount || 8, Math.floor(containerPx / (2 * w)));
      return { width: w, count: n };
    },
    apply: function (width) {
      document.documentElement.style.setProperty('--lr-line-w', width + 'px');
      document.documentElement.style.setProperty('--lr-line-gap', width + 'px');
    }
  };

  /* ------------------------------------------------------ bars and passes -- */
  var timing = {
    BEATS_PER_BAR: 4,           // v1 is 4/4; named so other signatures stay reachable

    framesPerBar: function (sampleRate, bpm, beatsPerBar) {
      return Math.round(sampleRate * 60 * (beatsPerBar || timing.BEATS_PER_BAR) / bpm);
    },
    loopSeconds: function (barCount, bpm, beatsPerBar) {
      return barCount * (beatsPerBar || timing.BEATS_PER_BAR) * 60 / bpm;
    },

    /** absolute bar number -> { pass, relativeBar }, both 1-based */
    barRef: function (barNumber, barCount) {
      return {
        pass: Math.floor((barNumber - 1) / barCount) + 1,
        relativeBar: ((barNumber - 1) % barCount) + 1
      };
    },
    /** the inverse */
    absoluteBar: function (ref, barCount) {
      return (ref.pass - 1) * barCount + ref.relativeBar;
    },

    /* Pass availability is DERIVED from recorded audio, per session — never
       from a stored counter, and never from a layer's total duration. Sessions
       must not be concatenated: a partial pass would put every later boundary
       at the wrong offset.

       sessions: [{ frames }] in recording order.
       Returns the pass numbers that contain relative bar `r`; the set can be
       non-contiguous, because a session that stopped early has the pass for
       bar 1 but not for bar 12. */
    passesForBar: function (sessions, relativeBar, framesPerBar, barCount, tolerance) {
      var loopFrames = framesPerBar * barCount, tol = tolerance || 0;
      var out = [], base = 0;
      sessions.forEach(function (s) {
        var count = Math.ceil(s.frames / loopFrames);
        for (var local = 1; local <= count; local++) {
          var start = (local - 1) * loopFrames + (relativeBar - 1) * framesPerBar;
          if (start + framesPerBar <= s.frames + tol) out.push(base + local);
        }
        base += count;
      });
      return out;
    },
    /** total passes a layer holds, partial ones included */
    passCount: function (sessions, framesPerBar, barCount) {
      var loopFrames = framesPerBar * barCount;
      return sessions.reduce(function (n, s) {
        return n + Math.ceil(s.frames / loopFrames);
      }, 0);
    }
  };

  /* ----------------------------------------------------------- utilities -- */
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function fmtTime(sec) {
    return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  }
  function fmtSize(mb) {
    return mb >= 1000 ? (mb / 1000).toFixed(1) + ' GB' : mb + ' MB';
  }

  /* ------------------------------------------------------- volume control -- */
  /* Level and mute in ONE control. Three arcs, all filling together with the
     level, each growing from its centre outward. No track behind them: the icon
     shows the level itself rather than the level against a ceiling. There is
     deliberately no numeric readout — the arcs are the readout. */
  var ARC_RADII = [3.5, 6.75, 10];

  function arcPath(r) {
    var c = Math.cos(50 * Math.PI / 180), s = Math.sin(50 * Math.PI / 180);
    var x = (9 + c * r).toFixed(2);
    return 'M ' + x + ' ' + (12 - s * r).toFixed(2) +
           ' A ' + r + ' ' + r + ' 0 0 1 ' + x + ' ' + (12 + s * r).toFixed(2);
  }

  function VolumeControl(opts) {
    var getLevel = opts.level, isMuted = opts.muted, onToggle = opts.onToggle;
    var btn = el('button', 'lr-volume' + (opts.large ? ' lr-volume--lg' : ''));
    btn.setAttribute('aria-label', 'volume and mute');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24">' +
        '<path class="lr-vol-body" d="M2 9 h3 l4 -3.5 v13 l-4 -3.5 h-3 z"/>' +
        ARC_RADII.map(function (r) {
          return '<path class="lr-vol-arc" d="' + arcPath(r) + '" pathLength="1"/>';
        }).join('') +
        '<line class="lr-vol-slash" x1="3" y1="21" x2="19" y2="4" pathLength="1"/>' +
      '</svg>';

    var arcs = [].slice.call(btn.querySelectorAll('.lr-vol-arc'));
    btn.update = function () {
      var f = clamp01(getLevel() / 100);
      arcs.forEach(function (a) {
        /* pathLength is normalised to 1, so a dash of length f starting at
           0.5 - f/2 sits symmetrically about the arc's midpoint */
        a.setAttribute('stroke-dasharray', f.toFixed(4) + ' 1');
        a.setAttribute('stroke-dashoffset', (-(0.5 - f / 2)).toFixed(4));
      });
      btn.classList.toggle('is-muted', !!isMuted());
    };
    btn.addEventListener('click', function (e) {
      e.stopPropagation();          // never also expands the row
      if (onToggle) onToggle();
      btn.update();
    });
    btn.update();
    return btn;
  }

  /* --------------------------------------------------------- progress bar -- */
  function ProgressBar(opts) {
    opts = opts || {};
    var bar = el('div', 'lr-progress');
    var fill = el('div', 'lr-progress__fill');
    bar.appendChild(fill);
    if (opts.ticks) {
      var t = el('div', 'lr-progress__ticks');
      for (var i = 0; i < opts.ticks; i++) t.appendChild(el('i'));
      bar.appendChild(t);
    }
    bar.set = function (fraction) {
      fill.style.width = (clamp01(fraction) * 100).toFixed(2) + '%';
    };
    if (opts.onSeek) {
      bar.addEventListener('click', function (e) {
        var r = bar.getBoundingClientRect();
        opts.onSeek(clamp01((e.clientX - r.left) / r.width));
      });
    }
    return bar;
  }

  /* ------------------------------------------------------------ play button */
  function PlayButton(onToggle) {
    var b = el('button', 'lr-play');
    b.innerHTML =
      '<svg class="lr-ico-play"  viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>' +
      '<svg class="lr-ico-pause" viewBox="0 0 24 24"><path d="M7 4h4v16H7zM13 4h4v16h-4z"/></svg>';
    b.setPlaying = function (on) { b.classList.toggle('is-playing', !!on); };
    b.addEventListener('click', function (e) { e.stopPropagation(); onToggle(); });
    return b;
  }

  /* ---------------------------------------------------------- record dot --- */
  /* Three states: unarmed -> armed -> recording. Tapping cycles forward;
     holding while armed cancels, because arming is a commitment the user must
     be able to back out of without capturing a pass they don't want. */
  function RecordDot(opts) {
    var dot = el('button', 'lr-rec');
    dot.setAttribute('aria-label', 'record');
    var holdTimer = null, cancelled = false;

    dot.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      cancelled = false;
      if (opts.blocked && opts.blocked()) return;
      if (opts.state() !== 'armed') return;
      holdTimer = setTimeout(function () {
        cancelled = true;
        opts.set('unarmed');
      }, 500);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
      dot.addEventListener(ev, function () { clearTimeout(holdTimer); holdTimer = null; });
    });
    dot.addEventListener('click', function (e) {
      e.stopPropagation();
      if (cancelled) { cancelled = false; return; }
      if (opts.blocked && opts.blocked()) return;
      var s = opts.state();
      opts.set(s === 'unarmed' ? 'armed' : s === 'armed' ? 'recording' : 'unarmed');
    });
    return dot;
  }

  /* -------------------------------------------------------------- waveform -- */
  /* One renderer for all three screens. Lines carry their own base height and
     base colour; a render pass writes exactly one transform and one colour per
     line, composing whatever activations the caller supplies. */
  function Waveform(opts) {
    var node = el('div', 'lr-wave' + (opts.variant ? ' lr-wave--' + opts.variant : ''));
    var lines = [];

    /** build (or rebuild) the lines. `spec(i, t)` returns { height, rgb } */
    node.build = function (count, spec) {
      node.innerHTML = '';
      lines = [];
      for (var i = 0; i < count; i++) {
        var t = count > 1 ? i / (count - 1) : 0;
        var s = spec(i, t);
        var line = el('div', 'lr-wave__line');
        line.style.height = s.height + 'px';
        line.style.color = 'rgb(' + s.rgb + ')';
        line._h = s.height;
        line._rgb = s.rgb;
        node.appendChild(line);
        lines.push(line);
      }
      return lines;
    };
    node.lines = function () { return lines; };

    /* Draw one line.
         passed   distance beyond the playhead, or <0 for not yet reached
         scale    extra multiplicative scale (swipe contraction, etc.)
         spent    rgb target for played material
         floorPx  minimum rendered height — one line width, below which a
                  capsule cannot draw its caps */
    node.paint = function (line, passed, scale, spent, floorPx) {
      var play = motion.playScale(clamp01(passed));
      var raw = line._h * play * (scale == null ? 1 : scale);
      var min = floorPx || 2;
      var h = Math.max(min, motion.snapEven(raw, min));
      line.style.transform = 'scaleY(' + (h / line._h).toFixed(4) + ')';

      var ct = clamp01(passed / motion.COLOR_FEATHER);
      line.style.color = ct === 0 ? 'rgb(' + line._rgb + ')'
                                  : ramp.toSpent(line._rgb, ct, spent);
    };
    return node;
  }

  /* ------------------------------------------------------------- transport -- */
  /* Progress indexes on the EDITED timeline. The played set must be computed in
     ONE place — every bug in this area came from a render pass and a release
     path disagreeing about what had played. */
  function Transport(opts) {
    var t = {
      mode: 'idle',        // idle | bar | loop
      progress: 0,
      origin: 0,           // slot index playback started from
      wrapped: false,      // playhead has passed the end and is heading back
      slots: opts.slots,
      seconds: opts.seconds,
      onCycle: opts.onCycle || function () {},
      onBarEnd: opts.onBarEnd || function () {}
    };

    t.playBar = function (slot) {
      t.mode = 'bar'; t.origin = slot; t.wrapped = false;
      t.progress = slot / t.slots;
    };
    t.playLoopFrom = function (slot) {
      t.mode = 'loop'; t.origin = slot; t.wrapped = false;
      t.progress = slot / t.slots;
    };
    t.escalate = function () { t.mode = 'loop'; };
    t.stop = function () { t.mode = 'idle'; t.wrapped = false; t.progress = 0; };

    /** has the playhead reached this slot in the current cycle? */
    t.isPlayed = function (slot) {
      if (t.mode === 'idle') return false;
      var head = t.progress * t.slots;
      if (t.wrapped && slot >= t.origin) return true;   // played before the wrap
      var gate = t.wrapped ? 0 : t.origin;
      return slot >= gate && head > slot;
    };

    /** how far past the playhead a line is, or -1 if not yet reached */
    t.passedAt = function (lineIndex, linesPerSlot) {
      if (t.mode === 'idle') return -1;
      var head = t.progress * t.slots * linesPerSlot;
      var originLine = t.origin * linesPerSlot;
      if (t.wrapped && lineIndex >= originLine) return motion.COLOR_FEATHER;
      if (lineIndex >= (t.wrapped ? 0 : originLine)) return head - lineIndex;
      return -1;
    };

    t.tick = function (dt) {
      if (t.mode === 'idle') return;
      t.progress += dt / 1000 / t.seconds;

      if (t.mode === 'bar') {
        var start = t.origin / t.slots, end = (t.origin + 1) / t.slots;
        if (t.progress >= end) { t.progress = start; t.onBarEnd(t.origin); }
        return;
      }
      /* A cycle is origin -> end -> start -> back to origin. Releasing at the
         END OF THE ARRANGEMENT would fire mid-cycle whenever playback began
         somewhere other than slot 0, which reads as a flash. */
      if (t.progress >= 1) { t.progress -= 1; t.wrapped = true; }
      if (t.wrapped && t.progress >= t.origin / t.slots) {
        t.wrapped = false;
        t.onCycle();
      }
    };
    return t;
  }

  /* ------------------------------------------------------------ frame loop -- */
  function loop(fn) {
    var last = performance.now();
    (function step(now) {
      var dt = Math.min(now - last, 50);   // clamp after a backgrounded tab
      last = now;
      fn(dt);
      requestAnimationFrame(step);
    })(last);
  }

  global.LR = {
    clamp: clamp, clamp01: clamp01,
    ramp: ramp, motion: motion, sizing: sizing, timing: timing,
    el: el, fmtTime: fmtTime, fmtSize: fmtSize,
    VolumeControl: VolumeControl, ProgressBar: ProgressBar, PlayButton: PlayButton,
    RecordDot: RecordDot, Waveform: Waveform, Transport: Transport, loop: loop
  };
})(window);
