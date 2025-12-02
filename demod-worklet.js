// AudioWorkletProcessor for simple BPSK demodulation at 18 kHz.
// Detects alternating preamble, locks symbol timing, then emits hard-decision bits.

class BpskDemodProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fc = 18_000;
    this.symbolRate = 500;
    this.sps = Math.max(1, Math.round(sampleRate / this.symbolRate));
    this.preambleSymbols = 80;
    this.phase = 0;
    this.phaseInc = (2 * Math.PI * this.fc) / sampleRate;
    this.lpState = 0;
    this.lpAlpha = this.calcAlpha(1000); // updated by config
    this.env = 1e-3;
    this.agcAlpha = this.calcAlpha(20); // slow envelope tracker
    this.lockThreshold = 0.3;
    this.lpfFactor = 2.0;
    this.buffer = [];
    this.cursor = 0;
    this.locked = false;
    this.altSeq = new Array(this.preambleSymbols)
      .fill(0)
      .map((_, i) => (i % 2 === 0 ? 1 : -1));

    this.port.onmessage = (ev) => {
      if (!ev.data) return;
      if (ev.data.type === 'reset') {
        this.reset();
      } else if (ev.data.type === 'config') {
        this.applyConfig(ev.data);
      }
    };
  }

  reset() {
    this.buffer = [];
    this.cursor = 0;
    this.locked = false;
    this.phase = 0;
    this.lpState = 0;
    this.env = 1e-3;
  }

  applyConfig(cfg) {
    if (typeof cfg.carrierHz === 'number') {
      this.fc = cfg.carrierHz;
    }
    if (typeof cfg.symbolRate === 'number' && cfg.symbolRate > 0) {
      this.symbolRate = cfg.symbolRate;
    }
    if (typeof cfg.lpfFactor === 'number' && cfg.lpfFactor > 0) {
      this.lpfFactor = cfg.lpfFactor;
    }
    if (typeof cfg.lockThreshold === 'number') {
      this.lockThreshold = cfg.lockThreshold;
    }
    this.sps = Math.max(1, Math.round(sampleRate / this.symbolRate));
    this.phaseInc = (2 * Math.PI * this.fc) / sampleRate;
    const cutoff = Math.max(150, this.symbolRate * this.lpfFactor);
    this.lpAlpha = this.calcAlpha(cutoff);
    this.altSeq = new Array(this.preambleSymbols)
      .fill(0)
      .map((_, i) => (i % 2 === 0 ? 1 : -1));
    this.reset();
  }

  calcAlpha(cutoff) {
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * cutoff);
    return dt / (rc + dt);
  }

  mix(sample) {
    this.phase += this.phaseInc;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
    const mixed = sample * Math.cos(this.phase);
    this.lpState += this.lpAlpha * (mixed - this.lpState);
    const envTarget = Math.abs(this.lpState);
    this.env += this.agcAlpha * (envTarget - this.env);
    const norm = this.lpState / Math.max(1e-4, this.env);
    return norm;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }
    const chan = input[0];
    for (let i = 0; i < chan.length; i++) {
      const bb = this.mix(chan[i]);
      this.buffer.push(bb);
    }
    this.tryDemod();
    this.trimBuffer();
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
      let count = 0;
      for (let sym = 0; sym < this.preambleSymbols; sym++) {
        const start = offset + sym * this.sps;
        if (start + this.sps > this.buffer.length) break;
        let sum = 0;
        for (let k = 0; k < this.sps; k++) {
          sum += this.buffer[start + k];
        }
        const sgn = sum >= 0 ? 1 : -1;
        score += sgn * this.altSeq[sym];
        count++;
      }
      const norm = score / (count || 1);
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
    const keep = this.sps * 500; // keep a few symbols worth of history
    if (this.buffer.length > keep) {
      const drop = this.buffer.length - keep;
      this.buffer = this.buffer.slice(drop);
      this.cursor = Math.max(0, this.cursor - drop);
    }
  }
}

registerProcessor('bpsk-demod', BpskDemodProcessor);
