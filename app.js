const CFG = {
  fc: 18000,
  baud: 500,
  syncWord: 0xA5A5A5A5,
  txAmp: 0.2,
};

const ui = {
  log: document.getElementById('log'),
  rx: document.getElementById('rx'),
  btnTx: document.getElementById('btnTx'),
  btnRx: document.getElementById('btnRx'),
  cvs: document.getElementById('constellation'),
  ctx: document.getElementById('constellation')?.getContext('2d'),
  stStatus: document.getElementById('stStatus'),
  stFreq: document.getElementById('stFreq'),
  stGain: document.getElementById('stGain'),
  txInput: document.getElementById('txInput'),
  srWarn: document.getElementById('sampleRateWarn'),
  srVal: document.getElementById('srVal'),
};

let audioCtx;
let workletNode;
let isListening = false;
let rxState = {
  syncBuf: 0,
  isLocked: false,
  buffer: [],
  bitBuffer: [],
};

function log(msg) {
  const d = new Date().toLocaleTimeString();
  ui.log.innerHTML = `<div class="sys-msg">[${d}] ${msg}</div>` + ui.log.innerHTML;
}

function rxLog(msg) {
  ui.rx.innerHTML = `<div class="rx-msg">${msg}</div>` + ui.rx.innerHTML;
}

function crc16(bytes) {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
  }
  return crc & 0xFFFF;
}

async function transmit(text) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const enc = new TextEncoder();
  const payload = enc.encode(text);

  const packet = new Uint8Array(1 + payload.length + 2);
  packet[0] = payload.length;
  packet.set(payload, 1);
  const crc = crc16(packet.subarray(0, packet.length - 2));
  packet[packet.length - 2] = (crc >> 8) & 0xFF;
  packet[packet.length - 1] = crc & 0xFF;

  const bits = [];
  for (let i = 0; i < 80; i++) bits.push(i % 2);

  const sync = CFG.syncWord;
  for (let i = 31; i >= 0; i--) bits.push((sync >> i) & 1);

  for (const byte of packet) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }

  for (let i = 0; i < 10; i++) bits.push(1);

  const sampleRate = audioCtx.sampleRate;
  const samplesPerBit = Math.floor(sampleRate / CFG.baud);
  const buffer = audioCtx.createBuffer(1, bits.length * samplesPerBit, sampleRate);
  const data = buffer.getChannelData(0);

  let phase = 0;
  const phaseStep = (2 * Math.PI * CFG.fc) / sampleRate;
  let lastBit = 0;
  let currentPhaseOffset = 0;
  let targetPhaseOffset = 0;
  let idx = 0;

  for (const bit of bits) {
    const rawBit = bit ^ lastBit;
    lastBit = rawBit;
    targetPhaseOffset = rawBit === 0 ? 0 : Math.PI;

    for (let i = 0; i < samplesPerBit; i++) {
      if (Math.abs(currentPhaseOffset - targetPhaseOffset) > 0.01) {
        let diff = targetPhaseOffset - currentPhaseOffset;
        if (diff > Math.PI) diff -= 2 * Math.PI;
        if (diff < -Math.PI) diff += 2 * Math.PI;
        currentPhaseOffset += diff * 0.10;
      } else {
        currentPhaseOffset = targetPhaseOffset;
      }

      data[idx++] = Math.cos(phase + currentPhaseOffset) * CFG.txAmp;
      phase += phaseStep;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(audioCtx.destination);
  src.start();

  log(`Tx: "${text}" (${bits.length} bits)`);
}

ui.btnTx.onclick = () => {
  const txt = ui.txInput.value.trim();
  if (!txt) return;
  transmit(txt);
};

async function startRx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    if (audioCtx.sampleRate < 40000 && ui.srWarn && ui.srVal) {
      ui.srWarn.style.display = 'block';
      ui.srVal.innerText = audioCtx.sampleRate;
      log('Sample Rate too low!');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: 0,
      },
    });

    await audioCtx.audioWorklet.addModule('demod-worklet.js');

    workletNode = new AudioWorkletNode(audioCtx, 'bpsk-processor');
    workletNode.port.onmessage = handleWorkletMsg;

    const src = audioCtx.createMediaStreamSource(stream);
    src.connect(workletNode);
    workletNode.connect(audioCtx.destination);

    isListening = true;
    ui.btnRx.classList.add('active');
    ui.btnRx.innerText = 'Стоп';
    log(`RX Started. SR: ${audioCtx.sampleRate}Hz`);
  } catch (e) {
    log('Mic Error: ' + e.message);
  }
}

function stopRx() {
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  isListening = false;
  ui.btnRx.classList.remove('active');
  ui.btnRx.innerText = 'Слушать';
}

ui.btnRx.onclick = () => (isListening ? stopRx() : startRx());

function handleWorkletMsg(e) {
  const d = e.data;
  if (!d) return;

  if (d.type === 'stats') {
    ui.stFreq.innerText = `${d.freqOffset.toFixed(1)} Hz`;
    ui.stFreq.style.color = Math.abs(d.freqOffset) > 590 ? 'red' : '#fff';

    ui.stGain.innerText = d.gain.toFixed(1);

    ui.stStatus.innerText = rxState.isLocked ? 'SYNC LOCK' : 'Scanning...';
    ui.stStatus.style.color = rxState.isLocked ? '#0f0' : '#666';

    drawConstellation(d.points);
  } else if (d.type === 'bits') {
    for (const bit of d.data) ingestBit(bit);
  }
}

function ingestBit(bit) {
  if (!rxState.isLocked) {
    rxState.syncBuf = ((rxState.syncBuf << 1) | bit) >>> 0;
    if ((rxState.syncBuf >>> 0) === CFG.syncWord) {
      rxState.isLocked = true;
      rxState.buffer = [];
      rxState.bitBuffer = [];
      log('Sync Found!');
    }
    return;
  }

  rxState.bitBuffer.push(bit);
  if (rxState.bitBuffer.length === 8) {
    let byte = 0;
    for (let i = 0; i < 8; i++) byte = (byte << 1) | rxState.bitBuffer[i];
    rxState.buffer.push(byte);
    rxState.bitBuffer = [];
    checkPacket();
  }

  if (rxState.buffer.length > 256) {
    rxState.isLocked = false;
  }
}

function checkPacket() {
  const buf = rxState.buffer;
  if (buf.length < 2) return;

  const len = buf[0];
  const expectedLen = 1 + len + 2;

  if (buf.length >= expectedLen) {
    const packet = new Uint8Array(buf.slice(0, expectedLen));
    const dataPart = packet.subarray(1, 1 + len);
    const calc = crc16(packet.subarray(0, packet.length - 2));
    const recv = (packet[packet.length - 2] << 8) | packet[packet.length - 1];

    if (calc === recv) {
      const decoder = new TextDecoder();
      try {
        const txt = decoder.decode(dataPart);
        rxLog(txt);
        log(`Msg OK: "${txt}"`);
      } catch (e) {
        // ignore decode errors
      }
    } else {
      log('CRC Fail');
    }
    rxState.isLocked = false;
    rxState.buffer = [];
  }
}

function drawConstellation(points) {
  if (!ui.ctx || !ui.cvs) return;
  const ctx = ui.ctx;
  const w = ui.cvs.width;
  const h = ui.cvs.height;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#004400';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(w * 0.25, h / 2, 20, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(w * 0.75, h / 2, 20, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  ctx.fillStyle = '#48b9ff';
  if (!points) return;

  for (const p of points) {
    const scale = 100;
    const x = (p.i * scale) + w / 2;
    const y = (p.q * scale) + h / 2;
    ctx.fillRect(x, y, 2, 2);
  }
}
