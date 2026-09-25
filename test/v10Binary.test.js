import {assert} from 'chai'
import {describe, it} from 'vitest'
import {V10Cursor} from '../src/v10/binary.js'
import {validateSingleFrame} from '../src/v10/zstd.js'
import {candidateBlockRanges, depthForDistance} from '../src/v10/hicFile.js'

describe('.hic v10 binary primitives', function () {
    it('decodes canonical uint64 ULEB128 values', function () {
        assert.strictEqual(new V10Cursor(new Uint8Array([0])).uleb128(), 0n)
        assert.strictEqual(new V10Cursor(new Uint8Array([0xac, 0x02])).uleb128(), 300n)
        assert.strictEqual(new V10Cursor(new Uint8Array([
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01
        ])).uleb128(), (1n << 64n) - 1n)
    })

    it('rejects noncanonical, unterminated, and overflowing ULEB128 values', function () {
        assert.throws(() => new V10Cursor(new Uint8Array([0x80, 0])).uleb128(), /non-canonical/)
        assert.throws(() => new V10Cursor(new Uint8Array([0x80])).uleb128(), /truncated/)
        assert.throws(() => new V10Cursor(new Uint8Array([
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02
        ])).uleb128(), /overflows/)
    })

    it('decodes UTF-8 C strings and rejects malformed input', function () {
        const encoded = new Uint8Array([...new TextEncoder().encode('grüße'), 0])
        assert.equal(new V10Cursor(encoded).cstr(), 'grüße')
        assert.throws(() => new V10Cursor(new Uint8Array([0xc3, 0x28, 0])).cstr(), /invalid UTF-8/)
        assert.throws(() => new V10Cursor(new Uint8Array([65])).cstr(), /unterminated/)
    })

    it('accepts exactly one raw Zstandard frame and rejects trailing frames', function () {
        const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 1, 9, 0, 0, 42])
        validateSingleFrame(frame)
        assert.throws(() => validateSingleFrame(new Uint8Array([...frame, ...frame])), /trailing bytes/)
    })

    it('uses exact nonzero distance bands for far-cis queries', function () {
        const zoom = {gridType: 1, blockBinCount: 4, blockColumnCount: 100}
        const ranges = candidateBlockRanges(zoom, 0, 4, 64, 68)
        assert.isAbove(ranges[0].first, 0)
        assert.equal(Math.floor(ranges[0].first / 100), depthForDistance(61, 4))
    })
})
