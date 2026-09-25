import HicFile from "./hicFile.js"

class Straw {

    constructor(config) {
        this.config = config;
        if (config.liveContactMap) {
            this.hicFile = config.liveContactMap;
        } else {
            this.hicFile = new HicFile(config);
        }
    }

    async getMetaData() {
        return await this.hicFile.getMetaData()
    }

    //straw <NONE/VC/VC_SQRT/KR> <ile> <chr1>[:x1:x2] <chr2>[:y1:y2] <BP/FRAG> <binsize>
    async getContactRecords(normalization, region1, region2, units, binsize, matrixType = 'observed') {
        return this.hicFile.getContactRecords(normalization, region1, region2, units, binsize, false, matrixType);
    }

    async getNormalizationOptions() {
        return this.hicFile.getNormalizationOptions()
    }

    async getExpectedValues(normalization, chromosome, units, binsize, start = 0, end) {
        return this.hicFile.getExpectedValues(normalization, chromosome, units, binsize, start, end)
    }

    async hasExpectedValues(normalization, chromosome, units, binsize) {
        return this.hicFile.hasExpectedValues(normalization, chromosome, units, binsize)
    }

    async getNVI() {
        await this.hicFile.getNormVectorIndex()
        return this.hicFile.config.nvi;
    }

    async printIndexStats() {
        await this.hicFile.printIndexStats();
    }

    getFileChrName(chrAlias) {
        if (this.hicFile.chrAliasTable.hasOwnProperty(chrAlias)) {
            return this.hicFile.chrAliasTable[chrAlias]
        } else {
            return chrAlias
        }
    }
}


export default Straw
