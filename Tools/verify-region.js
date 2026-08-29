// Executable mirror of LoopRecorderCore's PassIndex.region() and steppingPass().
// Purpose: prove the session-relative frame math before committing to the Swift,
// since the Swift cannot be compiled on this machine.
//
// Spec §1.4 worked example: 96 BPM, 16 bars, 44.1 kHz.
//   session 0 = 2 full passes + 8 bars  -> passes 1, 2, 3 (3 partial)
//   session 1 = 2 full passes           -> passes 4, 5

const SR = 44100, BPM = 96, BARS = 16, BEATS = 4;
const fpb = Math.round(SR * 60 * BEATS / BPM);
const loopFrames = fpb * BARS;
const TOL = Math.round(SR * 0.004);           // 4 ms, per spec "a few milliseconds"

const sessions = [
  { frames: 2 * loopFrames + 8 * fpb },
  { frames: 2 * loopFrames },
];

const passCount = f => (f <= 0 ? 0 : Math.ceil(f / loopFrames));
const firstPass = (() => {
  let next = 1;
  return sessions.map(s => { const at = next; next += passCount(s.frames); return at; });
})();

function locate(pass) {
  for (let i = 0; i < sessions.length; i++) {
    const local = pass - firstPass[i];
    if (local >= 0 && local < passCount(sessions[i].frames)) return { i, localPass: local + 1 };
  }
  return null;
}

function barExists(localPass, r, frames, tol = TOL) {
  const start = (localPass - 1) * loopFrames + (r - 1) * fpb;
  return start + fpb <= frames + tol;
}

function region(pass, r) {
  const loc = locate(pass);
  if (!loc) return null;
  const frames = sessions[loc.i].frames;
  if (!barExists(loc.localPass, r, frames)) return null;
  const start = (loc.localPass - 1) * loopFrames + (r - 1) * fpb;
  const available = frames - start;
  if (available <= 0) return null;
  return { sessionIndex: loc.i, startFrame: start, frameCount: Math.min(fpb, available) };
}

function availablePasses(r) {
  const out = [];
  sessions.forEach((s, i) => {
    const n = passCount(s.frames);
    for (let local = 1; local <= n; local++)
      if (barExists(local, r, s.frames)) out.push(firstPass[i] + local - 1);
  });
  return out;
}

function steppingPass(pass, r, delta) {
  const ps = availablePasses(r);
  if (!ps.length) return null;
  const cur = ps.indexOf(pass);
  if (cur < 0) return ps.find(p => p > pass) ?? ps[ps.length - 1];
  const n = ps.length;
  return ps[(((cur + delta) % n) + n) % n];
}

let fail = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), e = JSON.stringify(want);
  if (a !== e) fail++;
  console.log(`${a === e ? 'PASS' : 'FAIL'}  ${label}\n        got ${a}  want ${e}`);
};

console.log(`fpb=${fpb} loopFrames=${loopFrames} tolerance=${TOL} frames (4 ms)`);
console.log(`firstPass per session = ${JSON.stringify(firstPass)}   (spec: 1 and 4)\n`);
check('firstPass', firstPass, [1, 4]);

console.log('-- THE BUG: pass 4 lives at frame 0 of session 1, not far into session 0 --');
check('region(P4, bar1)', region(4, 1), { sessionIndex: 1, startFrame: 0, frameCount: fpb });
const oldBuggyOffset = ((4 - 1) * BARS + 0) * fpb;     // what the old code computed
console.log(`        old code asked for frame ${oldBuggyOffset} of a ${sessions[1].frames}-frame file`);
console.log(`        -> ${oldBuggyOffset - sessions[1].frames} frames past EOF\n`);

console.log('-- partial pass 3 exists for early bars, not late ones --');
check('region(P3, bar1)  present', region(3, 1),
      { sessionIndex: 0, startFrame: 2 * loopFrames, frameCount: fpb });
check('region(P3, bar9)  absent (real gap)', region(3, 9), null);
check('region(P5, bar16) present', region(5, 16),
      { sessionIndex: 1, startFrame: loopFrames + 15 * fpb, frameCount: fpb });
check('region(P6, bar1)  absent (no such pass)', region(6, 1), null);

console.log('\n-- vertical swipe wraps through a NON-CONTIGUOUS set (spec 1.4) --');
check('availablePasses(bar 9)', availablePasses(9), [1, 2, 4, 5]);
check('bar9 P2 +1 skips the gap -> P4', steppingPass(2, 9, 1), 4);
check('bar9 P5 +1 wraps        -> P1', steppingPass(5, 9, 1), 1);
check('bar9 P1 -1 wraps back   -> P5', steppingPass(1, 9, -1), 5);
check('bar1 P2 +1 no gap       -> P3', steppingPass(2, 1, 1), 3);

console.log('\n-- clamp: a pass that stopped 100 frames (2.3 ms) short --');
const short = [{ frames: 2 * loopFrames - 100 }];
(() => {
  const s = short[0];
  const start = loopFrames + 15 * fpb;
  const admitted = start + fpb <= s.frames + TOL;
  const count = Math.min(fpb, s.frames - start);
  check('tolerance admits the final bar', admitted, true);
  check('but frameCount is clamped to what exists', count, fpb - 100);
  console.log(`        plays ${((fpb - count) / SR * 1000).toFixed(1)} ms short instead of reading past EOF`);
})();

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
