/**
 * toon-pitch - a pitch shifter for the DM's voice, as an AudioWorklet.
 *
 * Original code, written for Toon Anvil (MIT with the rest of the source;
 * nothing vendored). The idea is the old delay-line trick: a delay that
 * GROWS at r samples per sample plays its contents back at pitch ratio
 * (1 - r). So a read head sweeping the delay up from 0 to N plays the voice
 * lower, sweeping it down plays it higher, and ratio 1 (r = 0) is a plain
 * delay. One head alone would click every time its delay wrapped, so there
 * are two, half a cycle apart, each under a Hann window that is zero at the
 * wrap - and the two windows sum to exactly one, so nothing is lost.
 *
 * Parameters (k-rate, both AudioParams):
 *   ratio  0.25..4   pitch ratio, 2 ** (semitones / 12); 1 is untouched
 *   grain  0.02..0.06 seconds; the delay the heads sweep. Longer grains
 *                   sound smoother on big shifts and add more latency.
 *
 * Latency added: about grain / 2 plus one render quantum. Artifact: a
 * warble at |1 - ratio| / grain hertz on deep shifts, which is why the
 * presets pair an octave down with a long grain.
 *
 * A 'stop' message on the port lets the node be garbage collected.
 */

class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'grain', defaultValue: 0.04, minValue: 0.02, maxValue: 0.06, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.size = 8192;          // 170 ms at 48 kHz - well over the longest grain
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;                // write head
    this.phase = 0;            // 0..1, where head A is in its sweep
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }

  /** Read behind the write head at a fractional position, interpolated. */
  readAt(pos) {
    let p = pos;
    while (p < 0) p += this.size;
    const i0 = Math.floor(p) & this.mask;
    const i1 = (i0 + 1) & this.mask;
    const f = p - Math.floor(p);
    return this.buf[i0] * (1 - f) + this.buf[i1] * f;
  }

  process(inputs, outputs, params) {
    const x = inputs[0] && inputs[0][0];
    const outs = outputs[0] || [];
    if (!x) return this.alive;   // the microphone is not connected yet: silence, stay alive
    const ratio = params.ratio[0];
    const N = Math.max(32, Math.round(params.grain[0] * sampleRate));
    const step = (1 - ratio) / N;   // phase advance per sample; negative when shifting up
    for (let i = 0; i < x.length; i += 1) {
      this.buf[this.w] = x[i];
      const pA = this.phase;
      let pB = pA + 0.5;
      if (pB >= 1) pB -= 1;
      // Hann windows, half a cycle apart: gB is exactly 1 - gA.
      const gA = 0.5 - 0.5 * Math.cos(2 * Math.PI * pA);
      const y = this.readAt(this.w - pA * N) * gA + this.readAt(this.w - pB * N) * (1 - gA);
      for (let c = 0; c < outs.length; c += 1) outs[c][i] = y;
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      else if (this.phase < 0) this.phase += 1;
      this.w = (this.w + 1) & this.mask;
    }
    return this.alive;
  }
}

registerProcessor('toon-pitch', PitchShifter);
