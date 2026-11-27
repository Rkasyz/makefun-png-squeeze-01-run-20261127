// png-squeeze: a lossless PNG re-encoder that writes 1280x720 RGBA screenshots
// in as few bytes as it can.
//
// Strategy, per image:
//   1. Decode the stored PNG to raw RGBA pixels.
//   2. Analyse the pixels: opaque? grey? how many distinct colours?
//      From that, build the candidate colour forms:
//        - palette (colour type 3) when there are at most 256 colours, in two
//          palette orders (by count, by luminance), transparent entries first
//          so the tRNS chunk stays short;
//        - grey (type 0) / grey+alpha (type 4) when every pixel is grey;
//        - RGB (type 2) / RGBA (type 6) otherwise, dropping the alpha channel
//          when every pixel is opaque, or keying the single fully-transparent
//          value with tRNS when the image allows it.
//   3. For each form, filter every row eight ways in a single pass over the
//      image: the five fixed filters, the minimum-signed-sum choice, the
//      fewest-distinct-byte-pairs choice, and a brute-force choice that
//      actually deflates each row's five candidates against the 32 KiB of
//      filtered data written before it and keeps the cheapest. Each candidate
//      is then weighed by a real zlib deflate at level 6, plus its PLTE/tRNS
//      chunk overhead, and the best three of each form go on to the final.
//   4. The shortlist is re-deflated at level 9 (memLevel 8 and 9, default
//      strategy, then the filtered strategy on the winner) and the smallest
//      stream is written out as a single IDAT.
//
// Everything is deterministic: fixed work per image, no clock, no randomness,
// no environment-dependent branching. Node 22 standard library only.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants as zlibConstants } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------------------
// CRC-32 (ISO 3309, PNG's) and PNG chunk assembly.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Assemble a PNG from [type, data] chunks. */
function pngOf(chunks) {
  let size = PNG_SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let at = PNG_SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(asciiBytes(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = colourType;
  // compression 0, filter 0, interlace 0 are already zero.
  return data;
}

// ---------------------------------------------------------------------------
// PNG decoding (the input is a stored type-6 PNG, but decode generally).
// ---------------------------------------------------------------------------

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode a PNG file's bytes to { width, height, rgba }. Throws on bad input. */
function decodePng(bytes) {
  if (bytes.length < 8) throw new Error('file too short for a PNG signature');
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idatParts = [];
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (at + 12 + len > bytes.length) throw new Error('truncated chunk ' + type);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9] };
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (header === null) throw new Error('no IHDR');
  if (header.depth !== 8) throw new Error('unsupported bit depth ' + header.depth);
  const bpp = CHANNELS[header.colourType];
  if (bpp === undefined) throw new Error('unsupported colour type ' + header.colourType);
  const { width, height, colourType } = header;
  const stride = width * bpp;
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts));
  if (raw.length !== height * (stride + 1)) throw new Error('unexpected inflated length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('bad filter type ' + ft);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredictor(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i] * 3;
      rgba[d] = palette[e];
      rgba[d + 1] = palette[e + 1];
      rgba[d + 2] = palette[e + 2];
      rgba[d + 3] = trns !== null && samples[i] < trns.length ? trns[samples[i]] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Image analysis: opacity, greyness, distinct colours, transparent key.
// ---------------------------------------------------------------------------

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = words[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else {
        counts.set(c, k + 1);
      }
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { r: b[0], g: b[1], b: b[2], a: b[3], word: c, count: counts.get(c) };
    });
  }
  return { opaque, grey, colours };
}

/**
 * The one fully-transparent value the image may key by tRNS instead of an
 * alpha channel: every non-opaque pixel is that exact value at alpha 0, and
 * no opaque pixel uses the same value. Null when there is none.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Candidate colour forms.
// ---------------------------------------------------------------------------

function paletteForm(rgba, colours, order) {
  const luminance = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return luminance(x) - luminance(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(words[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

/** The image's samples in colour type `ct` (0, 2 or 4) from its RGBA. */
function channelSamples(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) {
      out[s] = rgba[d];
    } else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/** All candidate forms for an image, each with its chunk overhead in bytes. */
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      const overhead = 12 + p.plte.length + (p.trns === null ? 0 : 12 + p.trns.length);
      forms.push({ ...p, overhead });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    colourType: ct,
    bpp,
    samples: channelSamples(rgba, ct),
    plte: null,
    trns,
    overhead: trns === null ? 0 : 12 + trns.length,
  });
  return forms;
}

// ---------------------------------------------------------------------------
// Filtering: one pass per form produces all eight filter candidates.
// ---------------------------------------------------------------------------

function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
    return;
  }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
    return;
  }
  if (type === 2) {
    if (prev === null) {
      out.set(cur);
      return;
    }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
    return;
  }
  if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((a + b) >> 1);
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paethPredictor(a, b, c);
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsCost(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// How much filtered data the brute-force row choice looks back over.
const BRUTE_CONTEXT = 32768;
// The zlib level the brute-force row choice weighs each row's trials at.
const BRUTE_LEVEL = 6;

/**
 * Filter a form's samples eight ways (five fixed filters, minsum, pairs,
 * brute force) in one pass, returning each candidate's filtered data.
 * The brute-force choice deflates each row's five trials against the 32 KiB
 * of filtered data already written and keeps the cheapest.
 */
function filterCandidates(samples, width, height, bpp) {
  const stride = width * bpp;
  const rowLen = stride + 1;
  const raws = Array.from({ length: 8 }, () => new Uint8Array(height * rowLen));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const trialFull = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(rowLen);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * rowLen;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trial[t]);
      raws[t][at] = t;
      raws[t].set(trial[t], at + 1);
      trialFull[t].set(trial[t], 1);
    }
    // Minimum signed sum.
    let bestSum = Infinity;
    let sumType = 0;
    for (let t = 0; t < 5; t++) {
      const s = signedSum(trial[t]);
      if (s < bestSum) {
        bestSum = s;
        sumType = t;
      }
    }
    raws[5][at] = sumType;
    raws[5].set(trial[sumType], at + 1);
    // Fewest distinct byte pairs.
    let bestPairs = Infinity;
    let pairsType = 0;
    for (let t = 0; t < 5; t++) {
      const s = pairsCost(trial[t], seen, ++stamp);
      if (s < bestPairs) {
        bestPairs = s;
        pairsType = t;
      }
    }
    raws[6][at] = pairsType;
    raws[6].set(trial[pairsType], at + 1);
    // Brute force: real deflate cost of the row against the prior context
    // of its own stream.
    const out = raws[7];
    const before = out.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    const opts = before.length === 0
      ? { level: BRUTE_LEVEL, memLevel: 9 }
      : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before };
    let bestCost = Infinity;
    let bruteType = 0;
    for (let t = 0; t < 5; t++) {
      const cost = deflateSync(trialFull[t], opts).length;
      if (cost < bestCost) {
        bestCost = cost;
        bruteType = t;
      }
    }
    out.set(trialFull[bruteType], at);
  }
  return raws;
}

// ---------------------------------------------------------------------------
// Screening and final compression.
// ---------------------------------------------------------------------------

const SCREEN = { level: 6, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY };
const FILE_OVERHEAD = 8 + 12 + 13 + 12; // signature + IHDR chunk + IEND chunk

/** Level-9 zlib streams of `raw`: memLevel 8 and 9, default strategy, plus the
 * filtered strategy when `filteredToo`. No single setting wins everywhere
 * (memLevel 9 can lose to 8 on these images), so try them and keep the best. */
function level9Variants(raw, filteredToo) {
  const out = [];
  for (const memLevel of [8, 9]) {
    out.push(deflateSync(raw, { level: 9, memLevel, strategy: zlibConstants.Z_DEFAULT_STRATEGY }));
    if (filteredToo) out.push(deflateSync(raw, { level: 9, memLevel, strategy: zlibConstants.Z_FILTERED }));
  }
  return out;
}

/** Encode one RGBA image to its smallest PNG bytes (this program's best). */
function encodeImage(rgba, width, height) {
  // Screen every candidate at level 6, keep the best three of each form,
  // then re-weigh those at level 9: level 6 and level 9 do not always rank
  // candidates the same way.
  const shortlist = [];
  for (const form of formsOf(rgba)) {
    const raws = filterCandidates(form.samples, width, height, form.bpp);
    const scored = raws.map((raw) => {
      const z = deflateSync(raw, SCREEN);
      return { form, raw, screened: z, bytes: z.length + form.overhead + FILE_OVERHEAD };
    });
    scored.sort((a, b) => a.bytes - b.bytes);
    const kept = scored.slice(0, 3);
    // Release the losers' filtered data now; they are large and unneeded.
    for (let i = 3; i < scored.length; i++) scored[i].raw = null;
    shortlist.push(...kept);
  }
  let best = null; // { form, raw, total, idat }
  for (const cand of shortlist) {
    const streams = [cand.screened, ...level9Variants(cand.raw, false)];
    for (const stream of streams) {
      const total = stream.length + cand.form.overhead + FILE_OVERHEAD;
      if (best === null || total < best.total) {
        best = {
          form: cand.form,
          raw: cand.raw,
          total,
          idat: new Uint8Array(stream.buffer, stream.byteOffset, stream.length),
        };
      }
    }
  }
  // A last pass over the winner's raw with the filtered strategy too.
  for (const stream of level9Variants(best.raw, true).slice(2)) {
    const total = stream.length + best.form.overhead + FILE_OVERHEAD;
    if (total < best.total) {
      best.total = total;
      best.idat = new Uint8Array(stream.buffer, stream.byteOffset, stream.length);
    }
  }
  const chunks = [['IHDR', ihdrOf(width, height, best.form.colourType)]];
  if (best.form.plte !== null) chunks.push(['PLTE', best.form.plte]);
  if (best.form.trns !== null) chunks.push(['tRNS', best.form.trns]);
  chunks.push(['IDAT', best.idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------------------------------------------------------------------------
// Main: every instance in /input, in sorted order, to /output.
// ---------------------------------------------------------------------------

for (const id of readdirSync(INPUT_DIR).sort()) {
  const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  const png = encodeImage(rgba, width, height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
