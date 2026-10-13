/** Optional scaled-All convention; the underlying V10 chromosome stays ordinary. */
export function allOverview(attributes, chromosomes, bpResolutions) {
    const version = Number(attributes['hicAll.version'])
    if (version !== 1 && version !== 2) return undefined
    const chromosome = chromosomes.find(c => c.name.toLowerCase() === 'all')
    const integer = key => {
        const text = attributes[`hicAll.${key}`]
        const value = Number(text)
        if (!/^\d+$/.test(text || '') || !Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`V10: invalid scaled All ${key}`)
        }
        return value
    }
    const sourceResolution = integer('sourceResolution')
    const groupFactor = integer('groupFactor')
    const finestResolution = integer('finestResolution')
    const binCount = integer('binCount')
    const real = chromosomes.filter(c => c !== chromosome)
    const chromosomeBins = (attributes['hicAll.chromosomeBins'] || '').split(',').map(Number)
    if (version === 2) {
        const coordinateScale = integer('coordinateScale')
        const storageStride = integer('storageStride')
        const displayResolution = finestResolution * storageStride
        const effectiveResolution = displayResolution * coordinateScale
        let offset = 0
        const layout = real.map(chr => {
            const entry = {index: chr.index, name: chr.name, offset, size: chr.size}
            offset += chr.size
            return entry
        })
        if (!chromosome || finestResolution !== bpResolutions[0] ||
            !Number.isSafeInteger(offset) || !Number.isSafeInteger(effectiveResolution) ||
            chromosome.size !== Math.max(1, Math.floor(offset / coordinateScale)) ||
            binCount !== Math.ceil(chromosome.size / displayResolution) ||
            chromosomeBins.length !== real.length ||
            chromosomeBins.some((n, i) => n !== Math.ceil(real[i].size / sourceResolution))) {
            throw new Error('V10: inconsistent kilobase All layout')
        }
        return {version, chromosomeIndex: chromosome.index, sourceResolution, groupFactor,
            finestResolution, binCount, coordinateScale, storageStride, displayResolution,
            effectiveResolution, layout, syntheticLength: chromosome.size, displayLength: binCount * effectiveResolution}
    }
    const effectiveResolution = sourceResolution * groupFactor
    if (!chromosome || finestResolution !== bpResolutions[0] ||
        chromosome.size !== binCount * finestResolution ||
        !Number.isSafeInteger(effectiveResolution) || chromosomeBins.length !== real.length ||
        chromosomeBins.some((n, i) => !Number.isSafeInteger(n) || n !== Math.ceil(real[i].size / sourceResolution))) {
        throw new Error('V10: inconsistent scaled All layout')
    }
    let offset = 0
    const layout = real.map((chr, i) => {
        const entry = {index: chr.index, name: chr.name, offset, size: chromosomeBins[i] * sourceResolution}
        offset += entry.size
        return entry
    })
    if (Math.ceil(offset / effectiveResolution) !== binCount) throw new Error('V10: inconsistent scaled All bin count')
    return {version, coordinateScale: undefined, storageStride: 1, displayResolution: finestResolution,
        chromosomeIndex: chromosome.index, sourceResolution, groupFactor,
        finestResolution, binCount, effectiveResolution, layout,
        displayLength: binCount * effectiveResolution}
}
