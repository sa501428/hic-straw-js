import {ZSTDDecoder} from 'zstddec'
import {requireV10} from './binary.js'

let decoderPromise

async function getDecoder() {
    if (!decoderPromise) {
        const decoder = new ZSTDDecoder()
        // hdf5-indexed-reader currently replaces Node's global fetch function
        // with the node-fetch module namespace when loaded through CommonJS.
        // zstddec tests the global directly while initializing its embedded
        // WebAssembly, so expose the namespace's default function just for the
        // synchronous portion of init().
        const originalFetch = globalThis.fetch
        if (typeof originalFetch !== 'function' && typeof originalFetch?.default === 'function') {
            globalThis.fetch = originalFetch.default
        }
        try {
            decoderPromise = decoder.init().then(() => decoder)
        } finally {
            globalThis.fetch = originalFetch
        }
    }
    return decoderPromise
}

function readLittleEndian(bytes, position, length) {
    requireV10(position + length <= bytes.length, 'truncated Zstandard frame header')
    let result = 0
    for (let i = 0; i < length; i++) result += bytes[position + i] * (2 ** (8 * i))
    return result
}

function validateSingleFrame(bytes) {
    requireV10(bytes.length >= 6, 'truncated Zstandard frame')
    requireV10(bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd,
        'matrix/vector payload is not a Zstandard data frame')

    let at = 4
    const descriptor = bytes[at++]
    requireV10((descriptor & 0x08) === 0, 'Zstandard frame uses a reserved header bit')
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    const contentSizeFlag = descriptor >>> 6
    if (!singleSegment) at++ // window descriptor

    const dictSize = [0, 1, 2, 4][dictFlag]
    const dictionaryId = dictSize ? readLittleEndian(bytes, at, dictSize) : 0
    at += dictSize
    requireV10(dictionaryId === 0, 'Zstandard preset dictionaries are forbidden')

    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0)
        : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8
    requireV10(at + contentSizeBytes <= bytes.length, 'truncated Zstandard frame header')
    at += contentSizeBytes

    let last = false
    while (!last) {
        requireV10(at + 3 <= bytes.length, 'truncated Zstandard block header')
        const header = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
        at += 3
        last = (header & 1) !== 0
        const type = (header >>> 1) & 3
        const size = header >>> 3
        requireV10(type !== 3, 'Zstandard frame contains a reserved block type')
        const storedSize = type === 1 ? 1 : size
        requireV10(at + storedSize <= bytes.length, 'truncated Zstandard block')
        at += storedSize
    }
    if (checksum) {
        requireV10(at + 4 <= bytes.length, 'truncated Zstandard content checksum')
        at += 4
    }
    requireV10(at === bytes.length, 'concatenated Zstandard frames or trailing bytes are forbidden')
}

async function decompressZstd(bytes, expectedLength, maxLength = 512 * 1024 * 1024) {
    requireV10(Number.isSafeInteger(expectedLength) && expectedLength > 0 && expectedLength <= maxLength,
        'invalid or excessive decompressed length')
    validateSingleFrame(bytes)
    const decoder = await getDecoder()
    let result
    try {
        result = decoder.decode(bytes, expectedLength)
    } catch (error) {
        throw new Error(`Zstandard decompression failed: ${error.message}`)
    }
    requireV10(result.length === expectedLength, 'Zstandard decompressed length mismatch')
    return result
}

export {decompressZstd, validateSingleFrame}
