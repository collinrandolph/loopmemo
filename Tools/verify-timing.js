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

// ---- the tolerance question ----
// Swift defaults tolerance to 2000 frames. The reference defaults to 0.
// Spec §1.4 says "a few milliseconds".
console.log('\n-- tolerance: what does 2000 frames actually mean? --');
console.log(`  2000 frames @ 44100 Hz = ${(2000 / 44100 * 1000).toFixed(1)} ms`);
console.log(`  2000 frames @ 48000 Hz = ${(2000 / 48000 * 1000).toFixed(1)} ms`);
console.log(`  "a few ms" (4 ms)      = ${Math.round(0.004 * 44100)} frames @ 44.1k`);

// A pass that stopped 40 ms short of completing bar 16.
const short = 1764 ; // 40 ms at 44.1k
const stoppedShort = [{ frames: 2 * loopFrames - short }];
check('40ms-short pass, tolerance 0 (bar 16 absent)',
      T.passesForBar(stoppedShort, 16, fpb, BARS, 0), [1]);
check('40ms-short pass, Swift tolerance 2000 (bar 16 wrongly present)',
      T.passesForBar(stoppedShort, 16, fpb, BARS, 2000), [1, 2]);

console.log(`\n${fail === 0 ? 'all checks passed' : fail + ' FAILED'}`);
