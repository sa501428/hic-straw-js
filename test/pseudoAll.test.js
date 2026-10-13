import {assert} from 'chai'
import {describe, it} from 'vitest'
import {readFileSync} from 'node:fs'
import Straw from '../src/straw.js'
import {MemoryFile} from './helpers/v10Fixture.js'
import {allOverview} from '../src/v10/allOverview.js'

const bytes = readFileSync(new URL('./data/pseudo-all.hic', import.meta.url))
describe('stored scaled All', () => {
    it('exposes its physical layout while retaining ordinary synthetic queries', async () => {
        const straw = new Straw({file: new MemoryFile(bytes)})
        const meta = await straw.getMetaData()
        const all = meta.allOverview
        assert.equal(all.chromosomeIndex, 2)
        assert.equal(all.finestResolution, 1)
        assert.equal(all.effectiveResolution, 10)
        assert.equal(all.binCount, 18)
        assert.deepEqual(all.layout.map(c => [c.name, c.offset, c.size]), [['chrA', 0, 100], ['chrB', 100, 80]])
        assert.deepEqual(meta.resolutions, [1, 2, 5, 10, 100])
        const records = await straw.getContactRecords('NONE', {chr: 'All', start: 0, end: 18}, {chr: 'All', start: 0, end: 18}, 'BP', 1)
        assert.deepEqual(records.map(r => [r.bin1, r.bin2, r.counts]), [[1, 2, (1n << 53n) + 17n], [1, 10, 13], [10, 17, 19]])
        const collapsed = await straw.getContactRecords('NONE', {chr: 'All', start: 0, end: 18}, {chr: 'All', start: 0, end: 18}, 'BP', 100)
        assert.equal(collapsed.length, 1)
        assert.equal(collapsed[0].counts, (1n << 53n) + 49n)
        assert.deepEqual(await straw.getContactRecords('NONE', {chr: 'All', start: 0, end: 18}, {chr: 'chrA', start: 0, end: 95}, 'BP', 1), [])
    })
    it('rejects inconsistent version-one layouts and ignores unknown conventions', () => {
        const chromosomes = [{index: 0, name: 'chrA', size: 95}, {index: 1, name: 'All', size: 10}]
        const attrs = {'hicAll.version': '1', 'hicAll.sourceResolution': '10', 'hicAll.groupFactor': '1',
            'hicAll.finestResolution': '1', 'hicAll.binCount': '10', 'hicAll.chromosomeBins': '10'}
        assert.equal(allOverview(attrs, chromosomes, [1]).binCount, 10)
        assert.throws(() => allOverview({...attrs, 'hicAll.chromosomeBins': '9'}, chromosomes, [1]), /inconsistent/)
        assert.isUndefined(allOverview({...attrs, 'hicAll.version': 'future'}, chromosomes, [1]))
    })
})

describe('V9-style kilobase All', () => {
    it('keeps the kb span and exact sparse finest-resolution records', async () => {
        const data = readFileSync(new URL('./data/kilobase-all.hic', import.meta.url))
        const straw = new Straw({file: new MemoryFile(data)})
        const meta = await straw.getMetaData()
        const all = meta.allOverview
        assert.equal(all.version, 2)
        assert.equal(meta.chromosomes.find(c => c.name === 'All').size, 170)
        assert.equal(all.finestResolution, 1)
        assert.equal(all.storageStride, 17)
        assert.equal(all.displayResolution, 17)
        assert.equal(all.coordinateScale, 1000)
        assert.equal(all.effectiveResolution, 17000)
        assert.equal(all.binCount, 10)
        assert.deepEqual(all.layout.map(c => [c.offset, c.size]), [[0, 95000], [95000, 75000]])
        const records = await straw.getContactRecords('NONE', {chr: 'All', start: 0, end: 170}, {chr: 'All', start: 0, end: 170}, 'BP', 1)
        assert.deepEqual(records.map(r => [r.bin1, r.bin2, r.counts]), [[0, 17, (1n << 53n) + 17n], [85, 153, 32]])
        assert.throws(() => allOverview({...straw.hicFile.attributes, 'hicAll.storageStride': '20'}, meta.chromosomes, meta.resolutions), /inconsistent/)
    })
})
