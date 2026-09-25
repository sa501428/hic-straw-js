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
        const response = await fetchFunction(url, {
            method: 'GET',
            headers: headers,
            redirect: 'follow',
            mode: 'cors',

        })

        const status = response.status

        if (status >= 400) {
            // statusText is empty over HTTP/2, so build a message that is never blank
            const err = Error(`${status} ${response.statusText || 'error'} — ${url}`)
            err.code = status
            err.headers = response.headers   // Headers instance, filtered by CORS in the browser
            err.url = url                    // the url actually fetched, after mapping
            throw err
        } else {
            const contentRange = response.headers?.get?.('content-range')
            if (contentRange) {
                const match = /\/([0-9]+)$/.exec(contentRange)
                if (match) this.size = Number(match[1])
            } else if (status === 200) {
                const contentLength = response.headers?.get?.('content-length')
                if (contentLength) this.size = Number(contentLength)
            }

            const result = await response.arrayBuffer()
            if (status === 200 && result.byteLength !== length) {
                if (this.size === undefined) this.size = result.byteLength
                return result.slice(position, position + length)
            }
            return result
        }

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
