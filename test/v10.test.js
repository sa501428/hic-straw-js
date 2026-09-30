import {assert} from 'chai'
import {describe, it, vi} from 'vitest'
import HicFile from '../src/hicFile.js'
import Straw from '../src/straw.js'
import {MemoryFile, createV10Fixture} from './helpers/v10Fixture.js'

function strawFor(options) {
    return new Straw({file: new MemoryFile(createV10Fixture(options))})
}

describe('.hic v10', function () {
    it('reads metadata and the numeric matrix directory', async function () {
        const straw = strawFor()
        const meta = await straw.getMetaData()
        assert.equal(meta.version, 10)
        assert.equal(meta.genome, 'test')
        assert.deepEqual(meta.resolutions, [10, 20])
        assert.equal(meta.chromosomes[0].name, 'chrA')
        assert.deepEqual(meta.attributeList, [['duplicate', 'one'], ['duplicate', 'two']])
        assert.equal(meta.attributes.duplicate, 'two')
    })

    it('allows readFooter to initialize a v10 file directly', async function () {
        const hic = new HicFile({file: new MemoryFile(createV10Fixture())})
        await hic.readFooter()
        assert.equal(hic.version, 10)
        assert.property(hic.masterIndex, '0_0')
    })

    for (const representation of [0, 1, 2]) {
        for (const mode of representation === 2 ? [2] : [0, 1, 2]) {
            it(`decodes representation ${representation}, value mode ${mode}`, async function () {
                const counts = mode === 0 ? [1n, 1n, 1n] : [1n, 1n, 5n]
                const records = await strawFor({representation, mode, counts}).getContactRecords(
                    'NONE', {chr: 'A', start: 0, end: 80}, {chr: 'chrA', start: 0, end: 80}, 'BP', 10)
                assert.deepEqual(records.map(r => [r.bin1, r.bin2, r.counts]),
                    [[0, 0, Number(counts[0])], [1, 2, Number(counts[1])], [3, 3, Number(counts[2])]])
            })
        }
    }

    it('derives a resolution by exact raw summation', async function () {
        const records = await strawFor().getContactRecords(
            'NONE', {chr: 'chrA', start: 0, end: 80}, {chr: 'chrA', start: 0, end: 80}, 'BP', 20)
        assert.deepEqual(records.map(r => [r.bin1, r.bin2, r.counts]), [[0, 0, 1], [0, 1, 1], [1, 1, 5]])
    })

    it('derives an arbitrary target from its declared materialized source', async function () {
        const records = await strawFor({targetBinSize: 30}).getContactRecords(
            'NONE', {chr: 'chrA', start: 0, end: 80}, {chr: 'chrA', start: 0, end: 80}, 'BP', 30)
        assert.deepEqual(records.map(r => [r.bin1, r.bin2, r.counts]), [[0, 0, 2], [1, 1, 5]])
    })

    it('honors a user-declared materialized resolution instead of enforcing the default pyramid', async function () {
        const records = await strawFor({targetMaterialized: true}).getContactRecords(
            'NONE', {chr: 'chrA', start: 0, end: 80}, {chr: 'chrA', start: 0, end: 80}, 'BP', 20)
        assert.deepEqual(records.map(r => [r.bin1, r.bin2, r.counts]), [[0, 0, 1], [1, 2, 1], [3, 3, 5]])
    })

    for (const representation of [0, 1, 2]) {
        it(`decodes score representation ${representation}`, async function () {
            const records = await strawFor({representation, mode: 2, counts: [1.25, 0.5, 2.75], score: true})
                .getContactRecords('NONE', {chr: 'chrA', start: 0, end: 80},
                    {chr: 'chrA', start: 0, end: 80}, 'BP', 10)
            assert.deepEqual(records.map(r => r.counts), [1.25, 0.5, 2.75])
        })
    }

    it('transposes a rectangular trans matrix back to caller chromosome order', async function () {
        const records = await strawFor({trans: true}).getContactRecords(
            'NONE', {chr: 'chrB', start: 0, end: 70}, {chr: 'chrA', start: 0, end: 80}, 'BP', 10)
        assert.deepEqual(records.map(r => [r.bin1, r.bin2]), [[0, 0], [2, 1], [3, 3]])
    })

    it('transposes a reversed cis window back to caller region order', async function () {
        const records = await strawFor().getContactRecords('NONE',
            {chr: 'chrA', start: 20, end: 30}, {chr: 'chrA', start: 10, end: 20}, 'BP', 10)
        assert.deepEqual(records.map(record => [record.bin1, record.bin2, record.counts]), [[2, 1, 1]])
    })

    it('queries materialized FRAG data', async function () {
        const records = await strawFor({frag: true}).getContactRecords(
            'NONE', {chr: 'chrA', start: 0, end: 8}, {chr: 'chrA', start: 0, end: 8}, 'FRAG', 1)
        assert.equal(records.length, 3)
    })

    for (const transform of [0, 1, 2]) {
        it(`reads normalization vector transform ${transform}`, async function () {
            const records = await strawFor({transform}).getContactRecords(
                'VC', {chr: 'chrA', start: 0, end: 80}, {chr: 'chrA', start: 0, end: 80}, 'BP', 10)
            assert.deepEqual(records.map(r => r.counts), [0.25, 0.25, 1.25])
        })
    }

    it('preserves counts above Number.MAX_SAFE_INTEGER as bigint', async function () {
        const exact = (1n << 53n) + 1n
        const records = await strawFor({counts: [exact, 1n, 5n]}).getContactRecords(
            'NONE', {chr: 'chrA', start: 0, end: 80}, {chr: 'chrA', start: 0, end: 80}, 'BP', 10)
        assert.strictEqual(records[0].counts, exact)
    })

    it('exposes normalization options, vectors, and the direct NVI locator', async function () {
        const file = new MemoryFile(createV10Fixture())
        const hic = new HicFile({file})
        assert.deepEqual(await hic.getNormalizationOptions(), ['NONE', 'VC'])
        assert.isTrue(await hic.hasNormalizationVector('VC', 'chrA', 'BP', 20))
        const vector = await hic.getNormalizationVector('VC', 'A', 'BP', 20)
        assert.equal(vector.nValues, 4)
        assert.deepEqual(await vector.getValues(0, 4), [4, 4, 4, 4])
        const straw = new Straw({file})
        assert.match(await straw.getNVI(), /^\d+,\d+$/)
    })

    it('reads raw and normalized expected-value vectors with chromosome scaling', async function () {
        const straw = strawFor({expected: true})
        assert.isTrue(await straw.hasExpectedValues('NONE', 'chrA', 'BP', 10))
        assert.isTrue(await straw.hasExpectedValues('VC', 'A', 'BP', 10))
        assert.deepEqual(await straw.getExpectedValues('NONE', 'chrA', 'BP', 10, 0, 3), [5, 10, 15])
        assert.deepEqual(await straw.getExpectedValues('VC', 'chrA', 'BP', 10, 0, 3), [4, 8, 12])
        assert.isUndefined(await straw.getExpectedValues('KR', 'chrA', 'BP', 10))
    })

    it('supports expected and observed/expected contact queries', async function () {
        const straw = strawFor({expected: true})
        const args = [{chr: 'chrA', start: 0, end: 80}, {chr: 'chrA', start: 0, end: 80}, 'BP', 10]
        const expected = await straw.getContactRecords('NONE', ...args, 'expected')
        assert.deepEqual(expected.map(record => record.counts), [5, 10, 5])
        const oe = await straw.getContactRecords('NONE', ...args, 'oe')
        assert.deepEqual(oe.map(record => record.counts), [0.2, 0.1, 1])
        const normalizedExpected = await straw.getContactRecords('VC', ...args, 'expected')
        assert.deepEqual(normalizedExpected.map(record => record.counts), [4, 8, 4])
        const normalizedOe = await straw.getContactRecords('VC', ...args, 'oe')
        assert.deepEqual(normalizedOe.map(record => record.counts), [0.0625, 0.03125, 0.3125])
    })

    it('exposes physical v10 blocks through getBlocks and readBlock', async function () {
        const hic = new HicFile({file: new MemoryFile(createV10Fixture())})
        const matrix = await hic.getMatrix(0, 0)
        const zoom = matrix.getZoomData(10, 'BP')
        const direct = await hic.readBlock(0, zoom)
        assert.equal(direct.blockNumber, 0)
        assert.deepEqual(direct.records.map(record => record.counts), [1, 1, 5])
        assert.equal((await zoom.blockIndex.getBlockIndexEntry(0)).blockNumber, 0)
        const blocks = await hic.getBlocks({chr: 'chrA', start: 0, end: 80},
            {chr: 'chrA', start: 0, end: 80}, 'BP', 10)
        assert.deepEqual(blocks.map(block => block.blockNumber), [0])
    })

    it('rejects the pre-final H10I version 1 layout', async function () {
        let error
        try {
            await strawFor({oldIndex: true}).getContactRecords(
                'NONE', {chr: 'chrA', start: 0, end: 80}, {chr: 'chrA', start: 0, end: 80}, 'BP', 10)
        } catch (value) { error = value }
        assert.match(error.message, /draft H10I version 1 is unsupported/)
    })

    it('uses bounded reads and reuses parsed metadata', async function () {
        const bytes = createV10Fixture()
        const file = new MemoryFile(bytes)
        file.reads = []
        const originalRead = file.read.bind(file)
        file.read = async (position, length) => {
            file.reads.push({position, length})
            return originalRead(position, length)
        }
        const straw = new Straw({file})
        const query = () => straw.getContactRecords('NONE',
            {chr: 'chrA', start: 0, end: 40}, {chr: 'chrA', start: 0, end: 40}, 'BP', 10)
        await query()
        const firstReadCount = file.reads.length
        await query()
        assert.equal(file.reads.length, firstReadCount)
        assert.isTrue(file.reads.every(read => read.length < bytes.length))
    })

    it('uses config.fileSize when a custom getSize method cannot determine a size', async function () {
        const bytes = createV10Fixture()
        const file = new MemoryFile(bytes)
        file.getSize = async () => undefined
        const records = await new Straw({file, fileSize: bytes.length}).getContactRecords('NONE',
            {chr: 'chrA', start: 0, end: 40}, {chr: 'chrA', start: 0, end: 40}, 'BP', 10)
        assert.equal(records.length, 3)
    })

    it('queries v10 through HTTP byte ranges', async function () {
        const bytes = createV10Fixture()
        const ranges = []
        vi.stubGlobal('fetch', async (url, init) => {
            const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range)
            const start = Number(match[1])
            const end = Math.min(Number(match[2]), bytes.length - 1)
            ranges.push([start, end])
            const part = bytes.slice(start, end + 1)
            return {
                status: 206,
                headers: new Headers({
                    'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
                    'Content-Length': String(part.length)
                }),
                arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)
            }
        })
        try {
            const straw = new Straw({url: 'https://example.org/test-v10.hic'})
            const records = await straw.getContactRecords('NONE',
                {chr: 'chrA', start: 0, end: 40}, {chr: 'chrA', start: 0, end: 40}, 'BP', 10)
            assert.equal(records.length, 3)
            assert.isTrue(ranges.every(([start, end]) => end - start + 1 < bytes.length))
        } finally {
            vi.unstubAllGlobals()
        }
    })
})
