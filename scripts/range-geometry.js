// Build only the perimeter of a convex, distance-based square-grid range.
// Each row needs O(log width) PF2e measurements, not a filled grid scan. This
// keeps long weapon ranges cheap and draws no internal cell lines or fill.
export function squareRangeOutline({ grid, bounds, distance, measure, maxRows = 4096 }) {
    const margin = (distance / grid.distance + 2) * grid.sizeX;
    if (![margin, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
        || margin <= 0 || bounds.width <= 0 || bounds.height <= 0) return null;
    const [i0, j0, i1, j1] = grid.getOffsetRange({
        x: bounds.x - margin, y: bounds.y - margin,
        width: bounds.width + margin * 2, height: bounds.height + margin * 2
    });
    if (i1 - i0 > maxRows || j1 - j0 > maxRows || i1 <= i0 || j1 <= j0) return null;
    const center = grid.getOffset({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    const rows = new Map();
    for (let i = i0; i < i1; i++) {
        const inside = j => measure(grid.getCenterPoint({ i, j })) <= distance;
        if (!inside(center.j)) continue;
        let lo = j0, hi = center.j;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (inside(mid)) hi = mid;
            else lo = mid + 1;
        }
        const left = lo;
        lo = center.j; hi = j1 - 1;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (inside(mid)) lo = mid;
            else hi = mid - 1;
        }
        rows.set(i, { left, right: lo + 1 });
    }
    const segments = [];
    const horizontal = (i, left, right) => {
        if (right > left) segments.push([grid.getTopLeftPoint({ i, j: left }), grid.getTopLeftPoint({ i, j: right })]);
    };
    const exposed = (line, row, neighbor) => {
        if (!neighbor) return horizontal(line, row.left, row.right);
        horizontal(line, row.left, Math.min(row.right, neighbor.left));
        horizontal(line, Math.max(row.left, neighbor.right), row.right);
    };
    for (const [i, row] of rows) {
        for (const j of [row.left, row.right]) segments.push([grid.getTopLeftPoint({ i, j }), grid.getTopLeftPoint({ i: i + 1, j })]);
        exposed(i, row, rows.get(i - 1));
        exposed(i + 1, row, rows.get(i + 1));
    }
    if (!segments.length) return null;
    const first = rows.entries().next().value;
    const top = grid.getTopLeftPoint({ i: first[0], j: first[1].left });
    return { segments, label: { x: bounds.x + bounds.width / 2, y: top.y } };
}
