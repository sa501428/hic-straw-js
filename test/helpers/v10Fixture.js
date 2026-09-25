class Writer {
    constructor(size = 0) { this.bytes = new Uint8Array(size) }
    get length() { return this.bytes.length }
    append(value) {
        const input = value instanceof Uint8Array ? value : new Uint8Array(value)
        const result = new Uint8Array(this.bytes.length + input.length)
        result.set(this.bytes)
        result.set(input, this.bytes.length)
        this.bytes = result
        return this
    }
    u8(value) { return this.append([value]) }
    u16(value) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value, true); return this.append(b) }
    u32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value, true); return this.append(b) }
    u64(value) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(value), true); return this.append(b) }
    f32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value, true); return this.append(b) }
    f64(value) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, value, true); return this.append(b) }
    magic(value) { return this.append(new TextEncoder().encode(value)) }
    cstr(value) { return this.append(new TextEncoder().encode(value)).u8(0) }
    patchU32(position, value) { new DataView(this.bytes.buffer).setUint32(position, value, true) }
    patchU64(position, value) { new DataView(this.bytes.buffer).setBigUint64(position, BigInt(value), true) }
}

function varint(input) {
    let value = BigInt(input)
    const bytes = []
    while (value >= 128n) {
        bytes.push(Number(value & 127n) | 128)
        value >>= 7n
    }
    bytes.push(Number(value))
    return new Uint8Array(bytes)
}

// An independent, uncompressed-block Zstandard frame encoder. V10 readers must
// accept raw blocks; keeping this here avoids testing the decoder with itself.
function zstdRawFrame(input) {
    if (input.length > 255) throw new Error('fixture raw frame must be <=255 bytes')
    const header = (input.length << 3) | 1
    return new Uint8Array([
        0x28, 0xb5, 0x2f, 0xfd, // frame magic
        0x20, input.length,      // single segment, one-byte content size
        header & 255, (header >>> 8) & 255, (header >>> 16) & 255,
        ...input
    ])
}

function floatBits(value) {
    const buffer = new ArrayBuffer(4)
    const view = new DataView(buffer)
    view.setFloat32(0, value, true)
    return view.getUint32(0, true)
}

function logicalBlock({representation = 0, mode = 2, counts = [1n, 1n, 5n], score = false}) {
    const positions = [0, 9, 15]
    const position = new Writer()
    if (representation === 0) {
        position.append(varint(positions[0])).append(varint(positions[1] - positions[0]))
            .append(varint(positions[2] - positions[1]))
    } else if (representation === 1 || (representation === 2 && score)) {
        const bitmap = (1 << positions[0]) | (1 << positions[1]) | (1 << positions[2])
        position.u16(bitmap)
    }
    const values = new Writer()
    const encoded = score ? counts.map(floatBits) : counts
    const scalar = value => score ? values.u32(value) : values.append(varint(value))
    if (representation === 2) {
        const dense = new Array(16).fill(score ? 0 : 0n)
        positions.forEach((position, i) => dense[position] = encoded[i])
        dense.forEach(scalar)
    } else if (mode === 0) {
        scalar(encoded[0])
    } else if (mode === 1) {
        scalar(encoded[0])
        values.append(varint(1)).append(varint(2))
        scalar(encoded[2])
    } else encoded.forEach(scalar)

    const block = new Writer()
    block.u8(1).u8(representation).u8(mode).u8(score ? 1 : 0)
        .u8(representation === 1 || (representation === 2 && score) ? 1 : 0).append(new Uint8Array(3))
        .u32(0).u32(0).u32(4).u32(4).u64(3)
        .u32(position.length).u32(values.length).append(position.bytes).append(values.bytes)
    return block.bytes
}

function resolution(writer, binSize, mode, source) {
    writer.u32(binSize).u8(mode).u8(mode ? 1 : 1).u16(0).u32(source)
}

function descriptor({derived, resolutionIndex, binSize, sum, indexPosition, indexLength, score = false,
    unit = 0, grid = 1}) {
    const writer = new Writer()
    writer.u8(unit).u8(derived ? 1 : 0).u8(1).u8(score ? 1 : 0)
        .u32(resolutionIndex).u32(binSize).u32(derived ? 0 : 0xffffffff)
        .u8(grid).append(new Uint8Array(3))
    if (score) writer.f64(sum)
    else writer.u64(sum)
    writer.u64(3)
        .u32(0x7fc00000).u32(0x7fc00000).u32(4).u32(derived ? 1 : 2)
        .u64(derived ? 0 : indexPosition).u64(derived ? 0 : indexLength)
        .u32(derived ? 0 : 1).u32(0)
    if (writer.length !== 76) throw new Error(`descriptor length ${writer.length}`)
    return writer.bytes
}

function vectorChunk(values, transform = 0) {
    const raw = new Uint8Array(values.length * 4)
    const view = new DataView(raw.buffer)
    values.forEach((value, i) => view.setFloat32(i * 4, value, true))
    let transformed = raw
    if (transform === 1) {
        transformed = new Uint8Array(raw.length)
        for (let lane = 0; lane < 4; lane++) for (let i = 0; i < values.length; i++) {
            transformed[lane * values.length + i] = raw[i * 4 + lane]
        }
    } else if (transform === 2) {
        transformed = new Uint8Array(raw.length)
        const out = new DataView(transformed.buffer)
        let previous = 0
        for (let i = 0; i < values.length; i++) {
            const bits = view.getUint32(i * 4, true)
            out.setUint32(i * 4, i ? (bits ^ previous) >>> 0 : bits, true)
            previous = bits
        }
    }
    const frame = zstdRawFrame(transformed)
    return new Writer().magic('H10V').u8(1).u8(transform).u16(0).u32(raw.length).u32(values.length)
        .append(frame).bytes
}

function createV10Fixture({representation = 0, mode = 2, counts = [1n, 1n, 5n], transform = 0,
    oldIndex = false, score = false, frag = false, trans = false, expected = false} = {}) {
    const variable = new Writer()
    variable.cstr('test').u32(2).cstr('duplicate').cstr('one').cstr('duplicate').cstr('two')
        .u32(2).cstr('chrA').u64(80).cstr('chrB').u64(70)
        .u32(2)
    resolution(variable, 10, 0, 0xffffffff)
    resolution(variable, 20, 1, 0)
    variable.u32(frag ? 1 : 0)
    if (frag) {
        resolution(variable, 1, 0, 0xffffffff)
        for (let chr = 0; chr < 2; chr++) {
            variable.u32(7)
            for (let site = 5; site <= 65; site += 10) variable.u64(site)
        }
    }
    variable.u32(1).cstr('VC')

    const file = new Writer(88).append(variable.bytes)
    const matrixPosition = file.length
    const descriptorCount = 2 + (frag ? 1 : 0)
    file.magic('H10M').u32(1).u32(0).u32(trans ? 1 : 0).u32(descriptorCount).u32(0)
        .append(new Uint8Array(76 * descriptorCount))

    const logical = logicalBlock({representation, mode, counts, score})
    const stored = new Writer().magic('H10B').u8(1).u8(1).u16(0).u32(logical.length).u32(0)
        .append(zstdRawFrame(logical)).bytes
    const blockPosition = file.length
    file.append(stored)

    const indexPosition = file.length
    const index = new Writer().magic('H10I').u32(oldIndex ? 1 : 2).u64(40).u32(1).u32(0)
        .u32(0).u32(stored.length).u64(blockPosition).bytes
    file.append(index)

    const sum = counts.reduce((a, b) => a + b, score ? 0 : 0n)
    const descriptors = new Writer()
        .append(descriptor({derived: false, resolutionIndex: 0, binSize: 10, sum,
            indexPosition, indexLength: index.length, score, grid: trans ? 0 : 1}))
        .append(descriptor({derived: true, resolutionIndex: 1, binSize: 20, sum,
            indexPosition: 0, indexLength: 0, score, grid: trans ? 0 : 1}))
    if (frag) descriptors.append(descriptor({derived: false, resolutionIndex: 0, binSize: 1, sum,
        indexPosition, indexLength: index.length, score, unit: 1, grid: trans ? 0 : 1}))
    file.bytes.set(descriptors.bytes, matrixPosition + 24)

    const chunks = []
    for (const value of [2, 4]) {
        const count = value === 2 ? 8 : 4
        const chunk = vectorChunk(new Array(count).fill(value), transform)
        const position = file.length
        file.append(chunk)
        chunks.push({position, stored: chunk.length, count})
    }
    const normPosition = file.length
    const norm = new Writer().magic('NVI0').u32(1).u32(2).u32(0)
    chunks.forEach((chunk, ri) => {
        norm.u32(72).u32(0).u32(0).u8(0).append(new Uint8Array(3)).u32(ri).u32(10 * (ri + 1))
            .u64(chunk.count).u32(65536).u32(1)
            .u64(0).u32(chunk.count).u8(transform).u8(1).u16(0).u64(chunk.position)
            .u32(chunk.stored).u32(chunk.count * 4)
    })
    file.append(norm.bytes)

    let expectedPosition = 0
    let expectedLength = 0
    let normExpectedPosition = 0
    let normExpectedLength = 0
    if (expected) {
        const rawExpectedChunks = []
        const normalizedExpectedChunks = []
        for (const count of [8, 4]) {
            const rawChunk = vectorChunk(Array.from({length: count}, (_, i) => 10 * (i + 1)), transform)
            const rawPosition = file.length
            file.append(rawChunk)
            rawExpectedChunks.push({position: rawPosition, stored: rawChunk.length, count})
            const normalizedChunk = vectorChunk(Array.from({length: count}, (_, i) => 8 * (i + 1)), transform)
            const normalizedPosition = file.length
            file.append(normalizedChunk)
            normalizedExpectedChunks.push({position: normalizedPosition, stored: normalizedChunk.length, count})
        }
        const appendExpectedEntry = (writer, chunk, ri, normalized) => {
            writer.u32(normalized ? 84 : 80)
            if (normalized) writer.u32(0)
            writer.u8(0).append(new Uint8Array(3)).u32(ri).u32(10 * (ri + 1))
                .u64(chunk.count).u32(65536).u32(1).u32(1).u32(0)
                .u32(0).f32(2)
                .u64(0).u32(chunk.count).u8(transform).u8(1).u16(0).u64(chunk.position)
                .u32(chunk.stored).u32(chunk.count * 4)
        }
        expectedPosition = file.length
        const expectedIndex = new Writer().magic('EVI0').u32(1).u32(2).u32(0)
        rawExpectedChunks.forEach((chunk, ri) => appendExpectedEntry(expectedIndex, chunk, ri, false))
        file.append(expectedIndex.bytes)
        expectedLength = expectedIndex.length

        normExpectedPosition = file.length
        const normExpectedIndex = new Writer().magic('NEVI').u32(1).u32(2).u32(0)
        normalizedExpectedChunks.forEach((chunk, ri) => appendExpectedEntry(normExpectedIndex, chunk, ri, true))
        file.append(normExpectedIndex.bytes)
        normExpectedLength = normExpectedIndex.length
    }

    const footerPosition = file.length
    const matrixLength = 24 + 76 * descriptorCount
    const footer = new Writer().magic('H10F').u32(1).u64(48).u32(1).u32(0)
        .u32(0).u32(trans ? 1 : 0).u64(matrixPosition).u64(matrixLength).bytes
    file.append(footer)

    const fixed = new Writer().magic('HIC\0').u32(10).u64(88 + variable.length)
        .u64(footerPosition).u64(footer.length)
        .u64(normPosition).u64(norm.length)
        .u64(expectedPosition).u64(expectedLength).u64(normExpectedPosition).u64(normExpectedLength)
        .u32(0).u32(0).bytes
    file.bytes.set(fixed, 0)
    return file.bytes
}

class MemoryFile {
    constructor(bytes) { this.bytes = bytes }
    async read(position, length) {
        const slice = this.bytes.slice(position, position + length)
        return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
    }
    async getSize() { return this.bytes.length }
}

export {MemoryFile, createV10Fixture}
