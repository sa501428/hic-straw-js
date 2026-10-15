import {assert} from 'chai'
import {rejects as assertRejects} from 'node:assert/strict'
import {describe, it, afterEach, vi} from 'vitest'
import RemoteFile, {defaultMapUrl} from '../src/io/remoteFile.js'

// Synthetic responses only.  The motivating failure -- an AWS WAF captcha challenge -- cannot be
// reproduced here: it keys on the Origin header, which node never sends.  It is verified by hand
// in a browser instead.

function stubFetch(response, capture) {
    vi.stubGlobal('fetch', async (url, init) => {
        if (capture) {
            capture.url = url
            capture.init = init
        }
        return response
    })
}

describe('defaultMapUrl', function () {

    it('rewrites a dropbox share link to the direct-download host', function () {
        assert.equal(
            defaultMapUrl('https://www.dropbox.com/s/abc123/matrix.hic?dl=0'),
            'https://dl.dropboxusercontent.com/s/abc123/matrix.hic?dl=0')
    })

    it('rewrites an ncbi ftp url to https', function () {
        assert.equal(
            defaultMapUrl('ftp://ftp.ncbi.nlm.nih.gov/pub/matrix.hic'),
            'https://ftp.ncbi.nlm.nih.gov/pub/matrix.hic')
    })

    it('passes an unrelated url through untouched', function () {
        const url = 'https://hicfiles.s3.amazonaws.com/hiseq/gm12878/in-situ/primary.hic'
        assert.equal(defaultMapUrl(url), url)
    })
})

describe('RemoteFile url mapping', function () {

    it('applies the default rules when no mapUrl is supplied', function () {
        const file = new RemoteFile({url: 'https://www.dropbox.com/s/abc123/matrix.hic'})
        assert.equal(file.url, 'https://dl.dropboxusercontent.com/s/abc123/matrix.hic')
    })

    it('composes a supplied mapUrl on top of the default rules', function () {
        const file = new RemoteFile({
            url: 'https://www.encodeproject.org/files/ENCFF464WXY/@@download/ENCFF464WXY.hic',
            mapUrl: url => url.replace('https://www.encodeproject.org', 'http://localhost:9000/encode')
        })
        assert.equal(file.url, 'http://localhost:9000/encode/files/ENCFF464WXY/@@download/ENCFF464WXY.hic')
    })

    it('still applies the default rules when a mapUrl is supplied', function () {
        // A consumer supplying mapUrl for one host must not lose the dropbox rewrite for another.
        const seen = []
        const file = new RemoteFile({
            url: 'https://www.dropbox.com/s/abc123/matrix.hic',
            mapUrl: url => {
                seen.push(url)
                return url
            }
        })
        assert.equal(seen[0], 'https://dl.dropboxusercontent.com/s/abc123/matrix.hic')
        assert.equal(file.url, 'https://dl.dropboxusercontent.com/s/abc123/matrix.hic')
    })

    it('maps a path argument as well as a url argument', function () {
        const file = new RemoteFile({path: 'ftp://ftp.ncbi.nlm.nih.gov/pub/matrix.hic'})
        assert.equal(file.url, 'https://ftp.ncbi.nlm.nih.gov/pub/matrix.hic')
    })
})

describe('RemoteFile read', function () {

    afterEach(function () {
        vi.unstubAllGlobals()
    })

    it('rejects a wrong range before consuming its body', async function () {
        const body = vi.fn(async () => new ArrayBuffer(4))
        const cancel = vi.fn(async () => {})
        stubFetch({status: 206, headers: new Headers({'Content-Range': 'bytes 0-3/100'}),
            arrayBuffer: body, body: {cancel}})
        await assertRejects(new RemoteFile({url: 'https://example.org/map.hic'}).read(50, 4), /wrong byte range/)
        assert.equal(body.mock.calls.length, 0)
        assert.equal(cancel.mock.calls.length, 1)
    })

    it('rejects ignored Range without downloading the whole file', async function () {
        const body = vi.fn(async () => new ArrayBuffer(1000000))
        const cancel = vi.fn(async () => {})
        const fetch = vi.fn(async () => ({status: 200,
            headers: new Headers({'Content-Length': '1000000'}), arrayBuffer: body, body: {cancel}}))
        vi.stubGlobal('fetch', fetch)
        await assertRejects(new RemoteFile({url: 'https://example.org/map.hic'}).read(0, 88), error => {
            assert.match(error.message, /byte ranges.*HTTP 200, bytes=0-87/)
            assert.equal(error.code, 200)
            assert.equal(error.range, 'bytes=0-87')
            assert.equal(error.url, 'https://example.org/map.hic')
            return true
        })
        assert.equal(fetch.mock.calls.length, 2)
        assert.equal(cancel.mock.calls.length, 2)
        assert.equal(body.mock.calls.length, 0)
    })

    it('recovers from an ignored Range by retrying the same request once', async function () {
        const body = vi.fn()
        const cancel = vi.fn(async () => {})
        const bytes = new Uint8Array([1, 2, 3, 4])
        const fetch = vi.fn()
            .mockResolvedValueOnce({status: 200, body: {cancel}, arrayBuffer: body})
            .mockImplementationOnce(async () => {
                assert.equal(cancel.mock.calls.length, 1, 'cancel before retrying')
                return {status: 206, headers: new Headers({'Content-Range': 'bytes 50-53/100'}),
                    arrayBuffer: async () => bytes.buffer}
            })
        vi.stubGlobal('fetch', fetch)
        const file = new RemoteFile({url: 'https://example.org/map.hic',
            headers: {'X-Test': 'kept'}, oauthToken: 'token'})
        assert.deepEqual(new Uint8Array(await file.read(50, 4)), bytes)
        assert.equal(await file.getSize(), 100)
        assert.equal(body.mock.calls.length, 0)
        assert.equal(fetch.mock.calls.length, 2)
        const [first, second] = fetch.mock.calls
        assert.equal(second[0], first[0])
        assert.deepEqual(second[1].headers, first[1].headers)
        assert.equal(second[1].headers.Range, 'bytes=50-53')
        assert.equal(second[1].headers.Authorization, 'Bearer token')
        assert.equal(second[1].headers['X-Test'], 'kept')
        assert.isUndefined(first[1].cache)
        assert.equal(second[1].cache, 'no-store')
    })

    it('does not retry HTTP errors or successful range requests', async function () {
        for (const status of [403, 503, 206]) {
            const fetch = vi.fn(async () => ({status, headers: new Headers(),
                arrayBuffer: async () => new ArrayBuffer(4)}))
            vi.stubGlobal('fetch', fetch)
            const read = new RemoteFile({url: 'https://example.org/map.hic'}).read(0, 4)
            if (status === 206) await read
            else await assertRejects(read, error => error.code === status)
            assert.equal(fetch.mock.calls.length, 1)
        }
    })

    it('validates the exact returned range and body length', async function () {
        const file = new RemoteFile({url: 'https://example.org/map.hic'})
        stubFetch({status: 206, headers: new Headers({'Content-Range': 'bytes 50-53/100'}),
            arrayBuffer: async () => new ArrayBuffer(4)})
        assert.equal((await file.read(50, 4)).byteLength, 4)
        assert.equal(await file.getSize(), 100)
        stubFetch({status: 206, arrayBuffer: async () => new ArrayBuffer(3)})
        await assertRejects(file.read(50, 4), /length mismatch/)
    })

    it('requests the byte range it was asked for, from the mapped url', async function () {
        const capture = {}
        stubFetch({status: 206, arrayBuffer: async () => new ArrayBuffer(128)}, capture)

        const file = new RemoteFile({
            url: 'https://example.org/matrix.hic',
            mapUrl: url => url.replace('https://example.org', 'http://localhost:9000')
        })
        await file.read(0, 128)

        assert.equal(capture.url, 'http://localhost:9000/matrix.hic')
        assert.equal(capture.init.headers['Range'], 'bytes=0-127')
    })

    it('does not mutate the headers object it was configured with', async function () {
        const headers = {'Authorization': 'Bearer xyz'}
        stubFetch({status: 206, arrayBuffer: async () => new ArrayBuffer(16)})

        const file = new RemoteFile({url: 'https://example.org/matrix.hic', headers})
        await file.read(0, 16)

        assert.deepEqual(headers, {'Authorization': 'Bearer xyz'})
    })

    it('carries response detail on the thrown error', async function () {
        stubFetch({
            status: 405,
            statusText: '',                                        // empty over HTTP/2
            headers: new Headers({'X-Amzn-Waf-Action': 'captcha'})
        })

        const file = new RemoteFile({
            url: 'https://www.encodeproject.org/files/ENCFF464WXY/@@download/ENCFF464WXY.hic',
            mapUrl: url => url.replace('https://www.encodeproject.org', 'http://localhost:9000/encode')
        })

        let error
        try {
            await file.read(0, 16)
        } catch (e) {
            error = e
        }

        assert.ok(error, 'read should reject on a 405')
        assert.equal(error.code, 405)
        assert.equal(error.headers.get('x-amzn-waf-action'), 'captcha')
        assert.equal(error.url, 'http://localhost:9000/encode/files/ENCFF464WXY/@@download/ENCFF464WXY.hic')
        assert.isNotEmpty(error.message)
    })

    it('falls back to HEAD when a range response does not expose the total size', async function () {
        const methods = []
        vi.stubGlobal('fetch', async (url, init) => {
            methods.push(init.method)
            if (init.method === 'HEAD') {
                return {status: 200, headers: new Headers({'Content-Length': '1234'})}
            }
            return {
                status: 206,
                headers: new Headers({'Content-Length': '1'}),
                arrayBuffer: async () => new Uint8Array([7]).buffer
            }
        })
        const file = new RemoteFile({url: 'https://example.org/matrix.hic'})
        assert.equal(await file.getSize(), 1234)
        assert.deepEqual(methods, ['GET', 'HEAD'])
    })
})
