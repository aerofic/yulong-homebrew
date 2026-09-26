// Soft, distinct colors; assignment is deterministic for the displayed feature
// names and independent of item order, selection order, or token movement.
const PALETTE = [0x9bc9e3, 0xe8ad92, 0xb4d694, 0xd3ace2, 0xe2d184, 0x8fd5c6,
    0xe59fb8, 0xa6b2e8, 0xc5cba5, 0xd5b891, 0x9fd4e1, 0xc7a1bd];

export function featureColors(ranges) {
    const result = new Map(), used = new Set();
    for (const name of [...new Set(ranges.flatMap(range => range.names))].sort()) {
        let hash = 2166136261;
        for (const character of name) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
        let color;
        for (let i = 0; i < PALETTE.length; i++) {
            const candidate = PALETTE[(hash + i) % PALETTE.length];
            if (!used.has(candidate)) { color = candidate; break; }
        }
        // More features than palette entries: retain a soft RGB color rather
        // than silently reusing an already assigned color.
        let attempt = hash;
        while (color === undefined || used.has(color)) {
            color = ((140 + (attempt & 63)) << 16) | ((140 + ((attempt >>> 6) & 63)) << 8) | (140 + ((attempt >>> 12) & 63));
            attempt = (attempt + 1) >>> 0;
        }
        used.add(color); result.set(name, color);
    }
    return result;
}

export function groupRangeFeatures(ranges, gridType) {
    const colors = featureColors(ranges), groups = new Map();
    for (const range of ranges) {
        // Only 10-foot melee reach changes the planar square-grid boundary.
        const reach = gridType === 1 && range.kind === 'reach' && range.distance === 10 ? 10 : null;
        const key = `${range.distance}:${reach}`;
        const group = groups.get(key) ?? { distance: range.distance, reach, features: [] };
        for (const name of range.names) {
            if (!group.features.some(feature => feature.kind === range.kind && feature.name === name)) {
                group.features.push({ kind: range.kind, name, color: colors.get(name) });
            }
        }
        groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.distance - a.distance || (b.reach ?? 0) - (a.reach ?? 0));
}

// Consecutive colored pieces lie on the original boundary, with no lateral
// offset that could be mistaken for a change in range. Single-color edges
// stay whole. Phase continues across edges, including short ones.
export function coloredRangeSegments(segments, colors, length) {
    if (!colors.length || !(length > 0)) return [];
    const result = []; let phase = 0;
    for (const [a, b] of segments) {
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        const pieces = colors.length === 1 ? 1 : Math.max(1, Math.ceil(distance / length));
        const point = fraction => ({ x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction });
        for (let i = 0; i < pieces; i++) result.push({ a: point(i / pieces), b: point((i + 1) / pieces), color: colors[phase++ % colors.length] });
    }
    return result;
}

export function gridlessRangeSegments(bounds, radius) {
    const points = [];
    for (const [x, y, start] of [
        [bounds.x + bounds.width, bounds.y, -Math.PI / 2],
        [bounds.x + bounds.width, bounds.y + bounds.height, 0],
        [bounds.x, bounds.y + bounds.height, Math.PI / 2],
        [bounds.x, bounds.y, Math.PI]
    ]) {
        for (let i = 0; i <= 32; i++) {
            const angle = start + i / 32 * Math.PI / 2;
            points.push({ x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle) });
        }
    }
    return points.map((point, i) => [point, points[(i + 1) % points.length]]);
}
