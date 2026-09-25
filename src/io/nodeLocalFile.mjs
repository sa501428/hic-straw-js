import * as util from "util"
import * as fs from "fs"

let fsOpen =util.promisify(fs.open)
let fsRead =util.promisify(fs.read)
let fsStat = util.promisify(fs.stat)

class NodeLocalFile {

    constructor(args) {
        this.path = args.path
    }


    async read(position, length) {

        const buffer = Buffer.alloc(length)
        const fd = await fsOpen(this.path, 'r')
        const result = await fsRead(fd, buffer, 0, length, position)

        fs.close(fd, function (error) {
            // TODO Do something with error
        })

        //TODO -- compare result.bytesRead with length
        const b = result.buffer.subarray(0, result.bytesRead);
        const arrayBuffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        return arrayBuffer
    }

    async getSize() {
        if (this.size === undefined) {
            const stat = await fsStat(this.path)
            this.size = stat.size
        }
        return this.size
    }
}

export default NodeLocalFile
