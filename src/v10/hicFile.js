import ContactRecord from '../contactRecord.js'
import LRU from '../lru.js'
import {MAX_SAFE_BIGINT, UINT64_MAX, V10Cursor, checkedAdd, checkedNumberAdd, floatFromBits, requireV10,
    toSafeNumber} from './binary.js'
import {decompressZstd} from './zstd.js'

const BP = 0
const FRAG = 1
const MATERIALIZED = 0
const DERIVED = 1
const COUNT_UINT = 0
const SCORE_FLOAT32 = 1
const RECTANGULAR = 0
const ROTATED_CIS = 1
const SPARSE_DELTA = 0
const BITMAP = 1
const DENSE = 2
const ALL_DEFAULT = 0
const DEFAULT_EXCEPTIONS = 1
const DIRECT = 2
const NO_SOURCE = 0xffffffff

function unitId(unit) {
    requireV10(unit === 'BP' || unit === 'FRAG', `unknown unit ${unit}`)
    return unit === 'FRAG' ? FRAG : BP
}

function unitName(unit) {
    return unit === FRAG ? 'FRAG' : 'BP'
}

function locator(cursor, name) {
    const positionBig = cursor.u64()
    const lengthBig = cursor.u64()
    requireV10((positionBig === 0n) === (lengthBig === 0n), `${name} has an incomplete locator`)
    return {
        position: toSafeNumber(positionBig, `${name} position`),
        length: toSafeNumber(lengthBig, `${name} length`)
    }
}

function locatorPresent(value) {
    return value.position !== 0 && value.length !== 0
}

function compareKeys(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    }
    return 0
}

function lowerBound(entries, blockNumber) {
    let lo = 0
    let hi = entries.length
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (entries[mid].blockNumber < blockNumber) lo = mid + 1
        else hi = mid
    }
    return lo
}

function depthForDistance(distance, blockBinCount) {
    const d = BigInt(distance)
    const b = BigInt(blockBinCount)
    const quotient = (d * d) / (2n * b * b)
    let depth = 0
    while (depth < 32) {
        const threshold = (1n << BigInt(depth + 1)) - 1n
        if (threshold * threshold > quotient) break
        depth++
    }
    return depth
}

function blockNumberForCell(binColumn, binRow, zoom) {
    let result
    if (zoom.gridType === RECTANGULAR) {
        result = Math.floor(binRow / zoom.blockBinCount) * zoom.blockColumnCount +
            Math.floor(binColumn / zoom.blockBinCount)
    } else {
        const depth = depthForDistance(Math.abs(binRow - binColumn), zoom.blockBinCount)
        const pad = Math.floor((binColumn + binRow) / (2 * zoom.blockBinCount))
        result = depth * zoom.blockColumnCount + pad
    }
    requireV10(Number.isSafeInteger(result) && result >= 0 && result <= 0xffffffff,
        'logical block number exceeds uint32')
    return result
}

function candidateBlockRanges(zoom, x0, x1, y0, y1) {
    if (x0 >= x1 || y0 >= y1) return []
    const ranges = []
    const b = zoom.blockBinCount
    if (zoom.gridType === RECTANGULAR) {
        const firstColumn = Math.floor(x0 / b)
        const lastColumn = Math.floor((x1 - 1) / b)
        const firstRow = Math.floor(y0 / b)
        const lastRow = Math.floor((y1 - 1) / b)
        for (let row = firstRow; row <= lastRow; row++) {
            ranges.push({first: row * zoom.blockColumnCount + firstColumn,
                last: row * zoom.blockColumnCount + lastColumn})
        }
    } else {
        const lastX = x1 - 1
        const lastY = y1 - 1
        let nearest = 0
        if (x1 <= y0) nearest = y0 - lastX
        else if (y1 <= x0) nearest = x0 - lastY
        const farthest = Math.max(Math.abs(lastY - x0), Math.abs(lastX - y0))
        const firstDepth = depthForDistance(nearest, b)
        const lastDepth = depthForDistance(farthest, b)
        const firstPad = Math.floor((x0 + y0) / (2 * b))
        const lastPad = Math.floor((lastX + lastY) / (2 * b))
        for (let depth = firstDepth; depth <= lastDepth; depth++) {
            ranges.push({first: depth * zoom.blockColumnCount + firstPad,
                last: depth * zoom.blockColumnCount + lastPad})
        }
    }
    for (const range of ranges) {
        requireV10(range.first >= 0 && range.last >= range.first && range.last <= 0xffffffff,
            'candidate block range exceeds uint32')
    }
    return ranges
}

class V10Matrix {
    constructor(chr1, chr2, descriptors, bpCount) {
        this.chr1 = chr1
        this.chr2 = chr2
        this.descriptors = descriptors
        this.bpZoomData = descriptors.slice(0, bpCount)
        this.fragZoomData = descriptors.slice(bpCount)
    }

    getZoomData(binSize, unit = 'BP') {
        return (unit === 'FRAG' ? this.fragZoomData : this.bpZoomData)
            .find(value => value.binSize === binSize)
    }

    getZoomDataByIndex(index, unit = 'BP') {
        return (unit === 'FRAG' ? this.fragZoomData : this.bpZoomData)[index]
    }

    findZoomForResolution(binSize, unit = 'BP') {
        const values = unit === 'FRAG' ? this.fragZoomData : this.bpZoomData
        // V10 descriptors are ordered from finest to coarsest. Choose the first
        // available bin that is at least as coarse as the requested resolution.
        for (let i = 0; i < values.length; i++) {
            if (values[i].binSize >= binSize) return i
        }
        return values.length - 1
    }
}

class V10NormalizationVector {
    constructor(reader, entry) {
        this.reader = reader
        this.entry = entry
        this.nValues = entry.valueCount
    }

    async getValues(start, end) {
        return this.reader._readVectorValues(this.entry, start, end)
    }
}

class V10ExpectedVector {
    constructor(reader, entry, scale) {
        this.reader = reader
        this.entry = entry
        this.nValues = entry.valueCount
        this.scale = scale
    }

    async getValues(start = 0, end = this.nValues) {
        const values = await this.reader._readVectorValues(this.entry, start, end)
        return values.map(value => value / this.scale)
    }
}

class V10HicFile {
    constructor(config) {
        this.config = config
        this.file = config.file
        this.version = 10
        this.magic = 'HIC'
        this.matrixCache = new Map()
        this.blockIndexCache = new Map()
        this.blockCache = new LRU(config.v10BlockCacheSize || 24)
        this.vectorChunkCache = new LRU(config.v10VectorChunkCacheSize || 12)
        this.maxRecordBytes = config.v10MaxRecordBytes || 512 * 1024 * 1024
    }

    async _read(position, length) {
        requireV10(Number.isSafeInteger(position) && position >= 0 && Number.isSafeInteger(length) && length >= 0,
            'invalid read interval')
        if (this.fileSize !== undefined) {
            requireV10(checkedNumberAdd(position, length, 'read interval') <= this.fileSize,
                'read interval exceeds file size')
        }
        const data = await this.file.read(position, length)
        requireV10(data && data.byteLength === length, `short read at ${position}; expected ${length} bytes`)
        return new Uint8Array(data)
    }

    _validateLocator(value, name) {
        if (!locatorPresent(value)) return
        requireV10(checkedNumberAdd(value.position, value.length, `${name} interval`) <= this.fileSize,
            `${name} exceeds file size`)
    }

    async init() {
        if (this.initialized) return
        const prefix = await this._read(0, 88)
        if (typeof this.file.getSize === 'function') this.fileSize = await this.file.getSize()
        this.fileSize ??= this.file.size ?? this.config.fileSize
        requireV10(Number.isSafeInteger(this.fileSize) && this.fileSize >= 88,
            'v10 byte source must expose its total size')

        const p = new V10Cursor(prefix, 'fixed header')
        p.magic('HIC\0')
        requireV10(p.u32() === 10, 'unsupported file version')
        const headerLength = toSafeNumber(p.u64(), 'header length')
        requireV10(headerLength >= 88 && headerLength <= this.maxRecordBytes && headerLength <= this.fileSize,
            'invalid header length')
        this.headerLength = headerLength
        this.footerLocator = locator(p, 'footer')
        this.normLocator = locator(p, 'normalization-vector index')
        this.expectedLocator = locator(p, 'expected-value index')
        this.normExpectedLocator = locator(p, 'normalized expected-value index')
        p.zero(8)
        p.done()
        requireV10(locatorPresent(this.footerLocator), 'footer is missing')
        this._validateLocator(this.footerLocator, 'footer')
        this._validateLocator(this.normLocator, 'normalization-vector index')
        this._validateLocator(this.expectedLocator, 'expected-value index')
        this._validateLocator(this.normExpectedLocator, 'normalized expected-value index')

        const header = new V10Cursor(await this._read(0, headerLength), 'header')
        header.magic('HIC\0')
        requireV10(header.u32() === 10 && toSafeNumber(header.u64(), 'header length') === headerLength,
            'header prefix mismatch')
        locator(header, 'footer')
        locator(header, 'normalization-vector index')
        locator(header, 'expected-value index')
        locator(header, 'normalized expected-value index')
        header.zero(8)
        this._parseVariableHeader(header)
        header.done()
        await this._readFooter()
        this._buildAliasesAndMetadata()
        this.config.nvi = locatorPresent(this.normLocator) ? `${this.normLocator.position},${this.normLocator.length}` : undefined
        this.initialized = true
    }

    _parseVariableHeader(cursor) {
        this.genomeId = cursor.cstr()
        this.attributeList = []
        this.attributes = {}
        const attributeCount = cursor.u32()
        requireV10(attributeCount <= cursor.available / 2, 'attribute count is out of bounds')
        for (let i = 0; i < attributeCount; i++) {
            const key = cursor.cstr()
            const value = cursor.cstr()
            this.attributeList.push([key, value])
            this.attributes[key] = value
        }

        const chromosomeCount = cursor.u32()
        requireV10(chromosomeCount > 0 && chromosomeCount <= cursor.available / 10,
            'chromosome count is out of bounds')
        this.chromosomes = []
        this.chromosomeIndexMap = {}
        const names = new Set()
        for (let i = 0; i < chromosomeCount; i++) {
            const name = cursor.cstr()
            const size = toSafeNumber(cursor.u64(), 'chromosome length')
            requireV10(name.length > 0 && !names.has(name) && size > 0, 'invalid chromosome record')
            names.add(name)
            const chromosome = {index: i, name, size}
            this.chromosomes.push(chromosome)
            this.chromosomeIndexMap[name] = i
            if (name.toLowerCase() === 'all') {
                this.wholeGenomeChromosome = chromosome
                this.wholeGenomeResolution = Math.round(size * (1000 / 500))
            }
        }

        this.resolutionRecords = [[], []]
        for (let unit = 0; unit < 2; unit++) {
            const count = cursor.u32()
            requireV10(count <= cursor.available / 12, 'resolution count is out of bounds')
            for (let i = 0; i < count; i++) {
                const binSize = cursor.u32()
                const storageMode = cursor.u8()
                const aggregation = cursor.u8()
                cursor.zero(2)
                const sourceResolutionIndex = cursor.u32()
                const list = this.resolutionRecords[unit]
                requireV10(binSize > 0 && (!list.length || binSize > list[list.length - 1].binSize),
                    'resolution list is not strictly increasing')
                requireV10(storageMode <= 1 && aggregation <= 1, 'unknown resolution enum')
                if (storageMode === MATERIALIZED) {
                    requireV10(sourceResolutionIndex === NO_SOURCE, 'materialized resolution has a source')
                } else {
                    requireV10(aggregation === 1 && sourceResolutionIndex < i &&
                        list[sourceResolutionIndex].storageMode === MATERIALIZED &&
                        binSize % list[sourceResolutionIndex].binSize === 0, 'invalid derived resolution source')
                }
                list.push({binSize, storageMode, aggregation, sourceResolutionIndex})
            }
        }
        this.bpResolutions = this.resolutionRecords[BP].map(value => value.binSize)
        this.fragResolutions = this.resolutionRecords[FRAG].map(value => value.binSize)

        this.fragmentSiteCounts = new Array(chromosomeCount).fill(0)
        if (this.fragResolutions.length) {
            for (let chr = 0; chr < chromosomeCount; chr++) {
                const count = cursor.u32()
                requireV10(count <= cursor.available / 8, 'fragment-site count is out of bounds')
                let previous = 0
                for (let i = 0; i < count; i++) {
                    const site = toSafeNumber(cursor.u64(), 'fragment-site position')
                    requireV10(site > previous && site < this.chromosomes[chr].size, 'invalid fragment-site list')
                    previous = site
                }
                this.fragmentSiteCounts[chr] = count
            }
        }

        const normalizationCount = cursor.u32()
        requireV10(normalizationCount <= cursor.available / 2, 'normalization count is out of bounds')
        this.normalizationNames = []
        names.clear()
        for (let i = 0; i < normalizationCount; i++) {
            const name = cursor.cstr()
            requireV10(name.length > 0 && name !== 'NONE' && !names.has(name), 'invalid normalization name')
            names.add(name)
            this.normalizationNames.push(name)
        }
        this.normalizationTypes = ['NONE', ...this.normalizationNames]

        for (let unit = 0; unit < 2; unit++) {
            for (let ri = 0; ri < this.resolutionRecords[unit].length; ri++) {
                for (let chr = 0; chr < chromosomeCount; chr++) {
                    requireV10(this._binCount(chr, unit, ri) <= 0xffffffff, 'chromosome bin count exceeds uint32')
                }
            }
        }
    }

    _binCount(chr, unit, resolutionIndex) {
        const length = unit === FRAG ? this.fragmentSiteCounts[chr] + 1 : this.chromosomes[chr].size
        const binSize = this.resolutionRecords[unit][resolutionIndex].binSize
        return Math.floor(length / binSize) + (length % binSize ? 1 : 0)
    }

    async _readFooter() {
        requireV10(this.footerLocator.length <= this.maxRecordBytes, 'footer exceeds allocation limit')
        const cursor = new V10Cursor(await this._read(this.footerLocator.position, this.footerLocator.length), 'footer')
        cursor.magic('H10F')
        requireV10(cursor.u32() === 1, 'unknown footer version')
        requireV10(toSafeNumber(cursor.u64(), 'footer length') === this.footerLocator.length,
            'footer length mismatch')
        const count = cursor.u32()
        cursor.zero(4)
        requireV10(this.footerLocator.length === 24 + count * 24, 'invalid footer entry count/length')
        this.masterIndex = {}
        this.matrixLocators = new Map()
        let previous
        for (let i = 0; i < count; i++) {
            const chr1 = cursor.u32()
            const chr2 = cursor.u32()
            const value = locator(cursor, 'matrix')
            const key = [chr1, chr2]
            requireV10(chr1 <= chr2 && chr2 < this.chromosomes.length &&
                (!previous || compareKeys(previous, key) < 0), 'invalid matrix directory order/key')
            requireV10(locatorPresent(value), 'matrix locator is absent')
            this._validateLocator(value, 'matrix')
            this.matrixLocators.set(`${chr1}_${chr2}`, value)
            this.masterIndex[`${chr1}_${chr2}`] = {start: value.position, size: value.length}
            previous = key
        }
        cursor.done()
    }

    _buildAliasesAndMetadata() {
        this.chrAliasTable = {}
        for (const chromosome of this.chromosomes) {
            const name = chromosome.name
            if (name.startsWith('chr')) this.chrAliasTable[name.substring(3)] = name
            else if (name === 'MT') this.chrAliasTable.chrM = name
            else this.chrAliasTable[`chr${name}`] = name
        }
        this.meta = {
            version: 10,
            genome: this.genomeId,
            chromosomes: this.chromosomes,
            resolutions: this.bpResolutions,
            fragResolutions: this.fragResolutions,
            attributes: this.attributes,
            attributeList: this.attributeList
        }
    }

    async readHeaderAndFooter() { await this.init(); return this }
    async readFooter() { await this.init(); return this }
    async getVersion() { return 10 }
    async getMetaData() { await this.init(); return this.meta }

    getFileChrName(alias) {
        return Object.prototype.hasOwnProperty.call(this.chrAliasTable, alias) ? this.chrAliasTable[alias] : alias
    }

    async getMatrix(chr1, chr2) {
        await this.init()
        if (chr1 > chr2) [chr1, chr2] = [chr2, chr1]
        const key = `${chr1}_${chr2}`
        if (this.matrixCache.has(key)) return this.matrixCache.get(key)
        const loc = this.matrixLocators.get(key)
        if (!loc) {
            this.matrixCache.set(key, undefined)
            return undefined
        }
        requireV10(loc.length <= this.maxRecordBytes, 'matrix metadata exceeds allocation limit')
        const cursor = new V10Cursor(await this._read(loc.position, loc.length), 'matrix metadata')
        cursor.magic('H10M')
        requireV10(cursor.u32() === 1, 'unknown matrix record version')
        requireV10(cursor.u32() === chr1 && cursor.u32() === chr2, 'matrix key mismatch')
        const count = cursor.u32()
        cursor.zero(4)
        const expectedCount = this.bpResolutions.length + this.fragResolutions.length
        requireV10(count === expectedCount && loc.length === 24 + count * 76,
            'matrix descriptor count/length mismatch')
        const descriptors = []
        for (let i = 0; i < count; i++) descriptors.push(this._parseDescriptor(cursor, chr1, chr2, i))
        cursor.done()
        const matrix = new V10Matrix(chr1, chr2, descriptors, this.bpResolutions.length)
        for (const descriptor of descriptors) {
            if (descriptor.storageMode === DERIVED) {
                const source = matrix.getZoomDataByIndex(descriptor.sourceResolutionIndex, unitName(descriptor.unit))
                requireV10(source && source.valueType === descriptor.valueType, 'derived/source value type mismatch')
            }
        }
        this.matrixCache.set(key, matrix)
        return matrix
    }

    _parseDescriptor(cursor, chr1, chr2, ordinal) {
        const unit = cursor.u8()
        const storageMode = cursor.u8()
        const aggregation = cursor.u8()
        const valueType = cursor.u8()
        const resolutionIndex = cursor.u32()
        const binSize = cursor.u32()
        const sourceResolutionIndex = cursor.u32()
        const gridType = cursor.u8()
        cursor.zero(3)
        const sumCounts = valueType === COUNT_UINT ? cursor.u64() : cursor.f64()
        const occupiedCellCount = cursor.u64()
        const stdDev = cursor.f32()
        const percent95 = cursor.f32()
        const blockBinCount = cursor.u32()
        const blockColumnCount = cursor.u32()
        const blockIndex = locator(cursor, 'block index')
        const logicalBlockCount = cursor.u32()
        cursor.zero(4)

        const expectedUnit = ordinal < this.bpResolutions.length ? BP : FRAG
        const expectedIndex = ordinal - (expectedUnit === FRAG ? this.bpResolutions.length : 0)
        const headerResolution = this.resolutionRecords[expectedUnit][expectedIndex]
        requireV10(unit === expectedUnit && resolutionIndex === expectedIndex &&
            binSize === headerResolution.binSize && storageMode === headerResolution.storageMode &&
            aggregation === headerResolution.aggregation && sourceResolutionIndex === headerResolution.sourceResolutionIndex,
            'matrix resolution descriptor does not match header')
        requireV10(valueType <= SCORE_FLOAT32 && storageMode <= DERIVED && aggregation <= 1,
            'unknown matrix descriptor enum')
        requireV10(gridType === (chr1 === chr2 ? ROTATED_CIS : RECTANGULAR), 'invalid matrix grid type')
        const nBins1 = this._binCount(chr1, unit, resolutionIndex)
        const nBins2 = this._binCount(chr2, unit, resolutionIndex)
        const maximumOccupied = chr1 === chr2
            ? BigInt(nBins1) * BigInt(nBins1 + 1) / 2n
            : BigInt(nBins1) * BigInt(nBins2)
        requireV10(occupiedCellCount <= maximumOccupied, 'matrix occupied-cell count exceeds its geometry')
        requireV10(blockBinCount > 0 && blockColumnCount === Math.ceil(nBins1 / blockBinCount),
            'invalid matrix block geometry')
        if (storageMode === DERIVED) {
            requireV10(!locatorPresent(blockIndex) && logicalBlockCount === 0, 'derived resolution has physical storage')
        } else if (occupiedCellCount > 0n) {
            requireV10(locatorPresent(blockIndex) && logicalBlockCount > 0 &&
                BigInt(logicalBlockCount) <= occupiedCellCount, 'non-empty matrix is missing or has excessive block storage')
        } else {
            requireV10(!locatorPresent(blockIndex) && logicalBlockCount === 0, 'empty matrix has block storage')
        }
        if (locatorPresent(blockIndex)) this._validateLocator(blockIndex, 'block index')
        const sumValue = valueType === COUNT_UINT && sumCounts <= MAX_SAFE_BIGINT ? Number(sumCounts) : sumCounts
        const descriptor = {
            unit, storageMode, aggregation, valueType, resolutionIndex, binSize, sourceResolutionIndex,
            gridType, occupiedCellCount, stdDev, percent95, blockBinCount, blockColumnCount,
            blockIndex, logicalBlockCount,
            chr1: this.chromosomes[chr1], chr2: this.chromosomes[chr2], chr1Index: chr1, chr2Index: chr2,
            zoom: {index: resolutionIndex, unit: unitName(unit), binSize},
            sumCounts: sumValue,
            averageCount: Number(sumCounts) /
                (this._binCount(chr1, unit, resolutionIndex) * this._binCount(chr2, unit, resolutionIndex))
        }
        descriptor.getKey = () => `${this.chromosomes[chr1].name}_${this.chromosomes[chr2].name}_${unitName(unit)}_${binSize}`
        descriptor.blockIndex.getBlockIndexEntry = async blockNumber => {
            const entries = await this._getBlockIndex(descriptor)
            const index = lowerBound(entries, blockNumber)
            const entry = entries[index]
            return entry?.blockNumber === blockNumber
                ? {filePosition: entry.blockPosition, size: entry.storedByteLength, ...entry}
                : undefined
        }
        return descriptor
    }

    async _getBlockIndex(zoom) {
        if (!locatorPresent(zoom.blockIndex)) return []
        const key = `${zoom.blockIndex.position}_${zoom.blockIndex.length}`
        if (this.blockIndexCache.has(key)) return this.blockIndexCache.get(key)
        requireV10(zoom.blockIndex.length <= this.maxRecordBytes, 'block index exceeds allocation limit')
        const cursor = new V10Cursor(await this._read(zoom.blockIndex.position, zoom.blockIndex.length), 'block index')
        cursor.magic('H10I')
        const version = cursor.u32()
        requireV10(version === 2, version === 1 ? 'draft H10I version 1 is unsupported' : 'unknown block-index version')
        requireV10(toSafeNumber(cursor.u64(), 'block-index length') === zoom.blockIndex.length,
            'block-index length mismatch')
        const count = cursor.u32()
        cursor.zero(4)
        requireV10(count === zoom.logicalBlockCount && zoom.blockIndex.length === 24 + count * 16,
            'block-index count/length mismatch')
        const entries = []
        for (let i = 0; i < count; i++) {
            const blockNumber = cursor.u32()
            const storedByteLength = cursor.u32()
            const blockPosition = toSafeNumber(cursor.u64(), 'stored block position')
            requireV10((i === 0 || blockNumber > entries[i - 1].blockNumber) && storedByteLength > 16,
                'unordered block index or invalid block length')
            requireV10(checkedNumberAdd(blockPosition, storedByteLength, 'stored block interval') <= this.fileSize,
                'stored block exceeds file size')
            entries.push({blockNumber, storedByteLength, blockPosition})
        }
        cursor.done()
        const byPosition = [...entries].sort((a, b) => a.blockPosition - b.blockPosition)
        for (let i = 1; i < byPosition.length; i++) {
            requireV10(checkedNumberAdd(byPosition[i - 1].blockPosition,
                byPosition[i - 1].storedByteLength, 'stored block interval') <= byPosition[i].blockPosition,
                'stored block intervals overlap')
        }
        this.blockIndexCache.set(key, entries)
        return entries
    }

    async _readBlock(entry, zoom, chr1, chr2) {
        const cacheKey = `${entry.blockPosition}_${entry.storedByteLength}_${zoom.unit}_${zoom.resolutionIndex}_${zoom.valueType}`
        if (this.blockCache.has(cacheKey)) return this.blockCache.get(cacheKey)
        const cursor = new V10Cursor(await this._read(entry.blockPosition, entry.storedByteLength), 'stored block')
        cursor.magic('H10B')
        requireV10(cursor.u8() === 1 && cursor.u8() === 1, 'unknown stored-block codec/version')
        cursor.zero(2)
        const uncompressedLength = cursor.u32()
        requireV10(cursor.u32() === entry.blockNumber && uncompressedLength >= 40,
            'stored block does not match its index entry')
        const compressed = cursor.bytes.subarray(cursor.position)
        const plain = await decompressZstd(compressed, uncompressedLength, this.maxRecordBytes)
        const records = this._decodeBlock(plain, entry.blockNumber, zoom, chr1, chr2)
        this.blockCache.set(cacheKey, records)
        return records
    }

    _decodeBlock(plain, expectedBlockNumber, zoom, chr1, chr2) {
        const cursor = new V10Cursor(plain, 'logical block')
        requireV10(cursor.u8() === 1, 'unknown logical-block version')
        const representation = cursor.u8()
        const valueMode = cursor.u8()
        const valueType = cursor.u8()
        const flags = cursor.u8()
        cursor.zero(3)
        const columnOffset = cursor.u32()
        const rowOffset = cursor.u32()
        const width = cursor.u32()
        const height = cursor.u32()
        const occupiedBig = cursor.u64()
        const positionBytes = cursor.u32()
        const valueBytes = cursor.u32()
        requireV10(representation <= DENSE && valueMode <= DIRECT && valueType === zoom.valueType &&
            flags <= 1 && width > 0 && height > 0 && occupiedBig > 0n, 'invalid logical-block header')
        const cellsBig = BigInt(width) * BigInt(height)
        const slotsBig = representation === DENSE ? cellsBig : occupiedBig
        requireV10(occupiedBig <= cellsBig && slotsBig <= BigInt(Math.floor(this.maxRecordBytes / 8)) &&
            positionBytes + valueBytes === cursor.available, 'invalid logical-block stream sizes')
        const occupied = toSafeNumber(occupiedBig, 'occupied cell count')
        const cells = toSafeNumber(cellsBig, 'logical block cell count')
        const slots = toSafeNumber(slotsBig, 'logical block value-slot count')
        const nBins1 = this._binCount(chr1, zoom.unit, zoom.resolutionIndex)
        const nBins2 = this._binCount(chr2, zoom.unit, zoom.resolutionIndex)
        requireV10(columnOffset < nBins1 && rowOffset < nBins2, 'block offsets exceed chromosome')
        const positions = cursor.take(positionBytes, 'block position stream')
        const values = cursor.take(valueBytes, 'block value stream')
        cursor.done()
        requireV10(representation !== DENSE || valueMode === DIRECT, 'dense block values must be direct')

        let defaultValue
        let exceptionOrdinals = []
        let nextException = 0
        const scalar = () => valueType === SCORE_FLOAT32 ? values.u32() : values.uleb128()
        if (valueMode === ALL_DEFAULT) {
            requireV10(slots > 0, 'all-default mode requires values')
            defaultValue = scalar()
        } else if (valueMode === DEFAULT_EXCEPTIONS) {
            defaultValue = scalar()
            const count = toSafeNumber(values.uleb128(), 'exception count')
            requireV10(count > 0 && count < slots && count <= values.available, 'invalid exception count')
            let previous = 0n
            for (let i = 0; i < count; i++) {
                const delta = values.uleb128()
                requireV10(i === 0 || delta > 0n, 'duplicate exception ordinal')
                const ordinal = i === 0 ? delta : checkedAdd(previous, delta, 'exception ordinal')
                requireV10(ordinal < slotsBig, 'exception ordinal is out of range')
                exceptionOrdinals.push(toSafeNumber(ordinal, 'exception ordinal'))
                previous = ordinal
            }
        }
        const valueAt = ordinal => {
            if (valueMode === DIRECT) return scalar()
            if (valueMode === DEFAULT_EXCEPTIONS && nextException < exceptionOrdinals.length &&
                exceptionOrdinals[nextException] === ordinal) {
                nextException++
                const value = scalar()
                requireV10(value !== defaultValue, 'exception value equals default')
                return value
            }
            return defaultValue
        }

        const records = []
        const emit = (position, rawValue) => {
            if (representation !== DENSE && valueType === COUNT_UINT) requireV10(rawValue > 0n, 'sparse count is zero')
            const binColumn = columnOffset + (position % width)
            const binRow = rowOffset + Math.floor(position / width)
            requireV10(binColumn < nBins1 && binRow < nBins2 && (chr1 !== chr2 || binRow >= binColumn) &&
                blockNumberForCell(binColumn, binRow, zoom) === expectedBlockNumber,
                'cell violates logical-block geometry')
            records.push({bin1: binColumn, bin2: binRow,
                value: valueType === SCORE_FLOAT32 ? floatFromBits(rawValue) : rawValue,
                valueType})
        }

        let consumed = 0
        if (representation === SPARSE_DELTA) {
            requireV10(flags === 0 && occupied <= positionBytes, 'invalid sparse position stream')
            let previous = 0n
            for (let i = 0; i < occupied; i++) {
                const delta = positions.uleb128()
                requireV10(i === 0 || delta > 0n, 'duplicate sparse position')
                const position = i === 0 ? delta : checkedAdd(previous, delta, 'sparse position')
                requireV10(position < cellsBig, 'sparse position is out of range')
                emit(toSafeNumber(position, 'sparse position'), valueAt(i))
                previous = position
                consumed++
            }
        } else if (representation === BITMAP || valueType === SCORE_FLOAT32) {
            requireV10(flags === 1 && positionBytes === Math.ceil(cells / 8), 'invalid presence bitmap')
            if (cells % 8) requireV10((positions.bytes[positionBytes - 1] >>> (cells % 8)) === 0,
                'nonzero presence-bitmap padding')
            let found = 0
            for (let position = 0; position < cells; position++) {
                const present = (positions.bytes[Math.floor(position / 8)] & (1 << (position % 8))) !== 0
                if (representation === DENSE) {
                    const value = valueAt(position)
                    if (present) {
                        emit(position, value)
                        found++
                    } else requireV10(value === 0, 'absent dense score is not positive zero')
                    consumed++
                } else if (present) {
                    requireV10(found < occupied, 'presence bitmap population exceeds occupied count')
                    emit(position, valueAt(found++))
                    consumed++
                }
            }
            requireV10(found === occupied, 'presence bitmap population mismatch')
            positions.position = positions.length
        } else {
            requireV10(flags === 0 && positionBytes === 0, 'dense count block has a position stream')
            let emitted = 0
            for (let position = 0; position < cells; position++) {
                const value = valueAt(position)
                if (value !== 0n) {
                    emit(position, value)
                    emitted++
                }
                consumed++
            }
            requireV10(emitted === occupied, 'dense occupied-cell count mismatch')
        }
        requireV10(consumed === slots && nextException === exceptionOrdinals.length,
            'logical-block value-slot mismatch')
        positions.done()
        values.done()
        requireV10(records.length === occupied, 'logical-block occupied-cell count mismatch')
        return records
    }

    async _materialized(matrix, zoom, x0, x1, y0, y1, callback) {
        const index = await this._getBlockIndex(zoom)
        const inside = (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1) ||
            (matrix.chr1 === matrix.chr2 && y >= x0 && y < x1 && x >= y0 && x < y1)
        const selected = new Set()
        const seenCells = new Set()
        let decodedCells = 0n
        let decodedSum = 0n
        for (const range of candidateBlockRanges(zoom, x0, x1, y0, y1)) {
            for (let i = lowerBound(index, range.first); i < index.length && index[i].blockNumber <= range.last; i++) {
                if (selected.has(index[i].blockNumber)) continue
                selected.add(index[i].blockNumber)
                const records = await this._readBlock(index[i], zoom, matrix.chr1, matrix.chr2)
                for (const record of records) {
                    const cellKey = `${record.bin2}_${record.bin1}`
                    requireV10(!seenCells.has(cellKey), 'duplicate matrix cell')
                    seenCells.add(cellKey)
                    decodedCells++
                    if (record.valueType === COUNT_UINT) decodedSum = checkedAdd(decodedSum, record.value, 'matrix count sum')
                    if (inside(record.bin1, record.bin2)) callback(record)
                }
            }
        }
        if (selected.size === index.length) {
            requireV10(decodedCells === zoom.occupiedCellCount, 'matrix occupied-cell count mismatch')
            if (zoom.valueType === COUNT_UINT) {
                const expectedSum = typeof zoom.sumCounts === 'bigint' ? zoom.sumCounts : BigInt(zoom.sumCounts)
                requireV10(decodedSum === expectedSum, 'matrix count sum mismatch')
            }
        }
    }

    async _raw(matrix, zoom, x0, x1, y0, y1) {
        const result = []
        if (zoom.storageMode === MATERIALIZED) {
            await this._materialized(matrix, zoom, x0, x1, y0, y1, record => result.push(record))
            return result
        }
        const source = matrix.getZoomDataByIndex(zoom.sourceResolutionIndex, unitName(zoom.unit))
        requireV10(source && source.storageMode === MATERIALIZED, 'derived source descriptor is missing')
        const factor = zoom.binSize / source.binSize
        const sourceX1 = Math.min(x1 * factor, this._binCount(matrix.chr1, zoom.unit, source.resolutionIndex))
        const sourceY1 = Math.min(y1 * factor, this._binCount(matrix.chr2, zoom.unit, source.resolutionIndex))
        const inside = (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1) ||
            (matrix.chr1 === matrix.chr2 && y >= x0 && y < x1 && x >= y0 && x < y1)
        const seen = new Set()
        const sums = new Map()
        const scores = []
        await this._materialized(matrix, source, x0 * factor, sourceX1, y0 * factor, sourceY1, record => {
            const key = `${record.bin2}_${record.bin1}`
            requireV10(!seen.has(key), 'duplicate source cell while deriving resolution')
            seen.add(key)
            const tx = Math.floor(record.bin1 / factor)
            const ty = Math.floor(record.bin2 / factor)
            if (!inside(tx, ty)) return
            if (zoom.valueType === COUNT_UINT) {
                const targetKey = `${ty}_${tx}`
                const previous = sums.get(targetKey)?.value || 0n
                sums.set(targetKey, {bin1: tx, bin2: ty,
                    value: checkedAdd(previous, record.value, 'derived count'), valueType: COUNT_UINT})
            } else scores.push(record)
        })
        if (zoom.valueType === SCORE_FLOAT32) {
            scores.sort((a, b) => a.bin2 - b.bin2 || a.bin1 - b.bin1)
            for (const record of scores) {
                requireV10(Number.isFinite(record.value), 'non-finite source score cannot be derived')
                const tx = Math.floor(record.bin1 / factor)
                const ty = Math.floor(record.bin2 / factor)
                const targetKey = `${ty}_${tx}`
                const previous = sums.get(targetKey)?.value || 0
                const value = previous + record.value
                requireV10(Number.isFinite(value), 'derived score overflow')
                sums.set(targetKey, {bin1: tx, bin2: ty, value, valueType: SCORE_FLOAT32})
            }
            for (const record of sums.values()) record.value = Math.fround(record.value)
        }
        return [...sums.values()]
    }

    _regionBins(region, chr, unit, ri) {
        requireV10(region && Number.isFinite(region.start) && Number.isFinite(region.end) &&
            region.start >= 0 && region.end >= region.start, 'invalid query region')
        const binSize = this.resolutionRecords[unit][ri].binSize
        const bins = this._binCount(chr, unit, ri)
        return {start: Math.min(bins, Math.floor(region.start / binSize)),
            end: Math.min(bins, Math.ceil(region.end / binSize))}
    }

    async getContactRecords(normalization, region1, region2, units, binSize, matrixType = 'observed') {
        await this.init()
        requireV10(matrixType === 'observed' || matrixType === 'oe' || matrixType === 'expected',
            `unknown matrix type ${matrixType}`)
        const unit = unitId(units)
        const resolutionIndex = this.resolutionRecords[unit].findIndex(value => value.binSize === binSize)
        requireV10(resolutionIndex >= 0, `unavailable resolution ${binSize}`)
        let chr1Name = this.getFileChrName(region1.chr)
        let chr2Name = this.getFileChrName(region2.chr)
        let chr1 = this.chromosomeIndexMap[chr1Name]
        let chr2 = this.chromosomeIndexMap[chr2Name]
        requireV10(chr1 !== undefined && chr2 !== undefined, 'unknown chromosome in query')
        if (matrixType !== 'observed') {
            requireV10(chr1 === chr2, 'expected values are defined only for cis matrices')
        }
        const transpose = chr1 > chr2 || (chr1 === chr2 && region1.start >= region2.end)
        if (transpose) {
            [chr1, chr2] = [chr2, chr1]
            ;[chr1Name, chr2Name] = [chr2Name, chr1Name]
            ;[region1, region2] = [region2, region1]
        }
        const first = this._regionBins(region1, chr1, unit, resolutionIndex)
        const second = this._regionBins(region2, chr2, unit, resolutionIndex)
        if (first.start >= first.end || second.start >= second.end) return []
        const matrix = await this.getMatrix(chr1, chr2)
        if (!matrix) return []
        const zoom = matrix.getZoomData(binSize, units)
        requireV10(zoom, `matrix has no ${units} resolution ${binSize}`)
        const raw = await this._raw(matrix, zoom, first.start, first.end, second.start, second.end)

        const normalized = normalization && normalization !== 'NONE'
        let vector1
        let vector2
        if (normalized && matrixType !== 'expected') {
            const nv1 = await this.getNormalizationVector(normalization, chr1, units, binSize)
            const nv2 = chr1 === chr2 ? nv1 : await this.getNormalizationVector(normalization, chr2, units, binSize)
            if (nv1 && nv2) {
                vector1 = await nv1.getValues(first.start, first.end)
                vector2 = await nv2.getValues(second.start, second.end)
            }
        }
        const applyNormalization = normalized && matrixType !== 'expected' && vector1 && vector2
        if (normalized && matrixType === 'oe') {
            requireV10(applyNormalization, `normalization ${normalization} is unavailable at ${binSize}`)
        }
        let expectedVector
        let expectedValues
        let expectedBegin = 0
        if (matrixType !== 'observed') {
            expectedVector = await this.getExpectedValueVector(normalization || 'NONE', chr1, units, binSize)
            requireV10(expectedVector, `expected values are unavailable for ${normalization || 'NONE'} at ${binSize}`)
            if (raw.length) {
                let expectedEnd = 0
                expectedBegin = Number.MAX_SAFE_INTEGER
                for (const record of raw) {
                    const distance = Math.abs(record.bin1 - record.bin2)
                    expectedBegin = Math.min(expectedBegin, distance)
                    expectedEnd = Math.max(expectedEnd, distance + 1)
                }
                expectedValues = await expectedVector.getValues(expectedBegin, expectedEnd)
            } else expectedValues = []
        }
        const records = []
        for (const record of raw) {
            let bin1 = record.bin1
            let bin2 = record.bin2
            if (chr1 === chr2 && !(bin1 >= first.start && bin1 < first.end &&
                bin2 >= second.start && bin2 < second.end)) {
                [bin1, bin2] = [bin2, bin1]
            }
            let value = record.value
            if (applyNormalization) {
                const a = vector1[bin1 - first.start]
                const b = vector2[bin2 - second.start]
                if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0 || b === 0) continue
                value = Number(value) / (a * b)
            } else if (record.valueType === COUNT_UINT && value <= MAX_SAFE_BIGINT) value = Number(value)
            if (expectedVector) {
                const distance = Math.abs(bin1 - bin2)
                const expected = expectedValues[distance - expectedBegin]
                if (!Number.isFinite(expected) || expected === 0) continue
                value = matrixType === 'oe' ? Number(value) / expected : expected
            }
            if (transpose) [bin1, bin2] = [bin2, bin1]
            records.push(new ContactRecord(bin1, bin2, value))
        }
        return records
    }

    async getBlocks(region1, region2, unit, binSize) {
        await this.init()
        const uid = unitId(unit)
        const ri = this.resolutionRecords[uid].findIndex(value => value.binSize === binSize)
        requireV10(ri >= 0, `unavailable resolution ${binSize}`)
        let chr1 = this.chromosomeIndexMap[this.getFileChrName(region1.chr)]
        let chr2 = this.chromosomeIndexMap[this.getFileChrName(region2.chr)]
        requireV10(chr1 !== undefined && chr2 !== undefined, 'unknown chromosome in query')
        if (chr1 > chr2) {
            ;[chr1, chr2] = [chr2, chr1]
            ;[region1, region2] = [region2, region1]
        }
        const matrix = await this.getMatrix(chr1, chr2)
        if (!matrix) return []
        const zoom = matrix.getZoomData(binSize, unit)
        requireV10(zoom, `matrix has no ${unit} resolution ${binSize}`)
        if (zoom.storageMode === DERIVED) {
            const records = await this.getContactRecords('NONE', region1, region2, unit, binSize)
            return records.length ? [{blockNumber: -1, zoomData: zoom, records, idx: undefined}] : []
        }
        const first = this._regionBins(region1, chr1, uid, ri)
        const second = this._regionBins(region2, chr2, uid, ri)
        const index = await this._getBlockIndex(zoom)
        const selected = new Set()
        for (const range of candidateBlockRanges(zoom, first.start, first.end, second.start, second.end)) {
            for (let i = lowerBound(index, range.first); i < index.length && index[i].blockNumber <= range.last; i++) {
                selected.add(index[i].blockNumber)
            }
        }
        const blocks = []
        for (const blockNumber of [...selected].sort((a, b) => a - b)) {
            const block = await this.readBlock(blockNumber, zoom)
            if (block) blocks.push(block)
        }
        return blocks
    }

    async readBlock(blockNumber, zoom) {
        await this.init()
        requireV10(zoom && zoom.storageMode === MATERIALIZED && Number.isInteger(blockNumber),
            'invalid direct block request')
        const entries = await this._getBlockIndex(zoom)
        const index = lowerBound(entries, blockNumber)
        const entry = entries[index]
        if (!entry || entry.blockNumber !== blockNumber) return undefined
        const raw = await this._readBlock(entry, zoom, zoom.chr1Index, zoom.chr2Index)
        const records = raw.map(record => new ContactRecord(record.bin1, record.bin2,
            record.valueType === COUNT_UINT && record.value <= MAX_SAFE_BIGINT ? Number(record.value) : record.value))
        return {blockNumber, zoomData: zoom, records,
            idx: {filePosition: entry.blockPosition, size: entry.storedByteLength, ...entry}}
    }

    getZoomIndexForBinSize(binSize, unit = 'BP') {
        return (unit === 'FRAG' ? this.fragResolutions : this.bpResolutions).indexOf(binSize)
    }

    async _loadNormIndex() {
        await this.init()
        if (this.normEntries) return this.normEntries
        this.normEntries = new Map()
        this.normVectorIndex = {}
        if (!locatorPresent(this.normLocator)) return this.normEntries
        requireV10(this.normLocator.length <= this.maxRecordBytes, 'normalization index exceeds allocation limit')
        const cursor = new V10Cursor(await this._read(this.normLocator.position, this.normLocator.length),
            'normalization-vector index')
        cursor.magic('NVI0')
        requireV10(cursor.u32() === 1, 'unknown normalization-index version')
        const count = cursor.u32()
        cursor.zero(4)
        let previous
        for (let i = 0; i < count; i++) {
            const entryLength = cursor.u32()
            requireV10(entryLength >= 40 && entryLength - 4 <= cursor.available,
                'invalid normalization-index entry length')
            const entryCursor = cursor.take(entryLength - 4, 'normalization-vector entry')
            const normalizationTypeId = entryCursor.u32()
            const chrIndex = entryCursor.u32()
            const unit = entryCursor.u8()
            entryCursor.zero(3)
            const resolutionIndex = entryCursor.u32()
            const binSize = entryCursor.u32()
            const valueCount = toSafeNumber(entryCursor.u64(), 'normalization-vector length')
            const nominalChunkValueCount = entryCursor.u32()
            const chunkCount = entryCursor.u32()
            requireV10(normalizationTypeId < this.normalizationNames.length && chrIndex < this.chromosomes.length &&
                unit <= FRAG && resolutionIndex < this.resolutionRecords[unit].length &&
                binSize === this.resolutionRecords[unit][resolutionIndex].binSize,
                'invalid normalization-vector key')
            const keyArray = [normalizationTypeId, chrIndex, unit, resolutionIndex]
            requireV10(!previous || compareKeys(previous, keyArray) < 0,
                'normalization-vector keys are unordered or duplicated')
            previous = keyArray
            requireV10(valueCount === this._binCount(chrIndex, unit, resolutionIndex) &&
                (valueCount === 0 ? chunkCount === 0 : nominalChunkValueCount > 0 && chunkCount > 0) &&
                entryLength === 40 + 32 * chunkCount, 'invalid normalization-vector length/chunks')
            const chunks = []
            let next = 0
            for (let j = 0; j < chunkCount; j++) {
                const firstValueIndex = toSafeNumber(entryCursor.u64(), 'vector chunk first index')
                const chunkValueCount = entryCursor.u32()
                const transform = entryCursor.u8()
                const codec = entryCursor.u8()
                entryCursor.zero(2)
                const filePosition = toSafeNumber(entryCursor.u64(), 'vector chunk position')
                const storedByteLength = entryCursor.u32()
                const uncompressedByteLength = entryCursor.u32()
                requireV10(firstValueIndex === next && chunkValueCount > 0 &&
                    uncompressedByteLength === chunkValueCount * 4 && transform <= 2 && codec === 1 &&
                    storedByteLength > 16 &&
                    checkedNumberAdd(filePosition, storedByteLength, 'normalization chunk interval') <= this.fileSize,
                    'invalid normalization-vector chunk descriptor')
                next = checkedNumberAdd(next, chunkValueCount, 'normalization-vector coverage')
                requireV10(next <= valueCount, 'normalization-vector chunk exceeds vector')
                chunks.push({firstValueIndex, valueCount: chunkValueCount, transform, codec, filePosition,
                    storedByteLength, uncompressedByteLength})
            }
            requireV10(next === valueCount, 'normalization-vector chunks do not cover the vector')
            entryCursor.done()
            const entry = {normalizationTypeId, chrIndex, unit, resolutionIndex, binSize, valueCount,
                nominalChunkValueCount, chunks}
            const key = `${normalizationTypeId}_${chrIndex}_${unit}_${resolutionIndex}`
            this.normEntries.set(key, entry)
            const legacyKey = `${this.normalizationNames[normalizationTypeId]}_${chrIndex}_${unitName(unit)}_${binSize}`
            this.normVectorIndex[legacyKey] = {filePosition: this.normLocator.position, size: entryLength, entry}
        }
        cursor.done()
        return this.normEntries
    }

    async _loadExpectedIndex(normalized = false) {
        await this.init()
        const cacheName = normalized ? 'normExpectedEntries' : 'expectedEntries'
        if (this[cacheName]) return this[cacheName]
        const entries = new Map()
        this[cacheName] = entries
        const loc = normalized ? this.normExpectedLocator : this.expectedLocator
        if (!locatorPresent(loc)) return entries
        requireV10(loc.length <= this.maxRecordBytes, 'expected-value index exceeds allocation limit')
        const cursor = new V10Cursor(await this._read(loc.position, loc.length),
            normalized ? 'normalized expected-value index' : 'expected-value index')
        cursor.magic(normalized ? 'NEVI' : 'EVI0')
        requireV10(cursor.u32() === 1, 'unknown expected-value index version')
        const count = cursor.u32()
        cursor.zero(4)
        let previous
        for (let i = 0; i < count; i++) {
            const entryLength = cursor.u32()
            const minimumLength = normalized ? 44 : 40
            requireV10(entryLength >= minimumLength && entryLength - 4 <= cursor.available,
                'invalid expected-value entry length')
            const entryCursor = cursor.take(entryLength - 4, 'expected-value entry')
            const normalizationTypeId = normalized ? entryCursor.u32() : undefined
            const unit = entryCursor.u8()
            entryCursor.zero(3)
            const resolutionIndex = entryCursor.u32()
            const binSize = entryCursor.u32()
            const valueCount = toSafeNumber(entryCursor.u64(), 'expected-vector length')
            const nominalChunkValueCount = entryCursor.u32()
            const chunkCount = entryCursor.u32()
            const scaleFactorCount = entryCursor.u32()
            entryCursor.zero(4)
            requireV10((!normalized || normalizationTypeId < this.normalizationNames.length) && unit <= FRAG &&
                resolutionIndex < this.resolutionRecords[unit].length &&
                binSize === this.resolutionRecords[unit][resolutionIndex].binSize,
            'invalid expected-vector key')
            const keyArray = normalized ? [normalizationTypeId, unit, resolutionIndex] : [unit, resolutionIndex]
            requireV10(!previous || compareKeys(previous, keyArray) < 0,
                'expected-vector keys are unordered or duplicated')
            previous = keyArray
            let requiredCount = 0
            for (let chr = 0; chr < this.chromosomes.length; chr++) {
                requiredCount = Math.max(requiredCount, this._binCount(chr, unit, resolutionIndex))
            }
            requireV10(valueCount === requiredCount &&
                (valueCount === 0 ? chunkCount === 0 : nominalChunkValueCount > 0 && chunkCount > 0) &&
                entryLength === minimumLength + 8 * scaleFactorCount + 32 * chunkCount,
            'invalid expected-vector length/chunks')
            const scaleFactors = new Map()
            let previousChr = -1
            for (let j = 0; j < scaleFactorCount; j++) {
                const chrIndex = entryCursor.u32()
                const scale = entryCursor.f32()
                requireV10(chrIndex < this.chromosomes.length && chrIndex > previousChr,
                    'expected-vector scale factors are unordered or duplicated')
                scaleFactors.set(chrIndex, scale)
                previousChr = chrIndex
            }
            const chunks = []
            let next = 0
            for (let j = 0; j < chunkCount; j++) {
                const firstValueIndex = toSafeNumber(entryCursor.u64(), 'expected chunk first index')
                const chunkValueCount = entryCursor.u32()
                const transform = entryCursor.u8()
                const codec = entryCursor.u8()
                entryCursor.zero(2)
                const filePosition = toSafeNumber(entryCursor.u64(), 'expected chunk position')
                const storedByteLength = entryCursor.u32()
                const uncompressedByteLength = entryCursor.u32()
                requireV10(firstValueIndex === next && chunkValueCount > 0 &&
                    uncompressedByteLength === chunkValueCount * 4 && transform <= 2 && codec === 1 &&
                    storedByteLength > 16 &&
                    checkedNumberAdd(filePosition, storedByteLength, 'expected chunk interval') <= this.fileSize,
                'invalid expected-vector chunk descriptor')
                next = checkedNumberAdd(next, chunkValueCount, 'expected-vector coverage')
                requireV10(next <= valueCount,
                    'expected-vector chunk exceeds vector')
                chunks.push({firstValueIndex, valueCount: chunkValueCount, transform, codec, filePosition,
                    storedByteLength, uncompressedByteLength})
            }
            requireV10(next === valueCount, 'expected-vector chunks do not cover the vector')
            entryCursor.done()
            const entry = {normalizationTypeId, unit, resolutionIndex, binSize, valueCount,
                nominalChunkValueCount, scaleFactors, chunks}
            entries.set(keyArray.join('_'), entry)
        }
        cursor.done()
        return entries
    }

    async _readVectorChunk(chunk) {
        const key = `${chunk.filePosition}_${chunk.storedByteLength}`
        if (this.vectorChunkCache.has(key)) return this.vectorChunkCache.get(key)
        const cursor = new V10Cursor(await this._read(chunk.filePosition, chunk.storedByteLength), 'vector chunk')
        cursor.magic('H10V')
        requireV10(cursor.u8() === chunk.codec && cursor.u8() === chunk.transform,
            'vector chunk codec/transform mismatch')
        cursor.zero(2)
        requireV10(cursor.u32() === chunk.uncompressedByteLength && cursor.u32() === chunk.valueCount,
            'vector chunk size mismatch')
        const transformed = await decompressZstd(cursor.bytes.subarray(cursor.position),
            chunk.uncompressedByteLength, this.maxRecordBytes)
        const output = new Float32Array(chunk.valueCount)
        const view = new DataView(transformed.buffer, transformed.byteOffset, transformed.byteLength)
        let previous = 0
        for (let i = 0; i < chunk.valueCount; i++) {
            let bits
            if (chunk.transform === 1) {
                bits = transformed[i] | (transformed[chunk.valueCount + i] << 8) |
                    (transformed[2 * chunk.valueCount + i] << 16) |
                    (transformed[3 * chunk.valueCount + i] << 24)
                bits >>>= 0
            } else {
                bits = view.getUint32(i * 4, true)
                if (chunk.transform === 2 && i > 0) bits = (bits ^ previous) >>> 0
            }
            previous = bits
            output[i] = floatFromBits(bits)
        }
        this.vectorChunkCache.set(key, output)
        return output
    }

    async _readVectorValues(entry, begin, end) {
        const last = Math.min(end, entry.valueCount)
        requireV10(Number.isInteger(begin) && Number.isInteger(last) && begin >= 0 && begin <= last,
            'invalid vector range')
        const result = new Array(last - begin)
        for (const chunk of entry.chunks) {
            const chunkEnd = chunk.firstValueIndex + chunk.valueCount
            if (chunkEnd <= begin || chunk.firstValueIndex >= last) continue
            const values = await this._readVectorChunk(chunk)
            const from = Math.max(begin, chunk.firstValueIndex)
            const to = Math.min(last, chunkEnd)
            for (let index = from; index < to; index++) {
                result[index - begin] = values[index - chunk.firstValueIndex]
            }
        }
        return result
    }

    async getNormVectorIndex() {
        await this._loadNormIndex()
        return this.normVectorIndex
    }

    async getNormalizationOptions() {
        await this.init()
        return this.normalizationTypes
    }

    async getNormalizationVector(type, chr, unit, binSize) {
        await this.init()
        const normalizationTypeId = this.normalizationNames.indexOf(type)
        if (normalizationTypeId < 0) return undefined
        const chrIndex = Number.isInteger(chr) ? chr : this.chromosomeIndexMap[this.getFileChrName(chr)]
        if (chrIndex === undefined) return undefined
        const uid = unitId(unit)
        const resolutionIndex = this.resolutionRecords[uid].findIndex(value => value.binSize === binSize)
        if (resolutionIndex < 0) return undefined
        const entries = await this._loadNormIndex()
        const entry = entries.get(`${normalizationTypeId}_${chrIndex}_${uid}_${resolutionIndex}`)
        return entry ? new V10NormalizationVector(this, entry) : undefined
    }

    async getExpectedValueVector(type, chr, unit, binSize) {
        await this.init()
        const normalized = type && type !== 'NONE'
        const normalizationTypeId = normalized ? this.normalizationNames.indexOf(type) : undefined
        if (normalized && normalizationTypeId < 0) return undefined
        const chrIndex = Number.isInteger(chr) ? chr : this.chromosomeIndexMap[this.getFileChrName(chr)]
        if (chrIndex === undefined) return undefined
        const uid = unitId(unit)
        const resolutionIndex = this.resolutionRecords[uid].findIndex(value => value.binSize === binSize)
        if (resolutionIndex < 0) return undefined
        const entries = await this._loadExpectedIndex(normalized)
        const key = normalized ? `${normalizationTypeId}_${uid}_${resolutionIndex}` : `${uid}_${resolutionIndex}`
        const entry = entries.get(key)
        if (!entry) return undefined
        const scale = entry.scaleFactors.get(chrIndex) ?? 1
        requireV10(Number.isFinite(scale) && scale !== 0, 'invalid expected-vector scale factor')
        return new V10ExpectedVector(this, entry, scale)
    }

    async getExpectedValues(type, chr, unit, binSize, start = 0, end) {
        const vector = await this.getExpectedValueVector(type, chr, unit, binSize)
        return vector ? vector.getValues(start, end ?? vector.nValues) : undefined
    }

    async hasExpectedValues(type, chr, unit, binSize) {
        return (await this.getExpectedValueVector(type, chr, unit, binSize)) !== undefined
    }

    async hasNormalizationVector(type, chr, unit, binSize) {
        return (await this.getNormalizationVector(type, chr, unit, binSize)) !== undefined
    }

    async isNormalizationValueAvailableAtResolution(type, chr, unit, binSize) {
        return this.hasNormalizationVector(type, chr, unit, binSize)
    }

    async printIndexStats() {
        await this.init()
        let max = 0
        let key
        for (const [matrixKey, value] of this.matrixLocators) {
            if (value.length > max) { max = value.length; key = matrixKey }
        }
        console.log(`${max}  ${key}  ${this.config.url || ''}`)
    }
}

export default V10HicFile
export {candidateBlockRanges, depthForDistance}
