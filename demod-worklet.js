class BpskProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fc = 18000;
    this.baud = 500;
    this.fs = 0;

    this.phase = 0;
    this.freq = 0;
    this.alpha = 0.02;
    this.beta = 0.0005;

    this.i_lpf = 0;
    this.q_lpf = 0;
    this.lpf_alpha = 0.2;

    this.samplesPerSymbol = 0;
    this.sampleCounter = 0;

    this.lastBit = 0;

    this.agcGain = 1.0;
    this.agcTarget = 0.8;
    this.agcAlpha = 0.01;

    this.framesProcessed = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];

    if (this.fs === 0) {
      this.fs = sampleRate;
      this.samplesPerSymbol = this.fs / this.baud;
      this.ncoStepBase = (2 * Math.PI * this.fc) / this.fs;
    }

    const constPoints = [];
    let bitsOut = [];

    const freqLimit = (2 * Math.PI * 600) / this.fs;

    for (let i = 0; i < channel.length; i++) {
      let sample = channel[i];

      const energy = Math.abs(sample);
      if (energy > 0.0001) {
        const err = this.agcTarget - (energy * this.agcGain);
        this.agcGain += err * this.agcAlpha;
      }
      if (this.agcGain < 0.1) this.agcGain = 0.1;
      if (this.agcGain > 200) this.agcGain = 200;

      sample *= this.agcGain;

      const i_carrier = Math.sin(this.phase);
      const q_carrier = Math.cos(this.phase);

      const i_mix = sample * i_carrier;
      const q_mix = sample * q_carrier;

      this.i_lpf += (i_mix - this.i_lpf) * this.lpf_alpha;
      this.q_lpf += (q_mix - this.q_lpf) * this.lpf_alpha;

      const signI = this.i_lpf > 0 ? 1 : -1;
      const error = signI * this.q_lpf;

      this.freq += error * this.beta;

      if (this.freq > freqLimit) this.freq = freqLimit;
      if (this.freq < -freqLimit) this.freq = -freqLimit;

      this.phase += this.ncoStepBase + this.freq + (error * this.alpha);

      while (this.phase > Math.PI) this.phase -= 2 * Math.PI;
      while (this.phase < -Math.PI) this.phase += 2 * Math.PI;

      this.sampleCounter++;
      if (this.sampleCounter >= this.samplesPerSymbol) {
        this.sampleCounter -= this.samplesPerSymbol;

        constPoints.push({ i: this.i_lpf, q: this.q_lpf });

        const rawBit = this.i_lpf > 0 ? 1 : 0;

        const dataBit = rawBit ^ this.lastBit;
        this.lastBit = rawBit;

        bitsOut.push(dataBit);
      }
    }

    if (bitsOut.length > 0) {
      this.port.postMessage({ type: 'bits', data: bitsOut });
    }

    this.framesProcessed++;
    if (this.framesProcessed % 10 === 0) {
      this.port.postMessage({
        type: 'stats',
        freqOffset: (this.freq * this.fs / (2 * Math.PI)),
        gain: this.agcGain,
        points: constPoints,
      });
    }

    return true;
  }
}

registerProcessor('bpsk-processor', BpskProcessor);
