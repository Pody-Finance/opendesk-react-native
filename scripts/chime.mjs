// Renders assets/chime.wav: the web widget's reply chime (two sine notes, 880 Hz then
// 1318.5 Hz 110 ms later, each a 12 ms attack and an exponential fade over 420 ms). The web
// widget plays it through WebAudio at a low gain; a phone plays the file at media volume, so
// it is normalized to -6 dBFS instead. Run with `node scripts/chime.mjs`.
import { writeFileSync } from 'node:fs';

const RATE = 22050;
const NOTES = [
  [880, 0],
  [1318.5, 0.11],
];
const ATTACK = 0.012;
const FADE_END = 0.42;
const NOTE_END = 0.45;
const PEAK = 0.5;

/** The gain each WebAudio ramp in the widget gives a note at `t` seconds after it starts. */
function envelope(t) {
  if (t < 0 || t >= NOTE_END) {
    return 0;
  }
  if (t < ATTACK) {
    return 0.5 * (t / ATTACK);
  }
  if (t < FADE_END) {
    return 0.5 * Math.pow(1e-4 / 0.5, (t - ATTACK) / (FADE_END - ATTACK));
  }

  return 1e-4;
}

const length = Math.ceil((NOTES[NOTES.length - 1][1] + NOTE_END) * RATE);
const samples = new Float64Array(length);
for (let i = 0; i < length; i++) {
  const time = i / RATE;
  samples[i] = NOTES.reduce((sum, [frequency, start]) => sum + envelope(time - start) * Math.sin(2 * Math.PI * frequency * (time - start)), 0);
}

const scale = PEAK / samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const data = Buffer.alloc(length * 2);
samples.forEach((value, i) => data.writeInt16LE(Math.round(value * scale * 32767), i * 2));

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

writeFileSync(new URL('../assets/chime.wav', import.meta.url), Buffer.concat([header, data]));
