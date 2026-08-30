import { deflateSync } from 'node:zlib'

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const crcTable = new Uint32Array(256)
for (let value = 0; value < crcTable.length; value++) {
  let current = value
  for (let bit = 0; bit < 8; bit++) {
    current = (current & 1) !== 0 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
  }
  crcTable[value] = current >>> 0
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const output = Buffer.alloc(12 + data.byteLength)
  output.writeUInt32BE(data.byteLength, 0)
  typeBytes.copy(output, 4)
  Buffer.from(data).copy(output, 8)
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
  return output
}

export function screenshotPng(
  width = 2,
  height = 3,
  opts: { text?: string; filter?: number; idatSuffix?: Uint8Array } = {}
): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let row = 0; row < height; row++) rows[row * (width * 4 + 1)] = opts.filter ?? 0
  const optional = opts.text ? [chunk('tEXt', Buffer.from(`note\0${opts.text}`, 'utf8'))] : []
  const imageData = deflateSync(rows)
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    ...optional,
    chunk('IDAT', opts.idatSuffix ? Buffer.concat([imageData, opts.idatSuffix]) : imageData),
    chunk('IEND', Buffer.alloc(0))
  ])
}
