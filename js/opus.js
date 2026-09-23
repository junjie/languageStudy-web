/* Dictation audio as Ogg Opus rather than WAV.

   Gemini TTS hands back raw 16-bit PCM at 24 kHz: 48 KB for every second of
   speech, so a bank of a few hundred sentences runs to tens of megabytes, all
   of it copied into every zip backup. Opus at 32 kbit/s is a twelfth of that
   and, for one voice speaking, not distinguishable from it.

   No browser writes MP3, and this app takes no dependencies, but every current
   browser ships an Opus encoder behind WebCodecs (AudioEncoder) and plays Ogg
   Opus back. The encoder hands out bare packets, so the one thing written here
   is the Ogg wrapper around them (RFC 3533, RFC 7845) — small, and pure, so
   node can check it.

   Where AudioEncoder is missing or refuses the job the caller keeps the WAV:
   an older browser saves what it always saved, and a bank can hold both. */

export const OPUS_MIME = 'audio/ogg; codecs=opus';
const BITRATE = 32000;
/* libopus's own encoder delay at 48 kHz, used only when the encoder does not
   say what it used. */
const DEFAULT_PRE_SKIP = 312;

/* ── the encoder ─────────────────────────────────────────────────────── */

export function canEncodeOpus() {
  return typeof AudioEncoder === 'function' && typeof AudioData === 'function';
}

/* 16-bit little-endian mono PCM in, an Ogg Opus file out as bytes; or null
   when this browser cannot do it, so the caller falls back to WAV. Never
   throws: a failed squeeze must not cost the user a sentence they have paid
   an API call for. */
export async function encodeOggOpus(pcm, rate) {
  if (!canEncodeOpus() || !pcm || pcm.length < 2) return null;
  const config = { codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: BITRATE };
  try {
    const { supported } = await AudioEncoder.isConfigSupported(config);
    if (!supported) return null;

    const packets = [];
    let preSkip = DEFAULT_PRE_SKIP;
    let failure = null;
    const encoder = new AudioEncoder({
      output(chunk, meta) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        packets.push(bytes);
        const head = meta && meta.decoderConfig && meta.decoderConfig.description;
        const skip = head ? preSkipFrom(head) : null;
        if (skip !== null) preSkip = skip;
      },
      error(e) { failure = e; },
    });
    encoder.configure(config);

    /* A copy, because the PCM arrives as a view that may start at an odd
       byte, and Int16Array needs an aligned buffer. */
    const frames = Math.floor(pcm.length / 2);
    const samples = new Int16Array(frames);
    new Uint8Array(samples.buffer).set(pcm.subarray(0, frames * 2));
    const data = new AudioData({
      format: 's16', sampleRate: rate, numberOfChannels: 1,
      numberOfFrames: frames, timestamp: 0, data: samples,
    });
    encoder.encode(data);
    data.close();
    await encoder.flush();
    encoder.close();

    if (failure || !packets.length) return null;
    return oggOpus(packets, { preSkip, inputRate: rate, samples: Math.round((frames * 48000) / rate) });
  } catch (e) {
    console.warn('Opus encoding failed; keeping WAV.', e);
    return null;
  }
}

/* The encoder's description, when it gives one, is an OpusHead; its pre-skip
   is the delay that particular encoder put in front of the speech. */
function preSkipFrom(description) {
  const bytes = description instanceof ArrayBuffer
    ? new Uint8Array(description)
    : new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
  if (bytes.length < 19 || ascii(bytes.subarray(0, 8)) !== 'OpusHead') return null;
  return bytes[10] | (bytes[11] << 8);
}

/* ── packets ─────────────────────────────────────────────────────────── */

/* How much audio one Opus packet holds, in 48 kHz samples, read from its
   table-of-contents byte (RFC 6716 §3.1). Ogg positions are counted this way
   whatever rate went in, so the wrapper needs it for every packet. */
export function packetSamples(packet) {
  if (!packet || !packet.length) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let tenths;                                   // frame length in 0.1 ms
  if (config < 12) tenths = [100, 200, 400, 600][config & 3];       // SILK
  else if (config < 16) tenths = [100, 200][config & 1];            // hybrid
  else tenths = [25, 50, 100, 200][config & 3];                     // CELT
  const code = toc & 3;
  const count = code === 0 ? 1 : code === 3 ? (packet[1] || 0) & 0x3f : 2;
  return (count * tenths * 48) / 10;
}

/* ── the Ogg wrapper ─────────────────────────────────────────────────── */

/* Ogg's CRC is the unreflected 0x04c11db7 polynomial, unlike zip's. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc;
}

function ascii(bytes) {
  return String.fromCharCode(...bytes);
}

function opusHead(preSkip, inputRate) {
  const out = new Uint8Array(19);
  const view = new DataView(out.buffer);
  out.set([...'OpusHead'].map((c) => c.charCodeAt(0)));
  out[8] = 1;                                   // version
  out[9] = 1;                                   // mono
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);          // informational only
  view.setInt16(16, 0, true);                   // output gain
  out[18] = 0;                                  // mapping family: mono/stereo
  return out;
}

function opusTags() {
  const vendor = new TextEncoder().encode('language-study-web');
  const out = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(out.buffer);
  out.set([...'OpusTags'].map((c) => c.charCodeAt(0)));
  view.setUint32(8, vendor.length, true);
  out.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true);  // no comments
  return out;
}

/* One page around whole packets. None of ours comes near the 64 KB a page can
   carry, so a packet is never split across two. */
function page(packets, { granule, serial, sequence, flags }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const bodyLength = packets.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + bodyLength);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53]);            // OggS
  out[4] = 0;                                   // version
  out[5] = flags;
  view.setBigUint64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) { out.set(p, at); at += p.length; }
  view.setUint32(22, oggCrc(out), true);        // computed with the field zero
  return out;
}

/* Opus packets into one Ogg file.

   `samples` is how long the original speech was, in 48 kHz samples. The
   encoder pads the last packet to a whole frame; setting the final position
   to pre-skip + samples tells the player to drop that padding (RFC 7845
   §4.4), so the clip is exactly as long as what Gemini said. */
export function oggOpus(packets, { preSkip = DEFAULT_PRE_SKIP, inputRate = 48000, samples, serial } = {}) {
  const stream = serial === undefined ? (Math.random() * 0xffffffff) >>> 0 : serial >>> 0;
  const pages = [
    page([opusHead(preSkip, inputRate)], { granule: 0, serial: stream, sequence: 0, flags: 0x02 }),
    page([opusTags()], { granule: 0, serial: stream, sequence: 1, flags: 0 }),
  ];

  /* About a second of audio per page, well under the 255-segment limit. */
  const PER_PAGE = 50;
  let position = preSkip;
  for (let i = 0; i < packets.length; i += PER_PAGE) {
    const group = packets.slice(i, i + PER_PAGE);
    for (const p of group) position += packetSamples(p);
    const last = i + PER_PAGE >= packets.length;
    const granule = last && samples !== undefined ? Math.min(position, preSkip + samples) : position;
    pages.push(page(group, { granule, serial: stream, sequence: pages.length, flags: last ? 0x04 : 0 }));
  }

  const out = new Uint8Array(pages.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of pages) { out.set(p, at); at += p.length; }
  return out;
}
