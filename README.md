# Spectrum Send

Small browser demo that sends and receives a narrow 18 kHz BPSK stream. Works fully in the browser with no dependencies.

## Usage
- Open `index.html` locally or visit `https://kfastov.github.io/spectrum-send` once Pages is active.
- Type text, hit `Play` to transmit at 500 baud around 18 kHz.
- Press `Listen` to capture mic input; allow microphone access when prompted.
- Received frames appear in the *Принято* block, logs in *Лог*.

## Files
- `index.html` – UI and wiring for the demo.
- `app.js` – framing, CRC, modulation, and page logic.
- `demod-worklet.js` – AudioWorklet demodulator that locks to the preamble and emits hard bits.

Tested in recent Chrome.
