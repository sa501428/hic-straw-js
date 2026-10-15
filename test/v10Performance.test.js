import {describe, it, expect, vi} from 'vitest'
import V10HicFile from '../src/v10/hicFile.js'
import {RecordBlock, ByteCache} from '../src/v10/recordBlock.js'
import {createV10Fixture, MemoryFile} from './helpers/v10Fixture.js'

const region = (start = 0, end = 80) => ({chr: 'chrA', start, end})
const triples = records => records.map(r => [r.bin1, r.bin2, r.counts])
const flush = () => new Promise(resolve => setImmediate(resolve))
function packed(records, type = 0) {
    const block = new RecordBlock(records.length, type)
    for (const [bin1, bin2, value] of records) block.push({bin1, bin2, value})
    return block
}

describe('V10 bounded caches and aggregation reuse', () => {
    it('retains exact uint64 counts in packed source blocks', () => {
        const value = (1n << 63n) + 17n
        const block = packed([[1, 2, value]])
        expect(block.byteLength).toBe(16)
        expect(block.recordAt(0)).toEqual({bin1: 1, bin2: 2, value, valueType: 0})
        expect([...block]).toEqual(block.map(r => r))
    })

    it('bounds cache entries and bytes, refreshes LRU order, and supports zero', () => {
        const cache = new ByteCache(2, 48)
        const small = packed([[0, 0, 1n]])
        cache.set('a', small); cache.set('b', small)
        cache.get('a'); cache.set('c', small)
        expect([...cache.map.keys()]).toEqual(['a', 'c'])
        cache.set('d', packed([[0, 0, 1n], [1, 1, 2n], [2, 2, 3n]]))
        expect([...cache.map.keys()]).toEqual(['d'])
        expect(cache.bytes).toBe(48)
        cache.set('too-large', {byteLength: 49})
        expect(cache.bytes).toBe(48)
        cache.clear(); expect(cache.bytes).toBe(0)
        const disabled = new ByteCache(0, 100)
        disabled.set('a', small); expect(disabled.map.size).toBe(0)
        expect(() => new ByteCache(1, -1)).toThrow()
    })

    it('caches complete source-block aggregates, not the first clipped query', async () => {
        const wire = new V10HicFile({file: new MemoryFile(createV10Fixture({counts: [(1n << 53n) + 1n, 1n, 5n]}))})
        const decoder = vi.spyOn(wire, '_decodeBlock')
        const cacheWrite = vi.spyOn(wire.derivedBlockCache, 'set')
        const query = (r, bin) => wire.getContactRecords('NONE', r, r, 'BP', bin)
        expect(triples(await query(region(0, 20), 20))).toEqual([[0, 0, (1n << 53n) + 1n]])
        expect(triples(await query(region(), 20))).toEqual([[0, 0, (1n << 53n) + 1n], [0, 1, 1], [1, 1, 5]])
        expect(triples(await query(region(), 10))).toEqual([[0, 0, (1n << 53n) + 1n], [1, 2, 1], [3, 3, 5]])
        expect(decoder).toHaveBeenCalledTimes(1)
        expect(cacheWrite).toHaveBeenCalledTimes(1)
        expect(wire.blockCache.bytes).toBe(48)
        expect(wire.derivedBlockCache.bytes).toBe(48)
    })

    it('matches the uncached path for cis, trans, partial bins, and scored data', async () => {
        for (const options of [{}, {targetBinSize: 30}, {trans: true}, {score: true, counts: [1.25, -0.5, 2.75]}]) {
            const bytes = createV10Fixture(options)
            const cached = new V10HicFile({file: new MemoryFile(bytes)})
            const uncached = new V10HicFile({file: new MemoryFile(bytes), v10DerivedBlockCacheBytes: 0})
            const bin = options.targetBinSize || 20
            for (const [a, b] of [[region(), region()], [region(20, 80), region(0, 40)], [region(0, 21), region(19, 61)]]) {
                if (options.trans) b.chr = 'chrB'
                const actual = await cached.getContactRecords('NONE', a, b, 'BP', bin)
                const expected = await uncached.getContactRecords('NONE', a, b, 'BP', bin)
                expect(triples(actual)).toEqual(triples(expected))
            }
        }
    })

    it('merges a target bin that straddles two physical source blocks exactly', async () => {
        const wire = new V10HicFile({file: new MemoryFile(createV10Fixture({trans: true, targetBinSize: 30}))})
        const matrix = await wire.getMatrix(0, 1)
        const source = matrix.getZoomData(10, 'BP'), target = matrix.getZoomData(30, 'BP')
        Object.assign(source, {blockBinCount: 2, blockColumnCount: 4, occupiedCellCount: 2n, sumCounts: 5})
        const entries = [0, 1].map(n => ({blockNumber: n, blockPosition: 1000 + n, storedByteLength: 100}))
        vi.spyOn(wire, '_getBlockIndex').mockResolvedValue(entries)
        vi.spyOn(wire, '_readBlock').mockImplementation(async entry => entry.blockNumber === 0 ? packed([[1, 0, 2n]]) : packed([[2, 0, 3n]]))
        expect(await wire._raw(matrix, target, 0, 1, 0, 1)).toEqual([{bin1: 0, bin2: 0, value: 5n, valueType: 0}])
    })

    it('keeps overflow checks in projected count accumulation', () => {
        const wire = new V10HicFile({file: {}})
        const records = packed([[0, 0, (1n << 64n) - 1n], [1, 0, 1n]])
        expect(() => wire._projectBlock(records, {blockPosition: 10, storedByteLength: 100},
            {valueType: 0, binSize: 10, unit: 0}, {binSize: 20, resolutionIndex: 1})).toThrow(/overflow/)
        expect(wire.derivedBlockCache.map.size).toBe(0)
    })
})

describe('V10 concurrent requests', () => {
    it('shares metadata and source decode between simultaneous queries', async () => {
        const file = new MemoryFile(createV10Fixture())
        const read = vi.spyOn(file, 'read')
        const wire = new V10HicFile({file})
        const decode = vi.spyOn(wire, '_decodeBlock')
        const queries = Array.from({length: 6}, (_, i) => wire.getContactRecords('NONE', region(), region(), 'BP', i % 2 ? 20 : 10))
        const results = await Promise.all(queries)
        expect(results.every(records => records.length === 3)).toBe(true)
        expect(decode).toHaveBeenCalledTimes(1)
        const intervals = read.mock.calls.map(([position, length]) => `${position}:${length}`)
        expect(new Set(intervals).size).toBe(intervals.length)
        expect(wire.pendingBlocks.size).toBe(0)
        expect(wire.pendingMetadata.size).toBe(0)
    })

    it('bounds active block loads, shares an in-flight block, and releases slots', async () => {
        const wire = new V10HicFile({file: {}, v10ReadConcurrency: 2})
        const releases = []
        let active = 0, peak = 0
        const load = vi.spyOn(wire, '_loadBlock').mockImplementation(async () => {
            active++; peak = Math.max(peak, active)
            await new Promise(resolve => releases.push(resolve))
            active--; return packed([[0, 0, 1n]])
        })
        const zoom = {unit: 0, resolutionIndex: 0, valueType: 0}
        const entries = Array.from({length: 4}, (_, i) => ({blockNumber: i, blockPosition: i * 100, storedByteLength: 100}))
        const reads = entries.map(entry => wire._readBlock(entry, zoom, 0, 0))
        reads.push(wire._readBlock(entries[0], zoom, 0, 0))
        await flush()
        expect(active).toBe(2)
        releases.splice(0).forEach(release => release())
        await flush()
        expect(active).toBe(2)
        releases.splice(0).forEach(release => release())
        await Promise.all(reads)
        expect(load).toHaveBeenCalledTimes(4)
        expect(peak).toBe(2)
        expect(wire.activeBlockLoads).toBe(0)
        expect(wire.pendingBlocks.size).toBe(0)
    })

    it('can retry a failed shared load without poisoning the cache or queue', async () => {
        const wire = new V10HicFile({file: {}})
        const load = vi.spyOn(wire, '_loadBlock').mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue(packed([[0, 0, 1n]]))
        const entry = {blockNumber: 0, blockPosition: 100, storedByteLength: 100}
        const zoom = {unit: 0, resolutionIndex: 0, valueType: 0}
        const first = await Promise.allSettled([wire._readBlock(entry, zoom, 0, 0), wire._readBlock(entry, zoom, 0, 0)])
        expect(first.every(r => r.status === 'rejected')).toBe(true)
        expect(wire.activeBlockLoads).toBe(0)
        expect(wire.blockCache.map.size).toBe(0)
        await wire._readBlock(entry, zoom, 0, 0)
        expect(load).toHaveBeenCalledTimes(2)
        expect(wire.blockCache.map.size).toBe(1)
    })
})

describe('V10 read-ahead memory bounds', () => {
    it('serializes reads that would exceed the byte budget and permits one oversized block', async () => {
        const wire = new V10HicFile({file: {}, v10ReadConcurrency: 2, v10ReadAheadBytes: 150})
        const releases = []
        vi.spyOn(wire, '_loadBlock').mockImplementation(async () => {
            await new Promise(resolve => releases.push(resolve))
            return packed([[0, 0, 1n]])
        })
        const zoom = {unit: 0, resolutionIndex: 0, valueType: 0}
        const reads = [100, 100, 200].map((bytes, i) => wire._readBlock({blockNumber: i, blockPosition: i * 1000, storedByteLength: bytes}, zoom, 0, 0))
        await flush()
        expect(wire.activeBlockLoads).toBe(1); expect(wire.activeBlockBytes).toBe(100)
        releases.shift()(); await flush()
        expect(wire.activeBlockLoads).toBe(1); expect(wire.activeBlockBytes).toBe(100)
        releases.shift()(); await flush()
        expect(wire.activeBlockLoads).toBe(1); expect(wire.activeBlockBytes).toBe(200)
        releases.shift()(); await Promise.all(reads)
        expect(wire.activeBlockLoads).toBe(0); expect(wire.activeBlockBytes).toBe(0)
    })
})

describe('V10 vector and adjacent-range reuse', () => {
    it('shares complete indexes and vector chunks between concurrent normalized O/E queries', async () => {
        const file = new MemoryFile(createV10Fixture({expected: true}))
        const read = vi.spyOn(file, 'read')
        const wire = new V10HicFile({file})
        const queries = await Promise.all(Array.from({length: 6}, () =>
            wire.getContactRecords('VC', region(), region(), 'BP', 20, 'oe')))
        queries.forEach(records => expect(triples(records)).toEqual(triples(queries[0])))
        expect(queries[0]).toHaveLength(3)
        const intervals = read.mock.calls.map(([p, n]) => `${p}:${n}`)
        expect(new Set(intervals).size).toBe(intervals.length)
        expect(wire.pendingVectors.size).toBe(0)
    })

    it('fetches adjacent requested blocks together and shares their in-flight results', async () => {
        const file = {read: vi.fn(async (p, n) => new ArrayBuffer(n))}
        const wire = new V10HicFile({file})
        const zoom = {unit: 0, resolutionIndex: 0, valueType: 0}
        const entries = [0, 1].map(i => ({blockNumber: i, blockPosition: 100 + 50 * i, storedByteLength: 50}))
        vi.spyOn(wire, '_loadBlock').mockImplementation(async entry => packed([[entry.blockNumber, 0, 1n]]))
        const reads = wire._prefetchBlocks(entries, zoom, 0, 1)
        const same = wire._readBlock(entries[1], zoom, 0, 1)
        const blocks = await Promise.all([...reads, same])
        expect(file.read.mock.calls).toEqual([[100, 100]])
        expect(blocks[1]).toBe(blocks[2])
        expect(wire.pendingBlocks.size).toBe(0)
    })
})
