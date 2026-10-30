let _distPrev = new Uint16Array(0);
let _distCurr = new Uint16Array(0);
export function distance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    if (a.length > b.length) [a, b] = [
        b,
        a
    ];
    const m = a.length;
    const n = b.length;
    if (_distPrev.length < m + 1) {
        _distPrev = new Uint16Array(m + 1);
        _distCurr = new Uint16Array(m + 1);
    }
    let prev = _distPrev;
    let curr = _distCurr;
    for(let i = 0; i <= m; i++)prev[i] = i;
    for(let j = 1; j <= n; j++){
        curr[0] = j;
        for(let i = 1; i <= m; i++){
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
        }
        const tmp = prev;
        prev = curr;
        curr = tmp;
    }
    return prev[m];
}
export function ratio(a, b) {
    const lenSum = a.length + b.length;
    if (lenSum === 0) return 1.0;
    return (lenSum - distance(a, b)) / lenSum;
}
let _sgPrev = new Uint16Array(0);
let _sgCurr = new Uint16Array(0);
export function semiGlobalDistance(query, ref) {
    if (query.length === 0) return 0;
    if (ref.length === 0) return query.length;
    const m = query.length;
    const n = ref.length;
    if (_sgPrev.length < m + 1) {
        _sgPrev = new Uint16Array(m + 1);
        _sgCurr = new Uint16Array(m + 1);
    }
    let prev = _sgPrev;
    let curr = _sgCurr;
    for(let i = 0; i <= m; i++)prev[i] = i;
    let best = prev[m];
    for(let j = 1; j <= n; j++){
        curr[0] = 0;
        for(let i = 1; i <= m; i++){
            const cost = query[i - 1] === ref[j - 1] ? 0 : 1;
            curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
        }
        best = Math.min(best, curr[m]);
        const tmp = prev;
        prev = curr;
        curr = tmp;
    }
    return best;
}
export function fragmentScore(query, ref) {
    if (query.length === 0) return 1.0;
    return Math.max(0, 1 - semiGlobalDistance(query, ref) / query.length);
}


//# sourceURL=levenshtein.ts