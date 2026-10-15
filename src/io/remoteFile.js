const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null

class RemoteFile {

    constructor(args) {
        this.config = args
        const mapped = defaultMapUrl(args.path || args.url)
        this.url = this.config.mapUrl ? this.config.mapUrl(mapped) : mapped
    }


    async read(position, length) {

        length = Math.ceil(length)
        const headers = {...this.config.headers}
        const rangeString = "bytes=" + position + "-" + (position + length - 1)
        headers['Range'] = rangeString

        const url = this.url
        headers['User-Agent'] = 'IGV'
        if (this.config.oauthToken) {
            const token = await resolveToken(this.config.oauthToken)
            headers['Authorization'] = `Bearer ${token}`
        }

        // Some CommonJS dependencies expose node-fetch's module namespace on
        // globalThis.fetch. Accept its default export as a compatibility path.
        const fetchFunction = typeof globalThis.fetch === 'function'
            ? globalThis.fetch
            : globalThis.fetch?.default
        if (typeof fetchFunction !== 'function') throw Error('No fetch implementation is available')
        let response
        for (let attempt = 0; attempt < 2; attempt++) {
            response = await fetchFunction(url, {
                method: 'GET',
                headers: headers,
                redirect: 'follow',
                mode: 'cors',
                ...(attempt === 1 ? {cache: 'no-store'} : {})
            })
            if (response.status === 206 || response.status >= 400 || attempt === 1) break
            // A transient response can ignore Range. Cancel its body before
            // retrying the same interval once, bypassing the browser cache.
            try { await response.body?.cancel?.() } catch (_) { /* best effort */ }
        }

        const status = response.status

        if (status >= 400) {
            // statusText is empty over HTTP/2, so build a message that is never blank
            const err = Error(`${status} ${response.statusText || 'error'} — ${url}`)
            err.code = status
            err.headers = response.headers   // Headers instance, filtered by CORS in the browser
            err.url = url                    // the url actually fetched, after mapping
            throw err
        }
        // Range reads must never turn into unbounded whole-file downloads.
        const reject = async message => {
            try { await response.body?.cancel?.() } catch (_) { /* best effort */ }
            const err = new Error(`${message} (HTTP ${status}, ${rangeString})`)
            err.code = status
            err.headers = response.headers
            err.url = url
            err.range = rangeString
            throw err
        }
        if (status !== 206) return reject('HTTP server must support byte ranges (206)')
        const contentRange = response.headers?.get?.('content-range')
        if (contentRange) {
            const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange)
            const start = match && Number(match[1])
            const end = match && Number(match[2])
            const total = match && Number(match[3])
            if (!match || !Number.isSafeInteger(total) || start !== position ||
                end !== position + length - 1 || end >= total) {
                return reject('HTTP server returned the wrong byte range')
            }
            if (this.size !== undefined && this.size !== total) {
                return reject('HTTP file size changed during reading')
            }
            this.size = total
        }
        // Content-Range may be hidden by CORS. In that case require 206 and an
        // exact body length; getSize() obtains the total via HEAD.
        const result = await response.arrayBuffer()
        if (result.byteLength !== length) throw new Error('HTTP range length mismatch')
        return result

        /**
         * token can be a string, a function that returns a string, or a function that returns a Promise for a string
         * @param token
         * @returns {Promise<*>}
         */
        async function resolveToken(token) {
            if (typeof token === 'function') {
                return await Promise.resolve(token())    // Normalize the result to a promise, since we don't know what the function returns
            } else {
                return token
            }
        }

    }

    async getSize() {
        if (this.size === undefined) await this.read(0, 1)
        if (this.size === undefined) {
            const headers = {...this.config.headers}
            if (this.config.oauthToken) {
                const token = typeof this.config.oauthToken === 'function'
                    ? await Promise.resolve(this.config.oauthToken())
                    : this.config.oauthToken
                headers.Authorization = `Bearer ${token}`
            }
            const fetchFunction = typeof globalThis.fetch === 'function'
                ? globalThis.fetch
                : globalThis.fetch?.default
            if (typeof fetchFunction === 'function') {
                const response = await fetchFunction(this.url, {method: 'HEAD', headers, redirect: 'follow', mode: 'cors'})
                if (response.status < 400) {
                    const contentLength = response.headers?.get?.('content-length')
                    if (contentLength) this.size = Number(contentLength)
                }
            }
        }
        return this.size
    }
}


function defaultMapUrl(url) {

    if (url.includes("//www.dropbox.com")) {
        return url.replace("//www.dropbox.com", "//dl.dropboxusercontent.com")
    } else if (url.startsWith("ftp://ftp.ncbi.nlm.nih.gov")) {
        return url.replace("ftp://", "https://")
    } else {
        return url
    }
}


export default RemoteFile
export {defaultMapUrl}
