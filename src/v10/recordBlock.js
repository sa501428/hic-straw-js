const MAX_SAFE_COUNT = BigInt(Number.MAX_SAFE_INTEGER)

/** Packed immutable-after-decoding source records: 16 bytes per occupied cell. */
class RecordBlock {
    constructor(capacity, valueType, wideCoordinates = false) {
        const Coordinates = wideCoordinates ? Float64Array : Uint32Array
        this.x = new Coordinates(capacity)
        this.y = new Coordinates(capacity)
        this.values = new Float64Array(capacity)
        this.valueType = valueType
        this.wideCounts = false
        this.maxValue = 0
        this.length = 0
        this.minX = this.minY = Infinity
        this.maxX = this.maxY = -1
    }

    get byteLength() { return this.x.byteLength + this.y.byteLength + this.values.byteLength }

    push(record) {
        const i = this.length++
        this.x[i] = record.bin1
        this.y[i] = record.bin2
        if (this.valueType === 0) {
            if (!this.wideCounts && record.value > MAX_SAFE_COUNT) {
                const exact = new BigUint64Array(this.values.length)
                for (let j = 0; j < i; j++) exact[j] = BigInt(this.values[j])
                this.values = exact
                this.wideCounts = true
            }
            if (this.wideCounts) this.values[i] = BigInt(record.value)
            else {
                this.values[i] = Number(record.value)
                this.maxValue = Math.max(this.maxValue, this.values[i])
            }
        } else this.values[i] = record.value
        this.minX = Math.min(this.minX, record.bin1)
        this.maxX = Math.max(this.maxX, record.bin1)
        this.minY = Math.min(this.minY, record.bin2)
        this.maxY = Math.max(this.maxY, record.bin2)
    }

    countAt(i) { return this.wideCounts ? this.values[i] : BigInt(this.values[i]) }

    recordAt(i) {
        return {bin1: this.x[i], bin2: this.y[i], value: this.valueType === 0 ? this.countAt(i) : this.values[i], valueType: this.valueType}
    }

    *[Symbol.iterator]() {
        for (let i = 0; i < this.length; i++) yield this.recordAt(i)
    }

    map(callback) {
        const result = new Array(this.length)
        for (let i = 0; i < this.length; i++) result[i] = callback(this.recordAt(i), i)
        return result
    }
}

/** LRU bounded by both entries and retained bytes; oversized items are not cached. */
class ByteCache {
    constructor(maxEntries, maxBytes) {
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
            throw new Error('V10 cache limits must be nonnegative safe integers')
        }
        this.maxEntries = maxEntries
        this.maxBytes = maxBytes
        this.bytes = 0
        this.map = new Map()
    }

    has(key) { return this.map.has(key) }

    get(key) {
        const value = this.map.get(key)
        if (value !== undefined) {
            this.map.delete(key)
            this.map.set(key, value)
        }
        return value
    }

    set(key, value) {
        if (this.map.has(key)) {
            this.bytes -= this.map.get(key).byteLength
            this.map.delete(key)
        }
        if (!this.maxEntries || value.byteLength > this.maxBytes) return
        while (this.map.size && (this.map.size >= this.maxEntries || this.bytes + value.byteLength > this.maxBytes)) {
            const oldest = this.map.keys().next().value
            this.bytes -= this.map.get(oldest).byteLength
            this.map.delete(oldest)
        }
        this.map.set(key, value)
        this.bytes += value.byteLength
    }

    clear() { this.map.clear(); this.bytes = 0 }
}

export {RecordBlock, ByteCache}
