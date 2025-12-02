// Simple BPSK demod: mixer + LPF + symbol averaging + preamble correlation.
// No PLL/timing recovery; relies on nominal baud and phase stability.

class BpskDemodProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fc = 18_000;
    this.symbolRate = 500;
    this.preambleSymbols = 80;
    this.lockThreshold = 0.5;
    this.phase = 0;
    this.phaseInc = (2 * Math.PI * this.fc) / sampleRate;
    this.lpState = 0;
    this.lpAlpha = this.calcAlpha(1000); // ~1 kHz LPF
    this.buffer = [];
    this.cursor = 0;
    this.locked = false;
    this.altSeq = this.buildAltSeq(this.preambleSymbols);
    this.processedSamples = 0;
    this.delayReport = 0;
    this.startTime = currentTime;

    this.port.onmessage = (ev) => {
      const data = ev.data;
      if (!data) return;
      if (data.type === 'reset') {
        this.reset();
      } else if (data.type === 'config') {
        this.applyConfig(data);
      }
    };
  }

  calcAlpha(cutoff) {
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * cutoff);
    return dt / (rc + dt);
  }

  buildAltSeq(len) {
    return new Array(len).fill(0).map((_, i) => (i % 2 === 0 ? 1 : -1));
  }

  applyConfig(cfg) {
    if (typeof cfg.carrierHz === 'number') this.fc = cfg.carrierHz;
    if (typeof cfg.symbolRate === 'number' && cfg.symbolRate > 0) this.symbolRate = cfg.symbolRate;
    if (typeof cfg.preambleSymbols === 'number' && cfg.preambleSymbols > 8) this.preambleSymbols = Math.floor(cfg.preambleSymbols);
    if (typeof cfg.lockThreshold === 'number') this.lockThreshold = cfg.lockThreshold;
    this.phaseInc = (2 * Math.PI * this.fc) / sampleRate;
    this.sps = Math.max(1, Math.round(sampleRate / this.symbolRate));
    this.altSeq = this.buildAltSeq(this.preambleSymbols);
    this.reset();
  }

  reset() {
    this.buffer = [];
    this.cursor = 0;
    this.locked = false;
    this.phase = 0;
    this.lpState = 0;
    this.processedSamples = 0;
    this.delayReport = 0;
    this.startTime = currentTime;
  }

  mix(sample) {
    this.phase += this.phaseInc;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
    const mixed = sample * Math.cos(this.phase);
    this.lpState += this.lpAlpha * (mixed - this.lpState);
    return this.lpState;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const chan = input[0];
    if (!this.sps) this.sps = Math.max(1, Math.round(sampleRate / this.symbolRate));

    for (let i = 0; i < chan.length; i++) {
      const bb = this.mix(chan[i]);
      this.buffer.push(bb);
      this.processedSamples++;
    }
    this.tryDemod();
    this.trimBuffer();

    if (this.delayReport-- <= 0) {
      this.delayReport = 1024;
      const procTime = this.processedSamples / sampleRate;
      const elapsed = currentTime - this.startTime;
      this.port.postMessage({ type: 'delay', sec: elapsed - procTime });
    }
    return true;
  }

  tryDemod() {
    if (!this.locked) {
      this.detectPreamble();
    }
    if (this.locked) {
      this.emitBits();
    }
  }

  detectPreamble() {
    const needSamples = this.preambleSymbols * this.sps;
    if (this.buffer.length < needSamples) return;

    let bestScore = -1;
    let bestOffset = 0;

    for (let offset = 0; offset < this.sps; offset++) {
      let score = 0;
      let energy = 0;
      for (let sym = 0; sym < this.preambleSymbols; sym++) {
        const start = offset + sym * this.sps;
        if (start + this.sps > this.buffer.length) break;
        let sum = 0;
        for (let k = 0; k < this.sps; k++) {
          sum += this.buffer[start + k];
        }
        const sgn = sum >= 0 ? 1 : -1;
        score += sgn * this.altSeq[sym];
        energy += 1;
      }
      const norm = energy > 0 ? score / energy : 0;
      if (norm > bestScore) {
        bestScore = norm;
        bestOffset = offset;
      }
    }

    if (bestScore > this.lockThreshold) {
      this.locked = true;
      this.cursor = bestOffset + this.preambleSymbols * this.sps;
      this.port.postMessage({ type: 'locked', score: bestScore });
    }
  }

  emitBits() {
    const out = [];
    while (this.cursor + this.sps <= this.buffer.length) {
      let sum = 0;
      for (let i = 0; i < this.sps; i++) {
        sum += this.buffer[this.cursor + i];
      }
      out.push(sum >= 0 ? 0 : 1);
      this.cursor += this.sps;
      if (out.length >= 4096) break;
    }
    if (out.length) {
      this.port.postMessage({ type: 'bits', bits: out });
    }
  }

  trimBuffer() {
    const keep = this.sps * 500; // keep limited history
    if (this.buffer.length > keep) {
      const drop = this.buffer.length - keep;
      this.buffer = this.buffer.slice(drop);
      this.cursor = Math.max(0, this.cursor - drop);
    }
  }
}

registerProcessor('bpsk-demod', BpskDemodProcessor);
