class BrowserLocalFile {

    constructor(blob) {
        this.file = blob
    }

    async read(position, length) {
        const file = this.file
        if (position !== undefined) {
            return file.slice(position, position + length).arrayBuffer()

        } else {
            return file.arrayBuffer()

        }
    }

    async getSize() {
        return this.file.size
    }
}

export default BrowserLocalFile
