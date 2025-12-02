// Simple 18 kHz BPSK modem demo (send + listen) without external deps.
const CARRIER = 18_000;
const SYMBOL_RATE = 500; // baud
const PREAMBLE_BITS = 80;
const SYNC_WORD = 0xa5a5a5a5 >>> 0;
const VERSION = 1;

const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const listenBtn = document.getElementById('listenBtn');
const modePill = document.getElementById('modePill');
const statusPill = document.getElementById('statusPill');
const rxArea = document.getElementById('rxArea');
const logArea = document.getElementById('logArea');

let audioCtx;
let demodNode;
let listening = false;
let bitBuffer = [];
let synced = false;
let stream;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const syncBits = wordToBits(SYNC_WORD, 32);

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

function log(msg) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
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
  const ctx = await ensureContext();
  const sampleRate = ctx.sampleRate;
  const sps = Math.round(sampleRate / SYMBOL_RATE);

  const frameBits = buildFrameBits(text);
  const samples = bitsToSignal(frameBits, sampleRate, sps);

  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();

  log(`Передача: ${text} (${frameBits.length} бит, ${samples.length} сэмплов)`);
}

function buildFrameBits(text) {
  const payload = Array.from(encoder.encode(text));
  if (payload.length > 255) {
    throw new Error('Сообщение слишком длинное (макс 255 байт)');
  }

  const header = [payload.length & 0xff, VERSION];
  const dataBytes = [...header, ...payload];
  const crc = crc16(dataBytes);
  const crcBytes = [(crc >> 8) & 0xff, crc & 0xff];

  const bits = [];
  bits.push(...buildPreambleBits());
  bits.push(...wordToBits(SYNC_WORD, 32));
  bits.push(...bytesToBits(header));
  bits.push(...bytesToBits(payload));
  bits.push(...bytesToBits(crcBytes));
  return bits;
}

function buildPreambleBits() {
  const arr = [];
  for (let i = 0; i < PREAMBLE_BITS; i++) {
    arr.push(i % 2 === 0 ? 1 : 0);
  }
  return arr;
}

function bitsToSignal(bits, sampleRate, sps) {
  const totalSamples = bits.length * sps;
  const out = new Float32Array(totalSamples);
  const w = 2 * Math.PI * CARRIER / sampleRate;
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
    const ctx = await ensureContext();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    await ctx.audioWorklet.addModule('demod-worklet.js');

    demodNode = new AudioWorkletNode(ctx, 'bpsk-demod', { numberOfOutputs: 0 });
    demodNode.port.onmessage = handleDemodMessage;

    const src = ctx.createMediaStreamSource(stream);
    src.connect(demodNode);

    listening = true;
    bitBuffer = [];
    synced = false;
    listenBtn.classList.add('active');
    modePill.textContent = 'Режим: listen';
    statusPill.textContent = 'слушаем...';
    log('Слушаем микрофон, ищем преамбулу');
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
    statusPill.textContent = `поймали преамбулу (corr=${msg.score.toFixed(2)})`;
    log(`Поймали преамбулу, corr=${msg.score.toFixed(2)}`);
  } else if (msg.type === 'bits') {
    handleBits(msg.bits);
  }
}

function handleBits(bits) {
  if (!bits || !bits.length) return;
  bitBuffer.push(...bits);

  if (!synced) {
    const idx = findSync(bitBuffer, syncBits);
    if (idx !== -1) {
      bitBuffer = bitBuffer.slice(idx + syncBits.length);
      synced = true;
      statusPill.textContent = 'sync найден';
      log('Синхрослово найдено, читаем кадр...');
    } else if (bitBuffer.length > 4096) {
      bitBuffer = bitBuffer.slice(-2048);
    }
    return;
  }

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

  bitBuffer = bitBuffer.slice(need);
  resetAfterFrame();
}

function resetAfterFrame() {
  synced = false;
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
