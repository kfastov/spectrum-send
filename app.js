// Simple 18 kHz BPSK modem demo (send + listen) without external deps.
const DEFAULT_CARRIER = 18_000;
const DEFAULT_SYMBOL_RATE = 500; // baud
const MIN_CARRIER = 15_000;
const MAX_CARRIER = 21_000;
const MIN_BAUD = 100;
const MAX_BAUD = 1_500;
const MIN_LPF_FACTOR = 1;
const MAX_LPF_FACTOR = 6;
const MIN_CORR = 0.05;
const MAX_CORR = 1;
const PREAMBLE_BITS = 80;
const SYNC_WORD = 0xa5a5a5a5 >>> 0;
const VERSION = 1;
const K = 7;
const FLUSH_BITS = K - 1; // tail bits for trellis termination
const G0 = 0x5b; // 133 octal
const G1 = 0x79; // 171 octal

const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const listenBtn = document.getElementById('listenBtn');
const modePill = document.getElementById('modePill');
const statusPill = document.getElementById('statusPill');
const rxArea = document.getElementById('rxArea');
const logArea = document.getElementById('logArea');
const freqInput = document.getElementById('freqInput');
const baudInput = document.getElementById('baudInput');
const fecCheckbox = document.getElementById('fecCheckbox');
const lpfInput = document.getElementById('lpfInput');
const corrInput = document.getElementById('corrInput');

let audioCtx;
let demodNode;
let listening = false;
let bitBuffer = [];
let codedBuffer = [];
let synced = false;
let stream;
let carrierHz = DEFAULT_CARRIER;
let symbolRate = DEFAULT_SYMBOL_RATE;
let useFEC = true;
let lpfFactor = 2.0;
let lockThreshold = 0.3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const syncBits = wordToBits(SYNC_WORD, 32);
const transitions = buildTransitions();

sendBtn.addEventListener('click', () => {
  const text = textInput.value || '';
  if (!text.trim()) {
    log('Нет текста для передачи');
    return;
  }
  sendBtn.disabled = true;
  playFrame(text).finally(() => {
    sendBtn.disabled = false;
  });
});

listenBtn.addEventListener('click', () => {
  listening ? stopListening() : startListening();
});

freqInput.addEventListener('change', applySettingsFromUI);
baudInput.addEventListener('change', applySettingsFromUI);
fecCheckbox.addEventListener('change', applySettingsFromUI);
lpfInput.addEventListener('change', applySettingsFromUI);
corrInput.addEventListener('change', applySettingsFromUI);

applySettingsFromUI();

function log(msg) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function applySettingsFromUI() {
  carrierHz = clamp(parseInt(freqInput.value, 10) || DEFAULT_CARRIER, MIN_CARRIER, MAX_CARRIER);
  freqInput.value = carrierHz;
  symbolRate = clamp(parseInt(baudInput.value, 10) || DEFAULT_SYMBOL_RATE, MIN_BAUD, MAX_BAUD);
  baudInput.value = symbolRate;
  useFEC = !!fecCheckbox.checked;
  lpfFactor = clamp(parseFloat(lpfInput.value) || 2, MIN_LPF_FACTOR, MAX_LPF_FACTOR);
  lpfInput.value = lpfFactor.toFixed(1);
  lockThreshold = clamp(parseFloat(corrInput.value) || 0.3, MIN_CORR, MAX_CORR);
  corrInput.value = lockThreshold.toFixed(2);
  updatePills();
  if (demodNode) {
    demodNode.port.postMessage({ type: 'config', carrierHz, symbolRate, lpfFactor, lockThreshold });
    bitBuffer = [];
    codedBuffer = [];
    synced = false;
    statusPill.textContent = 'слушаем...';
  }
}

function updatePills() {
  document.getElementById('carrierPill').textContent = `fc: ${(carrierHz / 1000).toFixed(1)} кГц`;
  document.getElementById('ratePill').textContent = `${symbolRate} бод`;
}

function addRx(text) {
  const line = document.createElement('div');
  line.className = 'rx-line';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = 'RX';
  const txt = document.createElement('span');
  txt.textContent = ` ${text}`;
  line.appendChild(tag);
  line.appendChild(txt);
  rxArea.appendChild(line);
  rxArea.scrollTop = rxArea.scrollHeight;
}

async function ensureContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    await audioCtx.resume();
  } else if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  return audioCtx;
}

async function playFrame(text) {
  applySettingsFromUI();
  const ctx = await ensureContext();
  const sampleRate = ctx.sampleRate;
  const sps = Math.max(1, Math.round(sampleRate / symbolRate));

  const frameBits = buildFrameBits(text, useFEC);
  const samples = bitsToSignal(frameBits, sampleRate, sps, carrierHz);

  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();

  log(`Передача: ${text} (${frameBits.length} бит, ${samples.length} сэмплов, fc=${carrierHz} Гц, ${symbolRate} бод, FEC=${useFEC ? 'on' : 'off'}, LPF≈${(symbolRate * lpfFactor).toFixed(0)} Гц)`);
}

function buildFrameBits(text, withFEC) {
  const payload = Array.from(encoder.encode(text));
  if (payload.length > 255) {
    throw new Error('Сообщение слишком длинное (макс 255 байт)');
  }

  const header = [payload.length & 0xff, VERSION];
  const dataBytes = [...header, ...payload];
  const crc = crc16(dataBytes);
  const crcBytes = [(crc >> 8) & 0xff, crc & 0xff];

  const infoBits = [
    ...bytesToBits(header),
    ...bytesToBits(payload),
    ...bytesToBits(crcBytes),
  ];
  const bits = [];
  bits.push(...buildPreambleBits());
  bits.push(...wordToBits(SYNC_WORD, 32));
  if (withFEC) {
    const fecBits = convEncode(infoBits);
    bits.push(...fecBits);
  } else {
    bits.push(...infoBits);
  }
  return bits;
}

function buildPreambleBits() {
  const arr = [];
  for (let i = 0; i < PREAMBLE_BITS; i++) {
    arr.push(i % 2 === 0 ? 1 : 0);
  }
  return arr;
}

function bitsToSignal(bits, sampleRate, sps, fc) {
  const totalSamples = bits.length * sps;
  const out = new Float32Array(totalSamples);
  const w = 2 * Math.PI * fc / sampleRate;
  let sampleIndex = 0;
  const edge = Math.max(1, Math.floor(sps * 0.15));

  for (let bi = 0; bi < bits.length; bi++) {
    const bit = bits[bi];
    const sign = bit === 0 ? 1 : -1;
    for (let j = 0; j < sps; j++) {
      let env = 1;
      if (j < edge) {
        env = 0.5 * (1 - Math.cos(Math.PI * j / edge));
      } else if (j >= sps - edge) {
        const k = sps - j;
        env = 0.5 * (1 - Math.cos(Math.PI * k / edge));
      }
      const t = sampleIndex;
      out[sampleIndex++] = sign * env * Math.cos(w * t) * 0.35;
    }
  }
  return out;
}

async function startListening() {
  try {
    applySettingsFromUI();
    const ctx = await ensureContext();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    await ctx.audioWorklet.addModule('demod-worklet.js');

    demodNode = new AudioWorkletNode(ctx, 'bpsk-demod', { numberOfOutputs: 0 });
    demodNode.port.onmessage = handleDemodMessage;
    demodNode.port.postMessage({ type: 'config', carrierHz, symbolRate, lpfFactor, lockThreshold });

    const src = ctx.createMediaStreamSource(stream);
    src.connect(demodNode);

    listening = true;
    bitBuffer = [];
    synced = false;
    listenBtn.classList.add('active');
    modePill.textContent = 'Режим: listen';
    statusPill.textContent = 'слушаем...';
    log(`Слушаем микрофон, fc=${carrierHz} Гц, ${symbolRate} бод, FEC=${useFEC ? 'on' : 'off'}`);
  } catch (err) {
    console.error(err);
    log(`Ошибка доступа к микрофону: ${err.message}`);
  }
}

function stopListening() {
  listening = false;
  listenBtn.classList.remove('active');
  modePill.textContent = 'Режим: idle';
  statusPill.textContent = 'остановлено';

  if (demodNode) {
    demodNode.port.postMessage({ type: 'reset' });
    demodNode.disconnect();
    demodNode = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  log('Слушание остановлено');
}

function handleDemodMessage(event) {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'locked') {
    const df = msg.dfHz ? `, df=${msg.dfHz.toFixed(1)} Гц` : '';
    statusPill.textContent = `поймали преамбулу (corr=${msg.score.toFixed(2)}${df})`;
    log(`Поймали преамбулу, corr=${msg.score.toFixed(2)}${df}`);
  } else if (msg.type === 'bits') {
    handleBits(msg.bits);
  } else if (msg.type === 'pll' && typeof msg.dfHz === 'number') {
    log(`PLL df=${msg.dfHz.toFixed(1)} Гц`);
  }
}

function handleBits(bits) {
  if (!bits || !bits.length) return;
  if (useFEC) {
    handleBitsFec(bits);
  } else {
    handleBitsPlain(bits);
  }
}

function handleBitsFec(bits) {
  bitBuffer.push(...bits);

  if (!synced) {
    const idx = findSync(bitBuffer, syncBits);
    if (idx !== -1) {
      codedBuffer = bitBuffer.slice(idx + syncBits.length);
      bitBuffer = [];
      synced = true;
      statusPill.textContent = 'sync найден';
      log('Синхрослово найдено, FEC декод...');
      return;
    } else if (bitBuffer.length > 4096) {
      bitBuffer = bitBuffer.slice(-2048);
    }
    return;
  }

  codedBuffer.push(...bits);
  tryDecodeFrame();
}

function handleBitsPlain(bits) {
  bitBuffer.push(...bits);
  if (!synced) {
    const idx = findSync(bitBuffer, syncBits);
    if (idx !== -1) {
      bitBuffer = bitBuffer.slice(idx + syncBits.length);
      synced = true;
      statusPill.textContent = 'sync найден';
      log('Синхрослово найдено, декод без FEC...');
    } else if (bitBuffer.length > 4096) {
      bitBuffer = bitBuffer.slice(-2048);
    }
    return;
  }
  tryDecodePlain();
}

function resetAfterFrame() {
  synced = false;
  bitBuffer = [];
  codedBuffer = [];
  if (demodNode) {
    demodNode.port.postMessage({ type: 'reset' });
  }
}

function findSync(buf, pattern) {
  if (buf.length < pattern.length) return -1;
  for (let i = 0; i <= buf.length - pattern.length; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (buf[i + j] !== pattern[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function wordToBits(word, width) {
  const bits = [];
  for (let i = width - 1; i >= 0; i--) {
    bits.push((word >> i) & 1);
  }
  return bits;
}

function bytesToBits(bytes) {
  const bits = [];
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) {
      bits.push((b >> i) & 1);
    }
  }
  return bits;
}

function bitsToBytes(bits) {
  const out = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    out.push(bitsToByte(bits.slice(i, i + 8)));
  }
  return out;
}

function bitsToByte(bits) {
  let val = 0;
  for (let i = 0; i < 8; i++) {
    val = (val << 1) | (bits[i] & 1);
  }
  return val;
}

function bitsToWord(bits) {
  let val = 0;
  for (let i = 0; i < bits.length; i++) {
    val = (val << 1) | (bits[i] & 1);
  }
  return val >>> 0;
}

function parity(v) {
  v ^= v >> 4;
  v ^= v >> 2;
  v ^= v >> 1;
  return v & 1;
}

function convEncode(infoBits) {
  let state = 0;
  const out = [];
  const pushBit = (b) => {
    state = ((state << 1) | (b & 1)) & 0x7f;
    out.push(parity(state & G0));
    out.push(parity(state & G1));
  };
  for (const b of infoBits) pushBit(b);
  for (let i = 0; i < FLUSH_BITS; i++) pushBit(0);
  return out;
}

function buildTransitions() {
  const table = Array.from({ length: 64 }, () => [null, null]);
  for (let state = 0; state < 64; state++) {
    for (let bit = 0; bit <= 1; bit++) {
      const reg = ((state << 1) | bit) & 0x7f;
      const next = reg & 0x3f;
      const o0 = parity(reg & G0);
      const o1 = parity(reg & G1);
      table[state][bit] = { next, o0, o1 };
    }
  }
  return table;
}

function viterbiDecode(codedBits) {
  const evenLen = codedBits.length & ~1;
  if (evenLen < 2) return [];
  const steps = evenLen / 2;
  const INF = 1e9;
  let metrics = new Float32Array(64).fill(INF);
  metrics[0] = 0;
  const decisions = Array(steps);

  for (let i = 0; i < steps; i++) {
    const r0 = codedBits[i * 2];
    const r1 = codedBits[i * 2 + 1];
    const nextMetrics = new Float32Array(64).fill(INF);
    const dec = new Uint8Array(64);
    for (let state = 0; state < 64; state++) {
      const base = metrics[state];
      if (base >= INF) continue;
      for (let bit = 0; bit <= 1; bit++) {
        const t = transitions[state][bit];
        const dist = (t.o0 !== r0) + (t.o1 !== r1);
        const cand = base + dist;
        if (cand < nextMetrics[t.next]) {
          nextMetrics[t.next] = cand;
          dec[t.next] = (state << 1) | bit;
        }
      }
    }
    metrics = nextMetrics;
    decisions[i] = dec;
  }

  let bestState = 0;
  let bestMetric = metrics[0];
  for (let s = 1; s < 64; s++) {
    if (metrics[s] < bestMetric) {
      bestMetric = metrics[s];
      bestState = s;
    }
  }

  const bits = new Array(steps);
  for (let i = steps - 1; i >= 0; i--) {
    const code = decisions[i][bestState];
    const bit = code & 1;
    const prev = code >> 1;
    bits[i] = bit;
    bestState = prev;
  }
  return bits;
}

function tryDecodePlain() {
  if (!synced) return;
  if (bitBuffer.length < 16) return;
  const len = bitsToByte(bitBuffer.slice(0, 8));
  const flags = bitsToByte(bitBuffer.slice(8, 16));
  if (len > 255) {
    log(`Неверная длина (${len}), сбрасываем`);
    resetAfterFrame();
    return;
  }
  const need = 16 + len * 8 + 16;
  if (bitBuffer.length < need) return;

  const payloadBits = bitBuffer.slice(16, 16 + len * 8);
  const crcBits = bitBuffer.slice(16 + len * 8, need);
  const dataBytes = bitsToBytes(bitBuffer.slice(0, 16 + len * 8));
  const recvCrc = bitsToWord(crcBits);
  const calc = crc16(dataBytes);

  if (recvCrc === calc) {
    const payloadBytes = bitsToBytes(payloadBits);
    const text = safeDecode(payloadBytes);
    addRx(text);
    statusPill.textContent = 'кадр принят';
    log(`Кадр принят: ${text} (len=${len}, flags=${flags})`);
  } else {
    statusPill.textContent = 'CRC ошибка';
    log(`CRC ошибка (ожидалось ${calc.toString(16)}, пришло ${recvCrc.toString(16)})`);
  }
  resetAfterFrame();
}

function tryDecodeFrame() {
  const minInfoBits = 16 + 16; // header + CRC without payload
  const minCodedBits = 2 * (minInfoBits + FLUSH_BITS);
  if (codedBuffer.length < minCodedBits) return;

  const decodedSoft = viterbiDecode(codedBuffer);
  if (!decodedSoft.length) return;
  const infoWithTail = decodedSoft;
  if (infoWithTail.length <= FLUSH_BITS) return;
  const infoBits = infoWithTail.slice(0, infoWithTail.length - FLUSH_BITS);
  if (infoBits.length < 16) return;

  const len = bitsToByte(infoBits.slice(0, 8));
  const flags = bitsToByte(infoBits.slice(8, 16));
  if (len > 255) {
    log(`Неверная длина (${len}), сбрасываем`);
    resetAfterFrame();
    return;
  }

  const neededInfo = 16 + len * 8 + 16;
  const neededCoded = 2 * (neededInfo + FLUSH_BITS);
  if (codedBuffer.length < neededCoded) return;

  const decoded = viterbiDecode(codedBuffer.slice(0, neededCoded));
  if (!decoded.length || decoded.length < neededInfo + FLUSH_BITS) return;

  const info = decoded.slice(0, neededInfo);
  const payloadBits = info.slice(16, 16 + len * 8);
  const crcBits = info.slice(16 + len * 8);
  const dataBytes = bitsToBytes(info.slice(0, 16 + len * 8));
  const recvCrc = bitsToWord(crcBits);
  const calc = crc16(dataBytes);

  if (recvCrc === calc) {
    const payloadBytes = bitsToBytes(payloadBits);
    const text = safeDecode(payloadBytes);
    addRx(text);
    statusPill.textContent = 'кадр принят (FEC ok)';
    log(`Кадр принят: ${text} (len=${len}, flags=${flags})`);
  } else {
    statusPill.textContent = 'CRC ошибка';
    log(`CRC ошибка (ожидалось ${calc.toString(16)}, пришло ${recvCrc.toString(16)})`);
  }

  codedBuffer = [];
  resetAfterFrame();
}

function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
      crc &= 0xffff;
    }
  }
  return crc;
}

function safeDecode(arr) {
  try {
    return decoder.decode(new Uint8Array(arr));
  } catch (_) {
    return arr.map(v => v.toString(16).padStart(2, '0')).join(' ');
  }
}
