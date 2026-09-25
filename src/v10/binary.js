const UINT64_MAX = (1n << 64n) - 1n
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

class V10FormatError extends Error {
    constructor(message) {
        super(`Invalid .hic v10 file: ${message}`)
        this.name = 'V10FormatError'
        this.code = 'HIC_V10_FORMAT_ERROR'
    }
}

function requireV10(condition, message) {
    if (!condition) throw new V10FormatError(message)
}

function toSafeNumber(value, name = 'value') {
    requireV10(typeof value === 'bigint' && value >= 0n && value <= MAX_SAFE_BIGINT,
        `${name} exceeds the JavaScript safe integer range`)
    return Number(value)
}

function checkedAdd(a, b, name = 'unsigned 64-bit addition') {
    const result = a + b
    requireV10(result <= UINT64_MAX, `${name} overflow`)
    return result
}

function checkedMultiply(a, b, name = 'unsigned 64-bit multiplication') {
    const result = a * b
    requireV10(result <= UINT64_MAX, `${name} overflow`)
    return result
}

function checkedNumberAdd(a, b, name = 'safe integer addition') {
    requireV10(Number.isSafeInteger(a) && a >= 0 && Number.isSafeInteger(b) && b >= 0 &&
        a <= Number.MAX_SAFE_INTEGER - b, `${name} overflow`)
    return a + b
}

class V10Cursor {
    constructor(data, label = 'record') {
        this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
        this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
        this.position = 0
        this.label = label
    }

    get length() { return this.bytes.byteLength }
    get available() { return this.length - this.position }

    need(length) {
        requireV10(Number.isSafeInteger(length) && length >= 0 && length <= this.available,
            `${this.label} is truncated`)
    }

    u8() {
        this.need(1)
        return this.bytes[this.position++]
    }

    u16() {
        this.need(2)
        const value = this.view.getUint16(this.position, true)
        this.position += 2
        return value
    }

    u32() {
        this.need(4)
        const value = this.view.getUint32(this.position, true)
        this.position += 4
        return value
    }

    u64() {
        this.need(8)
        const value = this.view.getBigUint64(this.position, true)
        this.position += 8
        return value
    }

    f32() {
        this.need(4)
        const value = this.view.getFloat32(this.position, true)
        this.position += 4
        return value
    }

    f64() {
        this.need(8)
        const value = this.view.getFloat64(this.position, true)
        this.position += 8
        return value
    }

    uleb128() {
        let value = 0n
        let shift = 0n
        let count = 0
        let byte
        do {
            requireV10(count < 10, 'ULEB128 is longer than 10 bytes')
            byte = this.u8()
            const payload = BigInt(byte & 0x7f)
            requireV10(shift < 63n || payload <= 1n, 'ULEB128 overflows uint64')
            value |= payload << shift
            shift += 7n
            count++
        } while (byte & 0x80)
        requireV10(value <= UINT64_MAX, 'ULEB128 overflows uint64')
        requireV10(count === 1 || value >= (1n << BigInt(7 * (count - 1))), 'non-canonical ULEB128')
        return value
    }

    magic(expected) {
        const encoded = new TextEncoder().encode(expected)
        this.need(encoded.length)
        for (let i = 0; i < encoded.length; i++) {
            requireV10(this.bytes[this.position + i] === encoded[i],
                `${this.label} has invalid magic; expected ${JSON.stringify(expected)}`)
        }
        this.position += encoded.length
    }

    zero(length) {
        this.need(length)
        for (let i = 0; i < length; i++) {
            requireV10(this.bytes[this.position + i] === 0, `${this.label} has nonzero reserved bytes`)
        }
        this.position += length
    }

    cstr(maxLength = 1024 * 1024) {
        const start = this.position
        const limit = Math.min(this.length, start + maxLength + 1)
        while (this.position < limit && this.bytes[this.position] !== 0) this.position++
        requireV10(this.position < this.length && this.bytes[this.position] === 0,
            `${this.label} contains an unterminated or oversized string`)
        const raw = this.bytes.subarray(start, this.position++)
        try {
            return new TextDecoder('utf-8', {fatal: true}).decode(raw)
        } catch (error) {
            throw new V10FormatError(`${this.label} contains invalid UTF-8`)
        }
    }

    take(length, label = this.label) {
        this.need(length)
        const result = new V10Cursor(this.bytes.subarray(this.position, this.position + length), label)
        this.position += length
        return result
    }

    skip(length) {
        this.need(length)
        this.position += length
    }

    done() {
        requireV10(this.position === this.length, `${this.label} has trailing bytes`)
    }
}

function floatFromBits(bits) {
    const buffer = new ArrayBuffer(4)
    const view = new DataView(buffer)
    view.setUint32(0, bits >>> 0, true)
    return view.getFloat32(0, true)
}

export {
    MAX_SAFE_BIGINT,
    UINT64_MAX,
    V10Cursor,
    V10FormatError,
    checkedAdd,
    checkedMultiply,
    checkedNumberAdd,
    floatFromBits,
    requireV10,
    toSafeNumber
}
