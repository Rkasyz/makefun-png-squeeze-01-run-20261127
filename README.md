# png-squeeze

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Rkasyz/makefun-png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Rkasyz/makefun-png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

[make.fun bounty: Squeeze screenshots into the smallest PNG, 27 November 2026](https://make.fun/bounty/png-squeeze-01-run-20261127)

A lossless PNG re-encoder for 1280×720 RGBA screenshots. It writes each
screenshot again as the smallest PNG it can, preserving every pixel's RGBA
exactly — including fully-transparent pixels' colour.

## How it works

For each image, in one run over all 8 instances:

1. **Decode** the stored input PNG to raw RGBA pixels.
2. **Analyse** the pixels (opaque? grey? distinct colours?) and build the
   candidate colour forms:
   - palette (colour type 3) when there are at most 256 colours, in two
     palette orders (by count, by luminance), transparent entries first so
     the `tRNS` chunk stays short;
   - grey (type 0) / grey+alpha (type 4) when every pixel is grey;
   - RGB (type 2) / RGBA (type 6) otherwise, dropping the alpha channel
     when every pixel is opaque, or keying the single fully-transparent
     value with `tRNS` when the image allows it.
3. **Filter** each form eight ways in a single pass: the five fixed PNG
   filters, a minimum-signed-sum per-row choice, a fewest-distinct-byte-
   pairs per-row choice, and a brute-force per-row choice that actually
   deflates each row's five candidates against the 32 KiB of filtered data
   written before it and keeps the cheapest. Each candidate is weighed by
   a real zlib deflate at level 6, plus its PLTE/tRNS chunk overhead.
4. **Re-deflate** the winner at level 9 (default and filtered strategies)
   and write it as a single IDAT chunk.

## Properties

- Deterministic: fixed work per image, no clock, no randomness, no
  environment-dependent branching — two runs write byte-identical files.
- Node 22 standard library only, no installs, no network.
- Output is always bit depth 8, not interlaced, colour type 0/2/3/4/6,
  with only IHDR, PLTE (type 3 only), tRNS, IDAT and IEND chunks, each
  CRC correct, IDAT a single zlib stream.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/image.png` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/image.png` (or `$MAKEFUN_OUTPUT_DIR`), creating each
output directory. A full 8-instance run takes well under the 60 s wall
budget.

## Licence

MIT — see LICENSE.
