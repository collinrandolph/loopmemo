// Run the spec's reference implementation (docs/kit/lr-kit.js, §1.4) and compare
// its output to what LoopRecorderCore's Timing / PassIndex assert.
import fs from 'node:fs';
import path from 'node:path';

const KIT = path.join(import.meta.dirname, '..', 'docs', 'kit', 'lr-kit.js');

global.window = {};
new Function(fs.readFileSync(KIT, 'utf8'))();
const T = global.window.LR.timing;

let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got ${a}  want ${e}`);
}

// ---- spec §1.4 worked example: 96 BPM, 16 bars, 44.1 kHz ----
const SR = 44100, BPM = 96, BARS = 16;
const fpb = T.framesPerBar(SR, BPM);
const loopFrames = fpb * BARS;

console.log(`framesPerBar = ${fpb}   loopFrames = ${loopFrames}`);
check('framesPerBar matches Swift test assertion', fpb, 110250);
check('loopSeconds', T.loopSeconds(BARS, BPM), 40);

// session 1 = 2 full passes + 8 bars; session 2 = 2 full passes
const sessions = [
  { frames: 2 * loopFrames + 8 * fpb },
  { frames: 2 * loopFrames },
];

console.log('\n-- spec table: bar 1-8 -> 1,2,3,4,5   bar 9-16 -> 1,2,-,4,5 --');
check('passesForBar(1)',  T.passesForBar(sessions, 1,  fpb, BARS), [1, 2, 3, 4, 5]);
check('passesForBar(8)',  T.passesForBar(sessions, 8,  fpb, BARS), [1, 2, 3, 4, 5]);
check('passesForBar(9)',  T.passesForBar(sessions, 9,  fpb, BARS), [1, 2, 4, 5]);
check('passesForBar(16)', T.passesForBar(sessions, 16, fpb, BARS), [1, 2, 4, 5]);
check('passCount total',  T.passCount(sessions, fpb, BARS), 5);

// ---- deliberate divergence: partial bars ----
// The kit implements §1.4's original barExists, which requires a WHOLE bar. We admit a bar
// the recording reached into at all, so a partial pass yields usable bars instead of
// discarding the user's last seconds of playing; regionFor clamps to the file, so nothing is
// padded. The two agree wherever a session ends on a bar boundary — which is every case in
// the spec's worked example above, so the checks there stay meaningful.
//
// These assert the KIT still behaves the old way. If one starts failing, the kit changed and
// the divergence needs re-deciding rather than silently disappearing.
console.log('\n-- divergence: the kit still requires a whole bar --');

const halfBar = [{ frames: 9 * fpb + fpb / 2 }]; // stopped halfway through bar 10
check('kit drops the half-recorded bar 10',
      T.passesForBar(halfBar, 10, fpb, BARS), []);
check('kit and we agree bar 9 is present',
      T.passesForBar(halfBar, 9, fpb, BARS), [1]);
check('kit and we agree bar 11 is absent',
      T.passesForBar(halfBar, 11, fpb, BARS), []);

// The old tolerance guarded the far edge of the bar. Ours guards the near edge, so this
// 40 ms-short bar is now kept (clamped) rather than lost.
const stoppedShort = [{ frames: 2 * loopFrames - 1764 }];
check('kit loses the 40ms-short bar 16 that we keep',
      T.passesForBar(stoppedShort, 16, fpb, BARS, 0), [1]);

console.log(`\n${fail === 0 ? 'all checks passed' : fail + ' FAILED'}`);
