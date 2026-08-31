import { inflateSync } from 'node:zlib'
import { SCREENSHOT_ARTIFACT_MAX_BYTES } from '@devhotel/shared'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_SCREENSHOT_DIMENSION = 8192
const MAX_SCREENSHOT_PIXELS = 16_000_000
const MAX_INFLATED_BYTES = 80 * 1024 * 1024

export interface ValidatedScreenshotPng {
  png: Buffer
  width: number
  height: number
  orientation: 'portrait' | 'landscape' | 'square'
}

const CRC_TABLE = new Uint32Array(256)
for (let value = 0; value < CRC_TABLE.length; value++) {
  let current = value
  for (let bit = 0; bit < 8; bit++) {
    current = (current & 1) !== 0 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
  }
  CRC_TABLE[value] = current >>> 0
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function bitsPerPixel(colorType: number, bitDepth: number): number {
  switch (colorType) {
    case 0:
      if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error('PNG grayscale bit depth is invalid')
      return bitDepth
    case 2:
      if (![8, 16].includes(bitDepth)) throw new Error('PNG RGB bit depth is invalid')
      return 3 * bitDepth
    case 3:
      if (![1, 2, 4, 8].includes(bitDepth)) throw new Error('PNG palette bit depth is invalid')
      return bitDepth
    case 4:
      if (![8, 16].includes(bitDepth)) throw new Error('PNG grayscale-alpha bit depth is invalid')
      return 2 * bitDepth
    case 6:
      if (![8, 16].includes(bitDepth)) throw new Error('PNG RGBA bit depth is invalid')
      return 4 * bitDepth
    default:
      throw new Error('PNG color type is invalid')
  }
}

/**
 * Validate screenshot bytes before persistence and remove non-visual metadata.
 * Android screenshots need pixels, palette/transparency and nothing else;
 * textual/EXIF/profile chunks could otherwise smuggle arbitrary device data.
 */
export function validateAndSanitizeScreenshotPng(input: Uint8Array): ValidatedScreenshotPng {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (bytes.byteLength < 45 || bytes.byteLength > SCREENSHOT_ARTIFACT_MAX_BYTES) {
    throw new Error(`Screenshot PNG must be between 45 and ${SCREENSHOT_ARTIFACT_MAX_BYTES} bytes`)
  }
  if (!bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new Error('Screenshot is not a PNG')

  let offset = SIGNATURE.length
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = -1
  let sawHeader = false
  let sawPalette = false
  let paletteEntries = 0
  let sawTransparency = false
  let sawImageData = false
  let endedImageData = false
  let sawEnd = false
  const kept: Buffer[] = [SIGNATURE]
  const compressed: Buffer[] = []

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error('PNG chunk header is truncated')
    const length = bytes.readUInt32BE(offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4
    if (dataEnd < dataStart || chunkEnd > bytes.length) throw new Error('PNG chunk is truncated')
    const typeBytes = bytes.subarray(offset + 4, offset + 8)
    const type = typeBytes.toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('PNG chunk type is invalid')
    const expectedCrc = bytes.readUInt32BE(dataEnd)
    const actualCrc = crc32(bytes.subarray(offset + 4, dataEnd))
    if (actualCrc !== expectedCrc) throw new Error(`PNG ${type} checksum does not match`)
    const rawChunk = bytes.subarray(offset, chunkEnd)
    const data = bytes.subarray(dataStart, dataEnd)

    if (!sawHeader && type !== 'IHDR') throw new Error('PNG IHDR must be first')
    if (sawEnd) throw new Error('PNG contains data after IEND')
    if (sawImageData && type !== 'IDAT' && type !== 'IEND') endedImageData = true

    switch (type) {
      case 'IHDR': {
        if (sawHeader || length !== 13) throw new Error('PNG IHDR is invalid')
        width = data.readUInt32BE(0)
        height = data.readUInt32BE(4)
        bitDepth = data[8] ?? 0
        colorType = data[9] ?? -1
        const compression = data[10]
        const filter = data[11]
        const interlace = data[12]
        if (
          width < 1 ||
          height < 1 ||
          width > MAX_SCREENSHOT_DIMENSION ||
          height > MAX_SCREENSHOT_DIMENSION ||
          width * height > MAX_SCREENSHOT_PIXELS
        ) throw new Error('PNG screenshot dimensions are outside the safe limit')
        bitsPerPixel(colorType, bitDepth)
        if (compression !== 0 || filter !== 0 || interlace !== 0) {
          throw new Error('PNG screenshot compression, filter or interlace method is unsupported')
        }
        sawHeader = true
        kept.push(rawChunk)
        break
      }
      case 'PLTE':
        if (!sawHeader || sawPalette || sawImageData || length === 0 || length % 3 !== 0 || length > 768) {
          throw new Error('PNG palette is invalid')
        }
        if (colorType === 3 && length / 3 > 2 ** bitDepth) throw new Error('PNG palette exceeds its bit depth')
        sawPalette = true
        paletteEntries = length / 3
        kept.push(rawChunk)
        break
      case 'tRNS':
        if (!sawHeader || sawTransparency || sawImageData) throw new Error('PNG transparency chunk is invalid')
        if (
          (colorType === 0 && length !== 2) ||
          (colorType === 2 && length !== 6) ||
          (colorType === 3 && (!sawPalette || length < 1 || length > paletteEntries)) ||
          colorType === 4 ||
          colorType === 6
        ) throw new Error('PNG transparency chunk does not match its color type')
        sawTransparency = true
        kept.push(rawChunk)
        break
      case 'IDAT':
        if (!sawHeader || endedImageData || length === 0) throw new Error('PNG image data is invalid')
        sawImageData = true
        compressed.push(data)
        kept.push(rawChunk)
        break
      case 'IEND':
        if (!sawHeader || !sawImageData || length !== 0 || chunkEnd !== bytes.length) {
          throw new Error('PNG IEND is invalid')
        }
        sawEnd = true
        kept.push(rawChunk)
        break
      default:
        // Unknown critical chunks change how pixels must be decoded and cannot
        // be discarded safely. Ancillary chunks are deliberately stripped.
        if ((typeBytes[0] ?? 0) >= 0x41 && (typeBytes[0] ?? 0) <= 0x5a) {
          throw new Error(`PNG critical chunk ${type} is unsupported`)
        }
    }
    offset = chunkEnd
  }

  if (!sawHeader || !sawImageData || !sawEnd) throw new Error('PNG is incomplete')
  if (colorType === 3 && !sawPalette) throw new Error('PNG palette image has no palette')
  if ((colorType === 0 || colorType === 4) && sawPalette) throw new Error('PNG grayscale image cannot contain a palette')

  const rowBytes = Math.ceil((width * bitsPerPixel(colorType, bitDepth)) / 8)
  const expectedInflated = (rowBytes + 1) * height
  if (!Number.isSafeInteger(expectedInflated) || expectedInflated > MAX_INFLATED_BYTES) {
    throw new Error('PNG decoded size is outside the safe limit')
  }
  const compressedBytes = Buffer.concat(compressed)
  let inflated: Buffer
  try {
    const result = inflateSync(compressedBytes, {
      info: true,
      maxOutputLength: expectedInflated
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
    inflated = result.buffer
    if (result.engine.bytesWritten !== compressedBytes.byteLength) {
      throw new Error('PNG image data contains trailing compressed bytes')
    }
  } catch {
    throw new Error('PNG image data could not be decoded within the safe limit')
  }
  if (inflated.length !== expectedInflated) throw new Error('PNG decoded length does not match its dimensions')
  for (let row = 0; row < height; row++) {
    const filter = inflated[row * (rowBytes + 1)] ?? 0xff
    if (filter > 4) throw new Error('PNG row filter is invalid')
  }

  return {
    png: Buffer.concat(kept),
    width,
    height,
    orientation: height > width ? 'portrait' : width > height ? 'landscape' : 'square'
  }
}
