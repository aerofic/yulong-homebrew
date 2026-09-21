// Display only: use prepared PF2e 8.5.1 Strike/Item reach and range getters.
// Descriptions are a conservative fallback, not a natural-language rules engine.
const number = value => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

export function explicitDescriptionRanges(description, localize = key => key) {
    const expanded = String(description ?? "").replace(/@Localize\[([^\]]+)\]/g, (_, key) => localize(key));
    const result = [];
    for (const match of expanded.matchAll(/@Template\[([^\]]+)\]/gi)) {
        const parts = match[1].split("|");
        if (!parts.includes("emanation") && !parts.includes("type:emanation")) continue;
        const distance = parts.find(part => /^distance:\d+(?:\.\d+)?$/.test(part));
        if (distance) result.push({ kind: "self", distance: Number(distance.slice(9)) });
    }
    const text = expanded.replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?\s*>/gi, "\n")
        .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ");
    // A declared Reach field, not "increase reach by ..." or a target's reach.
    for (const match of text.matchAll(/(?:^|[\n;；])\s*(?:reach|触及)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:feet|foot|ft\.?|尺)(?=$|[\s,，;；。.()（）])/gi)) {
        result.push({ kind: "reach", distance: Number(match[1]) });
    }
    // Explicit area labels only; arbitrary bursts and cones are not self-ranges.
    for (const match of text.matchAll(/(?:^|[\n;；])\s*(?:aura|emanation|灵光|靈光|发散|擴散|扩散)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:feet|foot|ft\.?|尺)(?=$|[\s,，;；。.()（）])/gi)) {
        result.push({ kind: "self", distance: Number(match[1]) });
    }
    return result;
}

export function collectTokenRanges(actor, { localize = key => key, baseLabel = "基础触及" } = {}) {
    if (!actor || !["npc", "character", "familiar"].includes(actor.type)) return [];
    const groups = new Map();
    const add = (kind, distance, name) => {
        distance = number(distance);
        if (distance === null || (kind === "reach" && distance <= 5)) return;
        const key = `${kind}:${distance}`;
        const group = groups.get(key) ?? { kind, distance, names: new Set() };
        group.names.add(String(name || baseLabel));
        groups.set(key, group);
    };
    add("reach", actor.system?.attributes?.reach?.base, baseLabel);
    const strikes = actor.system?.actions ?? [];
    for (const strike of strikes) {
        // Include prepared alternate usages (e.g. thrown melee weapons), not
        // unequipped items merely present in the character inventory.
        if (strike.ready === false) continue;
        for (const usage of [strike, ...(strike.altUsages ?? [])]) {
            const item = usage.item;
            if (!item || usage.ready === false || !["weapon", "melee"].includes(item.type)) continue;
            const name = usage.label || item.name;
            if (item.isMelee) add("reach", actor.getReach?.({ action: "attack", weapon: item }), name);
            if (item.isRanged) {
                const range = item.range;
                add("increment", range?.increment, name);
                // Fixed-range attacks have no increments. Never draw the
                // six-increment maximum for an ordinary ranged weapon.
                if (range?.increment == null) add("range", range?.max, name);
            }
        }
    }
    const items = Array.from(actor.items ?? []);
    for (const aura of actor.auras?.values?.() ?? []) {
        const owner = items.find(item => item.slug === aura.slug
            || item.rules?.some(rule => rule.key === "Aura" && rule.slug === aura.slug && !rule.ignored));
        add("self", aura.radius, owner?.name || aura.slug);
    }
    for (const item of items) {
        if (!["action", "feat"].includes(item.type)) continue;
        for (const trait of item.system?.traits?.value ?? []) {
            const match = /^reach-(\d+)$/.exec(trait);
            if (match) add("reach", Number(match[1]), item.name);
        }
        // If an Aura rule exists, its prepared result is authoritative, including
        // a failed predicate: don't resurrect an inactive aura from its prose.
        const hasAuraRule = (item.system?.rules ?? []).some(rule => rule.key === "Aura");
        for (const range of explicitDescriptionRanges(item.system?.description?.value, localize)) {
            if (range.kind === "self" && hasAuraRule) continue;
            add(range.kind, range.distance, item.name);
        }
    }
    return [...groups.values()].map(group => ({ ...group, names: [...group.names] }))
        .sort((a, b) => a.distance - b.distance || a.kind.localeCompare(b.kind));
}
