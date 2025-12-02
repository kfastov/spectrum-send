// AudioWorkletProcessor: BPSK demod with Costas PLL, AGC, matched filter, fixed-rate sampler.
// Emits hard bits only after preamble correlation; sync/FEC parsing is done on the main thread.

class BpskDemodProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Defaults match transmitter
    this.fc = 18_000;
    this.symbolRate = 500;
    this.preambleSymbols = 80;
    this.lockThreshold = 0.6; // normalized corr for 1010... window
    this.holdoffSymbols = 6;  // skip symbols after lock to let PLL settle

    this.resetState();
    this.buildFilters();

    this.port.onmessage = (ev) => {
      const data = ev.data;
      if (!data) return;
      if (data.type === 'reset') {
        this.resetState();
      } else if (data.type === 'config') {
        this.applyConfig(data);
      }
    };
  }

  applyConfig(cfg) {
    if (typeof cfg.carrierHz === 'number') this.fc = cfg.carrierHz;
    if (typeof cfg.symbolRate === 'number' && cfg.symbolRate > 0) this.symbolRate = cfg.symbolRate;
    if (typeof cfg.preambleSymbols === 'number' && cfg.preambleSymbols > 8) this.preambleSymbols = Math.floor(cfg.preambleSymbols);
    if (typeof cfg.lockThreshold === 'number') this.lockThreshold = cfg.lockThreshold;
    if (typeof cfg.holdoffSymbols === 'number' && cfg.holdoffSymbols >= 0) this.holdoffSymbols = Math.floor(cfg.holdoffSymbols);
    this.buildFilters();
    this.resetState();
  }

  buildFilters() {
    this.spsFloat = sampleRate / this.symbolRate;
    this.timeStep = this.spsFloat;
    this.ncoStep = (2 * Math.PI * this.fc) / sampleRate;

    // Low-pass for I/Q after mixing. Cutoff ~ 2x symbol rate, min 300 Hz.
    const cutoff = Math.max(300, this.symbolRate * 2.2);
    this.lpfAlpha = this.calcAlpha(cutoff);

    // Raised-cosine-ish matched filter (~4 symbols long).
    const tapsLen = Math.max(12, Math.round(this.spsFloat * 4));
    this.mfTaps = new Float32Array(tapsLen);
    for (let i = 0; i < tapsLen; i++) {
      this.mfTaps[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (tapsLen - 1));
    }
    let sum = 0;
    for (let i = 0; i < tapsLen; i++) sum += this.mfTaps[i];
    for (let i = 0; i < tapsLen; i++) this.mfTaps[i] /= sum || 1;

    this.mfBuf = new Float32Array(tapsLen);
    this.mfPos = 0;

    this.altSeq = new Array(this.preambleSymbols).fill(0).map((_, i) => (i % 2 === 0 ? 1 : -1));
  }

  resetState() {
    this.phase = 0;
    this.freqCorr = 0;
    this.lpI = 0;
    this.lpQ = 0;
    this.env = 1e-3;
    this.agcAlpha = this.calcAlpha(20); // slow envelope tracker
    this.pllAlpha = 2e-4;
    this.pllBeta = 5e-7;
    this.timeAcc = 0;
    this.outBits = [];
    this.signBuf = [];
    this.locked = false;
    this.holdoff = 0;
    this.mfPos = 0;
    this.processedSamples = 0;
    this.delayReport = 0;
    this.startTime = currentTime;
  }

  calcAlpha(cutoff) {
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * cutoff);
    return dt / (rc + dt);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const chan = input[0];
    const tapsLen = this.mfTaps.length;

    for (let n = 0; n < chan.length; n++) {
      // 1) Mix to baseband with NCO + Costas PLL
      this.phase += this.ncoStep + this.freqCorr;
      if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
      else if (this.phase < 0) this.phase += Math.PI * 2;

      const cos = Math.cos(this.phase);
      const sin = Math.sin(this.phase);
      const iRaw = chan[n] * cos;
      const qRaw = chan[n] * -sin;

      // 2) Low-pass I/Q
      this.lpI += this.lpfAlpha * (iRaw - this.lpI);
      this.lpQ += this.lpfAlpha * (qRaw - this.lpQ);

      // 3) AGC
      const mag = Math.hypot(this.lpI, this.lpQ);
      this.env += this.agcAlpha * (mag - this.env);
      const gain = 1 / Math.max(1e-4, this.env);
      const iN = this.lpI * gain;
      const qN = this.lpQ * gain;

      // 4) PLL update (Costas)
      const pllErr = iN * qN;
      this.freqCorr += this.pllBeta * pllErr;
      if (this.freqCorr > 0.1) this.freqCorr = 0.1;
      else if (this.freqCorr < -0.1) this.freqCorr = -0.1;
      this.phase += this.pllAlpha * pllErr;
      if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
      else if (this.phase < 0) this.phase += Math.PI * 2;

      // 5) Matched filter (FIR)
      this.mfBuf[this.mfPos++] = iN;
      if (this.mfPos >= tapsLen) this.mfPos = 0;
      const y = this.applyMatchedFilter();

      // 6) Fixed-rate sampling
      this.timeAcc += 1;
      while (this.timeAcc >= this.timeStep) {
        this.timeAcc -= this.timeStep;
        this.handleSymbol(y);
      }
      this.processedSamples += 1;
    }

    if (this.outBits.length) {
      this.port.postMessage({ type: 'bits', bits: this.outBits });
      this.outBits = [];
    }
    if (this.delayReport-- <= 0) {
      this.delayReport = 1024;
      const procTime = this.processedSamples / sampleRate;
      const elapsed = currentTime - this.startTime;
      const delay = elapsed - procTime;
      this.port.postMessage({ type: 'delay', sec: delay });
    }
    return true;
  }

  applyMatchedFilter() {
    let acc = 0;
    let idx = this.mfPos - 1;
    if (idx < 0) idx += this.mfTaps.length;
    for (let k = 0; k < this.mfTaps.length; k++) {
      const j = idx - k;
      const jj = j < 0 ? j + this.mfTaps.length : j;
      acc += this.mfBuf[jj] * this.mfTaps[k];
    }
    return acc;
  }

  handleSymbol(sym) {
    const bit = sym >= 0 ? 0 : 1;
    const sign = bit === 0 ? 1 : -1;

    // Preamble correlation on symbol decisions
    this.signBuf.push(sign);
    if (this.signBuf.length > this.preambleSymbols) {
      this.signBuf.shift();
    }
    if (!this.locked && this.signBuf.length === this.preambleSymbols) {
      let corr = 0;
      let energy = 0;
      for (let i = 0; i < this.preambleSymbols; i++) {
        corr += this.signBuf[i] * this.altSeq[i];
        energy += Math.abs(this.signBuf[i]);
      }
      const normCorr = energy > 0 ? corr / energy : 0;
      if (normCorr > this.lockThreshold) {
        this.locked = true;
        this.holdoff = this.holdoffSymbols;
        this.outBits.length = 0; // drop preamble decisions
        this.port.postMessage({ type: 'locked', score: normCorr });
        return;
      }
    }

    if (!this.locked) return;
    if (this.holdoff > 0) {
      this.holdoff--;
      return;
    }

    this.outBits.push(bit);
  }
}

registerProcessor('bpsk-demod', BpskDemodProcessor);
