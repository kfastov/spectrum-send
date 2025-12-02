// AudioWorkletProcessor for BPSK with Costas loop, AGC and matched filter.
// Emits hard-decision bits continuously; sync/FEC handled on main thread.

class BpskDemodProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fc = 18_000;
    this.symbolRate = 500;
    this.lockThreshold = 0.3;
    this.lpfFactor = 2.0;
    this.preambleSymbols = 80;
    this.holdoffSymbols = 40; // symbols to skip after lock so PLL stabilizes

    this.spsFloat = sampleRate / this.symbolRate;
    this.sps = Math.max(1, Math.round(this.spsFloat));
    this.phase = 0;
    this.ncoStep = (2 * Math.PI * this.fc) / sampleRate;
    this.freqCorr = 0;
    this.lpI = 0;
    this.lpQ = 0;
    this.env = 1e-3;
    this.lpAlpha = this.calcAlpha(1000);
    this.agcAlpha = this.calcAlpha(20);
    this.pllAlpha = 2e-4;
    this.pllBeta = 5e-7;

    this.mfTaps = this.buildRaisedCosine(this.spsFloat);
    this.mfBuf = new Float32Array(this.mfTaps.length);
    this.mfPos = 0;
    this.timeAcc = 0;
    this.outBits = [];

    this.signBuf = [];
    this.lockedFlag = false;
    this.holdoff = 0;
    this.pllReport = 0;
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

  calcAlpha(cutoff) {
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * cutoff);
    return dt / (rc + dt);
  }

  buildRaisedCosine(spsFloat) {
    const len = Math.max(8, Math.round(spsFloat * 1.5));
    const taps = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      taps[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    }
    let sum = 0;
    for (let i = 0; i < len; i++) sum += taps[i];
    for (let i = 0; i < len; i++) taps[i] = taps[i] / (sum || 1);
    return taps;
  }

  reset() {
    this.phase = 0;
    this.freqCorr = 0;
    this.lpI = 0;
    this.lpQ = 0;
    this.env = 1e-3;
    this.mfBuf.fill(0);
    this.mfPos = 0;
    this.timeAcc = 0;
    this.outBits.length = 0;
    this.signBuf = [];
    this.lockedFlag = false;
    this.holdoff = 0;
    this.pllReport = 0;
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
    if (typeof cfg.holdoffSymbols === 'number' && cfg.holdoffSymbols >= 0) {
      this.holdoffSymbols = Math.floor(cfg.holdoffSymbols);
    }
    this.spsFloat = sampleRate / this.symbolRate;
    this.sps = Math.max(1, Math.round(this.spsFloat));
    this.ncoStep = (2 * Math.PI * this.fc) / sampleRate;
    const cutoff = Math.max(150, this.symbolRate * this.lpfFactor);
    this.lpAlpha = this.calcAlpha(cutoff);
    this.mfTaps = this.buildRaisedCosine(this.spsFloat);
    this.mfBuf = new Float32Array(this.mfTaps.length);
    this.reset();
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const chan = input[0];
    const tapsLen = this.mfTaps.length;

    for (let i = 0; i < chan.length; i++) {
      const base = this.mixAndLoop(chan[i]);
      this.mfBuf[this.mfPos++] = base;
      if (this.mfPos >= tapsLen) this.mfPos = 0;

      this.timeAcc += 1;
      while (this.timeAcc >= this.spsFloat) {
        this.timeAcc -= this.spsFloat;
        const y = this.applyMatchedFilter();
        this.handleSymbol(y);
      }
    }

    if (this.outBits.length) {
      this.port.postMessage({ type: 'bits', bits: this.outBits });
      this.outBits = [];
    }
    return true;
  }

  mixAndLoop(sample) {
    // NCO phase advance with current correction
    this.phase += this.ncoStep + this.freqCorr;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
    else if (this.phase < 0) this.phase += Math.PI * 2;

    const cos = Math.cos(this.phase);
    const sin = Math.sin(this.phase);
    const iRaw = sample * cos;
    const qRaw = sample * -sin;

    // One-pole low-pass on I/Q
    this.lpI += this.lpAlpha * (iRaw - this.lpI);
    this.lpQ += this.lpAlpha * (qRaw - this.lpQ);

    // AGC
    const mag = Math.hypot(this.lpI, this.lpQ);
    this.env += this.agcAlpha * (mag - this.env);
    const gain = 1 / Math.max(1e-4, this.env);
    const iN = this.lpI * gain;
    const qN = this.lpQ * gain;

    // Costas loop for phase/freq correction
    const err = iN * qN;
    this.freqCorr += this.pllBeta * err;
    if (this.freqCorr > 0.1) this.freqCorr = 0.1;
    else if (this.freqCorr < -0.1) this.freqCorr = -0.1;
    this.phase += this.pllAlpha * err;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
    else if (this.phase < 0) this.phase += Math.PI * 2;

    return iN;
  }

  applyMatchedFilter() {
    const taps = this.mfTaps;
    const len = taps.length;
    let acc = 0;
    let idx = this.mfPos - 1;
    if (idx < 0) idx += len;
    for (let k = 0; k < len; k++) {
      const j = idx - k;
      const jj = j < 0 ? j + len : j;
      acc += this.mfBuf[jj] * taps[k];
    }
    return acc;
  }

  handleSymbol(val) {
    const bit = val >= 0 ? 0 : 1;

    // Track preamble correlation for UI (no gating)
    const sign = bit === 0 ? 1 : -1;
    this.signBuf.push(sign);
    if (this.signBuf.length > this.preambleSymbols) {
      this.signBuf.shift();
    }
    if (this.signBuf.length === this.preambleSymbols) {
      let corr = 0;
      for (let i = 0; i < this.preambleSymbols; i++) {
        corr += this.signBuf[i] * this.altSeq[i];
      }
      corr /= this.preambleSymbols;
      if (corr > this.lockThreshold && !this.lockedFlag) {
        this.lockedFlag = true;
        this.holdoff = this.holdoffSymbols;
        this.pllReport = 400; // symbols before next PLL report
        this.port.postMessage({ type: 'locked', score: corr, dfHz: this.freqCorr * sampleRate / (2 * Math.PI) });
      } else if (corr < this.lockThreshold * 0.5) {
        this.lockedFlag = false;
      }
    }

    if (this.lockedFlag && this.pllReport-- <= 0) {
      this.pllReport = 400;
      this.port.postMessage({ type: 'pll', dfHz: this.freqCorr * sampleRate / (2 * Math.PI) });
    }

    if (this.lockedFlag && this.holdoff > 0) {
      this.holdoff--;
      return;
    }

    this.outBits.push(bit);
  }
}

registerProcessor('bpsk-demod', BpskDemodProcessor);
