import {
    hasHolodeckKillMarker,
    holodeckStatsHaveValues,
    isHpDefeatTransition,
    selectHolodeckIdentityToken,
    setHolodeckKillMarker,
    summarizeHolodeckDamageRolls
} from "./statistics.js";

const MODULE_ID = "yulong-homebrew";
const PATREON_MODULE_ID = "patreon-v3";
const FUMBLE_SWITCH_MODULE_ID = "fumble-switch";
const PF2E_HUD_MODULE_ID = "pf2e-hud";
const LOW_HP_INCAPACITATION_ENABLED = "lowHpIncapacitationEnabled";
const LOW_HP_INCAPACITATION_PERCENT = "lowHpIncapacitationPercent";
const FUMBLE_SWITCH_WIDGET_VISIBLE = "fumbleSwitchWidgetVisible";
const PF2E_HUD_DISCRETE_HEALTH_COLORS = "pf2eHudDiscreteHealthColors";
const TROOP_HOUSERULES_ENABLED = "troopHouseRulesEnabled";
const TROOP_AREA_WEAKNESS_ADVISOR_ENABLED = "troopAreaWeaknessAdvisorEnabled";
const PATREON_INCAPACITATION_LABEL = "PF2E.TraitIncapacitation";
const TROOP_SINGLE_TARGET_DAMAGE_CAP_DENOMINATOR = 20;
const TROOP_AREA_FIREBALL_BASE_RADIUS_FEET = 20;
const TROOP_AREA_DOUBLE_RADIUS_FEET = 60;
const TROOP_AREA_QUADRUPLE_RADIUS_FEET = 400;
const TROOP_AREA_EMANATION_RADIUS_DIVISOR = 1.4;
const TROOP_AREA_LINE_WIDTH_FEET = 5;
const AWA_MODULE_ID = "achievements-with-automation";
const AWA_PF2E_PENDING_SOURCE_TIMEOUT_MS = 5000;
// The pf2e context types Achievements With Automation's own checkThrowPF already reacts to.
// Anything outside this set (spell attack rolls, perception checks) is ours to cover.
const AWA_NATIVE_PF2E_THROW_TYPES = new Set(["attack-roll", "saving-throw", "skill-check"]);

function isAchievementsWithAutomationActive() {
    return game.modules.get(AWA_MODULE_ID)?.active;
}

function hasNonGMOwner(actor) {
    return Object.keys(actor?.ownership || {}).some(ownerId => {
        const user = game.users.get(ownerId);
        return user && !user.isGM;
    });
}

function canReceiveAwaCredit(actor) {
    return Boolean(actor?.getFlag && hasNonGMOwner(actor));
}

function getAwaTargetTokenUuid(token) {
    const tokenDocument = token?.document || token || null;
    return tokenDocument?.uuid || null;
}

function isPersistentDamageItem(item) {
    const persistent = item?.system?.persistent;
    return Boolean(item && (
        item.slug === "persistent-damage"
        || persistent?.damage
        || persistent?.formula
        || (item.type === "condition" && persistent)
    ));
}

function getAwaSourceActorFromDamageItem(item) {
    if (isPersistentDamageItem(item)) {
        return window.CombatParser?.getPersistentDamageSourceActor?.(item) || null;
    }
    if (!item || ["condition", "effect"].includes(item.type)) return null;
    return getSourceActorFromItem(item);
}

function recordPendingAwaPF2eDamageSourceContext({ sourceActor, targetActor, targetToken = null, item = null, messageId = null, targetUuid = null, reason = "pf2e-damage" } = {}) {
    if (!isAchievementsWithAutomationActive()) return;
    if (!targetActor) return;

    window.yulongHomebrew ??= {};
    if (!sourceActor?.getFlag) {
        const pending = window.yulongHomebrew.pendingAwaPF2eDamageSource;
        if (isPersistentDamageItem(item) && pending && (
            pending.targetActorId === targetActor.id
            || pending.targetActorUuid === targetActor.uuid
            || pending.targetUuid === targetActor.uuid
        )) {
            delete window.yulongHomebrew.pendingAwaPF2eDamageSource;
        }
        return;
    }

    const tokenUuid = targetUuid || getAwaTargetTokenUuid(targetToken);
    const applicationKey = `${reason}:${messageId || item?.uuid || sourceActor.uuid || sourceActor.id}:${targetActor.uuid || targetActor.id}:${Date.now()}`;
    window.yulongHomebrew.pendingAwaPF2eDamageSource = {
        applicationKey,
        applicationLooseKey: applicationKey,
        messageId,
        sourceActor,
        sourceActorId: sourceActor.id,
        sourceActorUuid: sourceActor.uuid,
        targetActor,
        targetActorId: targetActor.id,
        targetActorUuid: targetActor.uuid,
        targetUuid: tokenUuid || targetActor.uuid,
        itemUuid: item?.uuid || null,
        timestamp: Date.now(),
        reason
    };
}

// Achievement progress lives in an actor flag. `api.grantAchievement` can hop to the GM over a
// socket, but a raw setFlag cannot, so skip the write (and say so) when this client lacks
// ownership rather than letting Foundry throw a permission error mid-hook.
async function setAwaProgressFlag(actor, flag, value) {
    if (!flag || !actor?.setFlag) return false;
    if (!actor.isOwner && !game.user?.isGM) {
        console.warn(`Yulong Homebrew | Cannot record achievement progress on "${actor.name}" without ownership.`);
        return false;
    }
    await actor.setFlag(AWA_MODULE_ID, flag, value);
    return true;
}

async function advanceAwaCounterAchievement(api, actor, achievement, amount = 1) {
    if (!actor?.getFlag || actor.getFlag(AWA_MODULE_ID, achievement.id) === undefined) return;
    const completed = actor.getFlag(AWA_MODULE_ID, achievement.id);
    if (completed) return;

    const target = Number(achievement.target || 0);
    if (!achievement.progressable) {
        // Matches AWA's checkThrow / checkItemUsedPF, which grant without touching the progress
        // flag for non-progressable counters. (Its damage and healing path does write the flag -
        // that difference is handled in applyOneTimeAchievementHooks.)
        await api.grantAchievement(achievement.id, actor);
        return;
    }

    const flag = achievement.flag;
    const current = Number(actor.getFlag(AWA_MODULE_ID, flag) || 0) + amount;
    if (current >= target) {
        await setAwaProgressFlag(actor, flag, target || current);
        await api.grantAchievement(achievement.id, actor);
    } else {
        await setAwaProgressFlag(actor, flag, current);
    }
}

function achievementHookMatchesStatistic(hookId, prefix, statistic) {
    if (!hookId?.startsWith(prefix)) return false;
    if (hookId.includes("_any")) return true;
    if (!statistic) return false;
    return hookId.includes(String(statistic).toLowerCase());
}

function getPF2eMessageStatistic(message) {
    const context = message?.flags?.pf2e?.context || {};
    return String(
        message?.flags?.pf2e?.modifierName
        || context.statistic
        || context.slug
        || context.domains?.[0]
        || ""
    ).toLowerCase();
}

function collectD20ResultsFromRoll(roll) {
    const results = [];
    const seen = new Set();
    const visit = value => {
        if (!value || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        if (Number(value.faces) === 20 && Array.isArray(value.results)) {
            for (const result of value.results) {
                if (result.active === false || result.discarded) continue;
                const number = Number(result.result);
                if (Number.isFinite(number)) results.push(number);
            }
        }
        for (const child of Object.values(value)) visit(child);
    };
    visit(roll);
    return results;
}

function getPF2eMessageD20Results(message) {
    return (message?.rolls || []).flatMap(roll => collectD20ResultsFromRoll(roll));
}

function getActorFromMessageSpeaker(message) {
    return message?.actor || game.actors.get(message?.speaker?.actor) || null;
}

async function resolvePF2eMessageItem(message) {
    if (message?.item) return message.item;
    const actor = getActorFromMessageSpeaker(message);
    const originUuid = message?.flags?.pf2e?.origin?.uuid;
    if (!originUuid) return null;

    const segments = originUuid.split(".");
    const itemIndex = segments.indexOf("Item");
    if (actor && itemIndex !== -1 && itemIndex + 1 < segments.length) {
        const item = actor.items.get(segments[itemIndex + 1]);
        if (item) return item;
    }

    try {
        return await fromUuid(originUuid);
    } catch {
        return null;
    }
}

function isPF2eHealingConsumableMessage(message, item) {
    if (item?.type !== "consumable") return false;
    const traits = item.system?.traits?.value || [];
    const text = [
        item.slug,
        item.name,
        item.system?.category,
        item.system?.consumableType,
        ...(Array.isArray(traits) ? traits : []),
        message?.flavor,
        message?.content
    ].join(" ").toLowerCase();
    return /\b(healing|heal|healed|restored|elixir-of-life|potion-of-healing)\b/.test(text);
}

function registerHomebrewSettings() {
    game.settings.register(MODULE_ID, LOW_HP_INCAPACITATION_ENABLED, {
        name: "Patreon-v3 low HP incapacitation",
        hint: "When patreon-v3 uses its Bloodied incapacitation mode, treat targets at or below the configured HP percent as bloodied.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, LOW_HP_INCAPACITATION_PERCENT, {
        name: "Patreon-v3 low HP incapacitation percent",
        hint: "Targets at or below this current HP percentage ignore incapacitation in patreon-v3 Bloodied mode.",
        scope: "world",
        config: true,
        type: Number,
        default: 25,
        range: { min: 1, max: 100, step: 1 }
    });

    game.settings.register(MODULE_ID, FUMBLE_SWITCH_WIDGET_VISIBLE, {
        name: "Show Fumble Switch floating widget",
        hint: "Controls the Fumble Switch floating widget on this client. The widget can also be hidden with its close button.",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        onChange: value => applyFumbleSwitchWidgetVisibility(value)
    });

    game.settings.register(MODULE_ID, PF2E_HUD_DISCRETE_HEALTH_COLORS, {
        name: "PF2e HUD discrete health colors",
        hint: "Quantize PF2e HUD health colors to the configured health-status bands so players cannot infer exact HP from color gradients.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        onChange: value => value ? applyPF2eHudDiscreteHealthColors() : restorePF2eHudDiscreteHealthColors()
    });

    game.settings.register(MODULE_ID, TROOP_HOUSERULES_ENABLED, {
        name: "PF2e troop single-target damage cap",
        hint: "Caps single-target damage to troops at 1/20 of maximum HP after PF2e has applied immunities, weaknesses, resistances, shields, and hardness.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, TROOP_AREA_WEAKNESS_ADVISOR_ENABLED, {
        name: "PF2e troop area weakness advisor",
        hint: "Whispers GMs a review card when a troop takes qualifying area damage, suggesting an editable area-weakness multiplier and a button to apply only the extra weakness damage.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });
}

function areTroopHouseRulesEnabled() {
    try {
        return Boolean(game.settings.get(MODULE_ID, TROOP_HOUSERULES_ENABLED));
    } catch {
        return true;
    }
}

function isTroopAreaWeaknessAdvisorEnabled() {
    try {
        return Boolean(game.settings.get(MODULE_ID, TROOP_AREA_WEAKNESS_ADVISOR_ENABLED));
    } catch {
        return true;
    }
}

function toRollOptionSet(options) {
    return options instanceof Set ? options : new Set(options || []);
}

function isTroopActor(actor) {
    const traits = actor?.system?.traits?.value ?? actor?.traits?.value ?? [];
    return Array.isArray(traits) && traits.includes("troop");
}

function installPF2eCheckRollWrapper() {
    const check = game.pf2e?.Check;
    if (!check || typeof check.roll !== "function") return;
    window.yulongHomebrew ??= {};
    if (window.yulongHomebrew.__yulongPF2eCheckRollWrapperInstalled) return true;
    if (!game.modules.get("lib-wrapper")?.active || typeof libWrapper?.register !== "function") {
        console.warn("Yulong Homebrew | libWrapper is required for PF2e check roll compatibility.");
        return false;
    }

    const wrappedRoll = function(wrapped, ...args) {
        const context = args[1];
        const applyLowHpIncapacitation = shouldApplyLowHpIncapacitation(context)
            && isLowHpIncapacitationTarget(context.actor);

        if (applyLowHpIncapacitation) {
            context.__yulongPatreonIncapacitationLabel = PATREON_INCAPACITATION_LABEL;
            clearPatreonIncapacitationResult(context);
        }

        if (!applyLowHpIncapacitation) return wrapped(...args);

        const result = temporarilySuppressPatreonIncapacitationMode(() => wrapped(...args));
        if (result && typeof result.finally === "function") {
            return result.finally(() => clearPatreonIncapacitationResult(context));
        }
        clearPatreonIncapacitationResult(context);
        return result;
    };

    wrappedRoll.__yulongPF2eCheckRollWrapperInstalled = true;
    wrappedRoll.__yulongLowHpIncapacitationInstalled = true;
    libWrapper.register(MODULE_ID, "game.pf2e.Check.roll", wrappedRoll, "WRAPPER");
    window.yulongHomebrew.__yulongPF2eCheckRollWrapperInstalled = true;

    console.log("Yulong Homebrew | PF2e check roll compatibility ready.");
    return true;
}

function getTroopSingleTargetDamageCap(actor) {
    const maxHP = Number(actor?.hitPoints?.max ?? actor?.system?.attributes?.hp?.max);
    if (!Number.isFinite(maxHP) || maxHP <= 0) return null;
    return Math.max(Math.ceil(maxHP / TROOP_SINGLE_TARGET_DAMAGE_CAP_DENOMINATOR), 1);
}

function isSplashOnlyDamage(damage) {
    if (damage?.options?.splashOnly) return true;
    const instances = Array.isArray(damage?.instances) ? damage.instances : [];
    return instances.length > 0 && instances.every(instance => {
        const splash = Number(instance.componentTotal?.("splash") ?? 0);
        const total = Number(instance.total ?? 0);
        return splash > 0 && total === splash;
    });
}

function isAreaDamageApplication({ rollOptions, item }) {
    const options = toRollOptionSet(rollOptions);
    return options.has("area-damage")
        || options.has("area-effect")
        || Boolean(item?.system?.area);
}

function getTroopAreaDamageWeakness(actor) {
    const weaknesses = [
        ...(actor?.attributes?.weaknesses || []),
        ...(actor?.system?.attributes?.weaknesses || [])
    ];
    return weaknesses
        .filter(weakness => weakness?.type === "area-damage" && Number(weakness.value) > 0)
        .sort((a, b) => Number(b.value) - Number(a.value))[0] || null;
}

function getRawDamageTotal(damage) {
    const total = typeof damage === "number" ? damage : Number(damage?.total);
    return Number.isFinite(total) ? total : null;
}

function getAreaDataFromRollOptions(rollOptions) {
    let type = null;
    let value = null;

    for (const option of toRollOptionSet(rollOptions)) {
        const text = String(option);
        const typeMatch = text.match(/(?:^|:)area:type:([^:]+)/);
        const sizeMatch = text.match(/(?:^|:)area:size:([0-9.]+)/);
        if (typeMatch) type = typeMatch[1];
        if (sizeMatch) value = Number(sizeMatch[1]);
    }

    return { type, value };
}

function normalizeTroopAreaType(type) {
    const normalized = String(type || "").trim().toLowerCase();
    if (normalized === "cylinder") return "burst";
    if (["burst", "emanation", "cone", "line", "cube", "square"].includes(normalized)) return normalized;
    return null;
}

function getTroopAreaData({ rollOptions, item }) {
    const optionArea = getAreaDataFromRollOptions(rollOptions);
    const sourceArea = item?.system?.area || {};
    const value = Number(sourceArea.value ?? optionArea.value);
    if (!Number.isFinite(value) || value <= 0) return null;

    const rawType = sourceArea.type || optionArea.type || "burst";
    const type = normalizeTroopAreaType(rawType);
    if (!type) return null;

    return { type, rawType: String(rawType), value };
}

function getEquivalentBurstRadius(area) {
    const value = Number(area?.value);
    if (!Number.isFinite(value) || value <= 0) return null;

    switch (area.type) {
        case "burst":
            return value;
        case "emanation":
            return value / TROOP_AREA_EMANATION_RADIUS_DIVISOR;
        case "cone":
            return value / 2;
        case "line":
            return Math.sqrt(value * TROOP_AREA_LINE_WIDTH_FEET / Math.PI);
        case "cube":
        case "square":
            return Math.sqrt(value * value / Math.PI);
        default:
            return null;
    }
}

function getTroopAreaWeaknessMultiplier(equivalentBurstRadius) {
    if (!Number.isFinite(equivalentBurstRadius) || equivalentBurstRadius <= TROOP_AREA_FIREBALL_BASE_RADIUS_FEET) return 1;
    if (equivalentBurstRadius <= TROOP_AREA_DOUBLE_RADIUS_FEET) return 2;
    if (equivalentBurstRadius < TROOP_AREA_QUADRUPLE_RADIUS_FEET) return 3;
    return 4;
}

function formatTroopAreaNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "0";
    return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, "");
}

function getTroopAreaLabel(area) {
    if (!area) return "Unknown area";
    return `${formatTroopAreaNumber(area.value)}-foot ${area.rawType || area.type}`;
}

function getSourceActorFromItem(item) {
    const actor = item?.actor || item?.parent;
    return actor?.documentName === "Actor" ? actor : null;
}

function getTroopAreaWeaknessAdvisorContext(actor, params) {
    if (!areTroopHouseRulesEnabled()) return null;
    if (!isTroopAreaWeaknessAdvisorEnabled()) return null;
    if (!game.user?.isGM) return null;
    if (!isTroopActor(actor)) return null;
    if (params.final || params.skipIWR) return null;
    if (!isAreaDamageApplication(params)) return null;
    if (isSplashOnlyDamage(params.damage)) return null;

    const area = getTroopAreaData(params);
    const equivalentBurstRadius = getEquivalentBurstRadius(area);
    if (!Number.isFinite(equivalentBurstRadius)) return null;

    const weakness = getTroopAreaDamageWeakness(actor);
    if (!weakness) return null;

    const weaknessValue = Number(weakness.value);
    if (!Number.isFinite(weaknessValue) || weaknessValue <= 0) return null;

    const rawDamage = getRawDamageTotal(params.damage);
    if (!Number.isFinite(rawDamage) || rawDamage <= weaknessValue) return null;

    const item = params.item || null;
    const sourceActor = getSourceActorFromItem(item);
    const tokenDocument = params.token?.document || params.token || null;
    const suggestedMultiplier = getTroopAreaWeaknessMultiplier(equivalentBurstRadius);

    return {
        cardId: foundry.utils.randomID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        actorId: actor.id,
        actorUuid: actor.uuid,
        actorName: actor.name,
        tokenUuid: tokenDocument?.uuid || null,
        tokenName: tokenDocument?.name || params.token?.name || actor.name,
        itemUuid: item?.uuid || null,
        itemName: item?.name || "Area effect",
        sourceActorId: sourceActor?.id || null,
        sourceActorUuid: sourceActor?.uuid || null,
        sourceActorName: sourceActor?.name || null,
        area,
        areaLabel: getTroopAreaLabel(area),
        equivalentBurstRadius,
        rawDamage,
        suggestedMultiplier,
        weakness: {
            type: weakness.type,
            value: weaknessValue,
            label: weakness.applicationLabel || weakness.label || "Area damage weakness"
        },
        createdAt: Date.now()
    };
}

function shouldCapTroopSingleTargetDamage(actor, { damage, final, rollOptions, item }) {
    if (!areTroopHouseRulesEnabled()) return false;
    if (!isTroopActor(actor)) return false;
    if (final) return false;
    const total = typeof damage === "number" ? damage : Number(damage?.total);
    if (!Number.isFinite(total) || total <= 0) return false;
    if (isAreaDamageApplication({ rollOptions, item })) return false;
    if (isSplashOnlyDamage(damage)) return false;
    return getTroopSingleTargetDamageCap(actor) !== null;
}

// PF2e calls `this.calculateHealthDelta` from inside applyDamage, so the only interception point
// is the actor instance itself. Two things matter here: restoring must remove the own property
// again (assigning the prototype method back leaves a permanent shadow), and overlapping
// applications on the same actor must not restore out of order, hence the identity check.
function withPatchedCalculateHealthDelta(actor, patch, callback) {
    const original = actor?.calculateHealthDelta;
    if (typeof original !== "function") return callback();

    const hadOwnProperty = Object.prototype.hasOwnProperty.call(actor, "calculateHealthDelta");
    const previousOwnValue = hadOwnProperty ? original : undefined;
    const patched = function(args) {
        return patch.call(this, original, args);
    };
    actor.calculateHealthDelta = patched;

    const restore = () => {
        if (actor.calculateHealthDelta !== patched) return;
        if (hadOwnProperty) actor.calculateHealthDelta = previousOwnValue;
        else delete actor.calculateHealthDelta;
    };

    try {
        const result = callback();
        if (result && typeof result.finally === "function") return result.finally(restore);
        restore();
        return result;
    } catch (error) {
        restore();
        throw error;
    }
}

function withTroopDamageCap(actor, cap, breakdown, callback) {
    let capApplied = false;
    return withPatchedCalculateHealthDelta(actor, function(original, args) {
        const delta = Number(args?.delta);
        if (Number.isFinite(delta) && delta > cap) {
            if (!capApplied) {
                capApplied = true;
                breakdown?.push?.(`Single-target troop damage cap: ${cap}`);
            }
            return original.call(this, { ...args, delta: cap });
        }
        return original.call(this, args);
    }, callback);
}

function escapeYulongHTML(value) {
    const element = document.createElement("div");
    element.innerText = String(value ?? "");
    return element.innerHTML;
}

function clampTroopAreaMultiplier(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 1;
    return Math.min(Math.max(Math.trunc(number), 1), 4);
}

function getTroopAreaExtraWeaknessDamage(weaknessValue, multiplier) {
    return Math.max(0, Number(weaknessValue) * (clampTroopAreaMultiplier(multiplier) - 1));
}

function buildTroopAreaWeaknessAdvisorContent(data) {
    const selectedMultiplier = clampTroopAreaMultiplier(data.selectedMultiplier ?? data.suggestedMultiplier);
    const weaknessValue = Number(data.weakness?.value || 0);
    const extraDamage = getTroopAreaExtraWeaknessDamage(weaknessValue, selectedMultiplier);
    const disabled = data.executed || data.ignored ? "disabled" : "";
    const multiplierOptions = [1, 2, 3, 4]
        .map(multiplier => `<option value="${multiplier}" ${multiplier === selectedMultiplier ? "selected" : ""}>${multiplier}x</option>`)
        .join("");
    const status = data.executed
        ? `<p><em>Executed by ${escapeYulongHTML(data.executedByName || "a GM")} for ${formatTroopAreaNumber(data.extraDamage || 0)} extra damage.</em></p>`
        : data.ignored
            ? `<p><em>Ignored by ${escapeYulongHTML(data.ignoredByName || "a GM")}.</em></p>`
            : "";

    return `
<div class="yulong-troop-area-weakness-card" data-yulong-card-id="${escapeYulongHTML(data.cardId)}" data-yulong-weakness-value="${formatTroopAreaNumber(weaknessValue)}">
  <h3>Troop Area Weakness Advisor</h3>
  <p><strong>Target:</strong> ${escapeYulongHTML(data.actorName)}<br>
  <strong>Source:</strong> ${escapeYulongHTML(data.itemName)}<br>
  <strong>Area:</strong> ${escapeYulongHTML(data.areaLabel)} (equivalent burst ${formatTroopAreaNumber(data.equivalentBurstRadius)} ft)<br>
  <strong>Rolled damage:</strong> ${formatTroopAreaNumber(data.rawDamage)}</p>
  <p><strong>${escapeYulongHTML(data.weakness?.label || "Area damage weakness")}:</strong> ${formatTroopAreaNumber(weaknessValue)}</p>
  <label>Weakness multiplier
    <select data-yulong-troop-area-multiplier ${disabled}>
      ${multiplierOptions}
    </select>
  </label>
  <p>Selected extra weakness damage: <strong data-yulong-troop-area-extra-preview>${formatTroopAreaNumber(extraDamage)}</strong></p>
  <p>
    <button type="button" data-yulong-troop-area-action="apply" ${disabled}><i class="fas fa-bolt"></i> Apply Extra Weakness</button>
    <button type="button" data-yulong-troop-area-action="ignore" ${disabled}>Ignore</button>
  </p>
  ${status}
</div>`.trim();
}

async function createTroopAreaWeaknessAdvisorMessage(data) {
    if (!game.user?.isGM) return null;

    return ChatMessage.create({
        speaker: { alias: "Yulong Homebrew" },
        whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id),
        content: buildTroopAreaWeaknessAdvisorContent(data),
        flags: {
            [MODULE_ID]: {
                troopAreaWeakness: data
            }
        },
        style: CONST.CHAT_MESSAGE_STYLES.OTHER
    });
}

function withTroopAreaWeaknessAdvisor(actor, context, callback) {
    let capturedDamage = null;
    const maybeCreateAdvisor = () => {
        if (!capturedDamage) return;
        const data = {
            ...context,
            damage: capturedDamage.delta,
            totalApplied: Number.isFinite(capturedDamage.totalApplied) ? capturedDamage.totalApplied : capturedDamage.delta
        };
        void createTroopAreaWeaknessAdvisorMessage(data)
            .catch(error => console.warn("Yulong Homebrew | Failed to create troop area weakness advisor card.", error));
    };

    return withPatchedCalculateHealthDelta(actor, function(original, args) {
        const delta = Number(args?.delta);
        const result = original.call(this, args);
        if (Number.isFinite(delta) && delta > 0) {
            capturedDamage = {
                delta,
                totalApplied: Number(result?.totalApplied)
            };
        }
        return result;
    }, () => {
        const result = callback();
        if (result && typeof result.then === "function") {
            return result.then(value => {
                maybeCreateAdvisor();
                return value;
            });
        }
        maybeCreateAdvisor();
        return result;
    });
}

function fromUuidSyncSafe(uuid) {
    if (!uuid) return null;
    try {
        return fromUuidSync(uuid);
    } catch {
        return null;
    }
}

function getTroopAreaWeaknessTarget(data) {
    const tokenDocument = fromUuidSyncSafe(data.tokenUuid);
    const actor = tokenDocument?.actor || fromUuidSyncSafe(data.actorUuid) || game.actors.get(data.actorId);
    const activeToken = actor?.getActiveTokens?.(true, true)?.[0] || null;
    const token = tokenDocument?.object || tokenDocument || activeToken?.document || activeToken || null;
    return { actor, token };
}

function getTroopAreaWeaknessSourceItem(data) {
    return fromUuidSyncSafe(data.itemUuid);
}

function getTroopAreaWeaknessSourceActor(data, item = null) {
    return fromUuidSyncSafe(data.sourceActorUuid)
        || game.actors.get(data.sourceActorId)
        || getSourceActorFromItem(item);
}

function recordPendingAwaTroopAreaWeaknessSource(data, targetActor, sourceActor) {
    if (!game.modules.get("achievements-with-automation")?.active) return;
    if (!sourceActor?.getFlag || !targetActor) return;

    window.yulongHomebrew ??= {};
    const applicationKey = `troop-area-weakness-${data.cardId}`;
    window.yulongHomebrew.pendingAwaToolbeltSource = {
        applicationKey,
        applicationLooseKey: applicationKey,
        messageId: data.cardId,
        rollIndex: 0,
        sourceActor,
        sourceActorId: sourceActor.id,
        targetActor,
        targetActorId: targetActor.id,
        targetUuid: targetActor.uuid,
        timestamp: Date.now(),
        yulongTroopAreaWeakness: true
    };
}

async function updateTroopAreaWeaknessAdvisorMessage(message, data) {
    await message.setFlag(MODULE_ID, "troopAreaWeakness", data);
    await message.update({ content: buildTroopAreaWeaknessAdvisorContent(data) });
}

async function executeTroopAreaWeaknessAdvisor(message, card, multiplier) {
    const { actor, token } = getTroopAreaWeaknessTarget(card);
    if (!actor || !token) {
        ui.notifications.warn("Yulong Homebrew | Could not resolve the troop target for this area weakness card.");
        return;
    }
    if (!isTroopActor(actor)) {
        ui.notifications.warn("Yulong Homebrew | The target is no longer a troop.");
        return;
    }

    const currentWeakness = getTroopAreaDamageWeakness(actor);
    const weaknessValue = Number(currentWeakness?.value ?? card.weakness?.value ?? 0);
    const selectedMultiplier = clampTroopAreaMultiplier(multiplier);
    const extraDamage = getTroopAreaExtraWeaknessDamage(weaknessValue, selectedMultiplier);
    if (extraDamage <= 0) {
        ui.notifications.info("Yulong Homebrew | The selected multiplier adds no extra area weakness damage.");
        return;
    }

    const sourceItem = getTroopAreaWeaknessSourceItem(card);
    const sourceActor = getTroopAreaWeaknessSourceActor(card, sourceItem);
    recordPendingAwaTroopAreaWeaknessSource(card, actor, sourceActor);

    await actor.applyDamage({
        damage: extraDamage,
        token,
        item: sourceItem,
        final: true,
        breakdown: [`Yulong troop area weakness: ${selectedMultiplier}x area weakness (${formatTroopAreaNumber(extraDamage)} extra damage)`]
    });

    const updated = {
        ...card,
        selectedMultiplier,
        extraDamage,
        executed: true,
        executedAt: Date.now(),
        executedBy: game.user.id,
        executedByName: game.user.name,
        weakness: {
            ...(card.weakness || {}),
            value: weaknessValue,
            label: currentWeakness?.applicationLabel || currentWeakness?.label || card.weakness?.label || "Area damage weakness"
        }
    };
    await updateTroopAreaWeaknessAdvisorMessage(message, updated);
}

async function ignoreTroopAreaWeaknessAdvisor(message, card) {
    const updated = {
        ...card,
        ignored: true,
        ignoredAt: Date.now(),
        ignoredBy: game.user.id,
        ignoredByName: game.user.name
    };
    await updateTroopAreaWeaknessAdvisorMessage(message, updated);
}

async function handleTroopAreaWeaknessAdvisorClick(event) {
    const button = event.target?.closest?.("button[data-yulong-troop-area-action]");
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();

    if (!game.user?.isGM) {
        ui.notifications.warn("Yulong Homebrew | Only GMs can apply troop area weakness advisor cards.");
        return;
    }

    const messageElement = button.closest("[data-message-id]");
    const message = messageElement ? game.messages.get(messageElement.dataset.messageId) : null;
    const card = message?.getFlag?.(MODULE_ID, "troopAreaWeakness");
    if (!message || !card) return;
    if (card.executed || card.ignored) return;

    const action = button.dataset.yulongTroopAreaAction;
    if (action === "ignore") {
        await ignoreTroopAreaWeaknessAdvisor(message, card);
        return;
    }

    if (action !== "apply") return;
    const cardElement = button.closest(".yulong-troop-area-weakness-card");
    const multiplier = cardElement?.querySelector("[data-yulong-troop-area-multiplier]")?.value ?? card.suggestedMultiplier;
    await executeTroopAreaWeaknessAdvisor(message, card, multiplier);
}

function handleTroopAreaWeaknessAdvisorChange(event) {
    const select = event.target?.closest?.("[data-yulong-troop-area-multiplier]");
    if (!select) return;

    const cardElement = select.closest(".yulong-troop-area-weakness-card");
    const weaknessValue = Number(cardElement?.dataset.yulongWeaknessValue);
    const preview = cardElement?.querySelector("[data-yulong-troop-area-extra-preview]");
    if (!preview || !Number.isFinite(weaknessValue)) return;

    preview.innerText = formatTroopAreaNumber(getTroopAreaExtraWeaknessDamage(weaknessValue, select.value));
}

function installTroopAreaWeaknessAdvisorChatHandler() {
    window.yulongHomebrew ??= {};
    if (window.yulongHomebrew.__yulongTroopAreaWeaknessAdvisorChatHandlerInstalled) return;
    window.yulongHomebrew.__yulongTroopAreaWeaknessAdvisorChatHandlerInstalled = true;

    document.body.addEventListener("click", event => {
        void handleTroopAreaWeaknessAdvisorClick(event)
            .catch(error => console.warn("Yulong Homebrew | Failed to handle troop area weakness advisor card.", error));
    });
    document.body.addEventListener("change", handleTroopAreaWeaknessAdvisorChange);
}

function installTroopDamageHouseRules() {
    const actorClass = CONFIG?.Actor?.documentClass;
    if (!actorClass?.prototype || typeof actorClass.prototype.applyDamage !== "function") return;
    window.yulongHomebrew ??= {};
    if (window.yulongHomebrew.__yulongTroopDamageHouseRulesInstalled) return;
    if (!game.modules.get("lib-wrapper")?.active || typeof libWrapper?.register !== "function") {
        console.warn("Yulong Homebrew | libWrapper is required for PF2e troop damage house rules.");
        return;
    }

    const wrappedApplyDamage = function(wrapped, params = {}) {
        const breakdown = Array.isArray(params.breakdown) ? params.breakdown : [];
        recordPendingAwaPF2eDamageSourceContext({
            sourceActor: getAwaSourceActorFromDamageItem(params.item),
            targetActor: this,
            targetToken: params.token,
            item: params.item,
            reason: "pf2e-apply-damage"
        });
        const cap = shouldCapTroopSingleTargetDamage(this, params) ? getTroopSingleTargetDamageCap(this) : null;
        const areaWeaknessContext = cap ? null : getTroopAreaWeaknessAdvisorContext(this, params);
        const applyDamage = () => wrapped.call(this, { ...params, breakdown });

        if (cap) return withTroopDamageCap(this, cap, breakdown, applyDamage);
        if (areaWeaknessContext) return withTroopAreaWeaknessAdvisor(this, areaWeaknessContext, applyDamage);
        return applyDamage();
    };

    libWrapper.register(MODULE_ID, "CONFIG.Actor.documentClass.prototype.applyDamage", wrappedApplyDamage, "WRAPPER");
    installTroopAreaWeaknessAdvisorChatHandler();
    window.yulongHomebrew.__yulongTroopDamageHouseRulesInstalled = true;

    console.log("Yulong Homebrew | PF2e troop damage house rules ready.");
}

function getLowHpIncapacitationPercent() {
    const raw = Number(game.settings.get(MODULE_ID, LOW_HP_INCAPACITATION_PERCENT));
    if (!Number.isFinite(raw)) return 25;
    return Math.min(Math.max(Math.trunc(raw), 1), 100);
}

function isIncapacitationCheck(context) {
    const options = context?.options instanceof Set ? context.options : new Set(context?.options || []);
    return options.has("incapacitation")
        || options.has("item:trait:incapacitation")
        || options.has("origin:action:trait:incapacitation");
}

function isLowHpIncapacitationTarget(actor) {
    const hp = actor?.system?.attributes?.hp || actor?.hitPoints;
    const value = Number(hp?.value);
    const max = Number(hp?.max);
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return false;

    return value / max * 100 <= getLowHpIncapacitationPercent();
}

function shouldApplyLowHpIncapacitation(context) {
    if (!game.settings.get(MODULE_ID, LOW_HP_INCAPACITATION_ENABLED)) return false;
    if (!game.modules.get(PATREON_MODULE_ID)?.active) return false;
    if (game.settings.get(PATREON_MODULE_ID, "incapacitation") !== "bloodied") return false;
    return isIncapacitationCheck(context);
}

function hasIncapacitationAdjustmentLabel(adjustment) {
    return Object.values(adjustment?.adjustments || {}).some(value => value?.label === PATREON_INCAPACITATION_LABEL);
}

function removeIncapacitationAdjustment(context) {
    if (!Array.isArray(context?.dosAdjustments)) return false;
    const originalLength = context.dosAdjustments.length;
    context.dosAdjustments = context.dosAdjustments.filter(adjustment => !hasIncapacitationAdjustmentLabel(adjustment));
    return context.dosAdjustments.length !== originalLength;
}

function clearPatreonIncapacitationResult(context) {
    const removedAdjustment = removeIncapacitationAdjustment(context);
    if (removedAdjustment && context.rollTwice === "keep-higher") delete context.rollTwice;
}

// patreon-v3 reads its incapacitation mode straight from settings during a check roll, so the
// only way to opt a single roll out is to intercept the read. Swapping game.settings.get in and
// out around each roll is not re-entrant: an overlapping roll captures the already-patched
// function as its "original" and restoring out of order strands the patch forever. Instead the
// interceptor is installed once and stays inert until a suppression scope raises the depth.
let patreonIncapacitationSuppressionDepth = 0;
let patreonIncapacitationSettingsGet = null;

function installPatreonIncapacitationSettingsInterceptor() {
    if (patreonIncapacitationSettingsGet && game.settings.get === patreonIncapacitationSettingsGet) return;

    const previousGet = game.settings.get.bind(game.settings);
    patreonIncapacitationSettingsGet = function(namespace, key, ...args) {
        if (patreonIncapacitationSuppressionDepth > 0
            && namespace === PATREON_MODULE_ID
            && key === "incapacitation") return "no";
        return previousGet(namespace, key, ...args);
    };
    game.settings.get = patreonIncapacitationSettingsGet;
}

function temporarilySuppressPatreonIncapacitationMode(callback) {
    installPatreonIncapacitationSettingsInterceptor();
    patreonIncapacitationSuppressionDepth += 1;

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        patreonIncapacitationSuppressionDepth = Math.max(0, patreonIncapacitationSuppressionDepth - 1);
    };

    try {
        const result = callback();
        if (result && typeof result.finally === "function") return result.finally(release);
        release();
        return result;
    } catch (error) {
        release();
        throw error;
    }
}

function installPatreonLowHpIncapacitation() {
    window.yulongHomebrew ??= {};
    if (window.yulongHomebrew.__yulongLowHpIncapacitationInstalled) return;
    if (!installPF2eCheckRollWrapper()) return;

    window.yulongHomebrew.__yulongLowHpIncapacitationInstalled = true;

    console.log("Yulong Homebrew | Patreon-v3 low HP incapacitation compatibility ready.");
}

function getFumbleSwitchWidget() {
    return document.querySelector(".fumble-switch");
}

function getFumbleSwitchWidgetHeader(widget) {
    return widget?.querySelector(".fumble-switch__header") || null;
}

function addFumbleSwitchCloseButton(widget) {
    const header = getFumbleSwitchWidgetHeader(widget);
    if (!header || header.querySelector(".yulong-fumble-switch-close")) return;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "fumble-switch__gear yulong-fumble-switch-close";
    closeButton.title = "Hide Fumble Switch";
    closeButton.innerHTML = '<i class="fas fa-times"></i>';
    closeButton.addEventListener("mousedown", event => event.stopPropagation());
    closeButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        void setFumbleSwitchWidgetVisible(false);
    });

    header.appendChild(closeButton);
}

function applyFumbleSwitchWidgetVisibility(visible = game.settings.get(MODULE_ID, FUMBLE_SWITCH_WIDGET_VISIBLE)) {
    const widget = getFumbleSwitchWidget();
    if (!widget) return false;

    addFumbleSwitchCloseButton(widget);
    widget.style.display = visible ? "" : "none";
    widget.dataset.yulongHomebrewHidden = visible ? "false" : "true";
    return true;
}

async function setFumbleSwitchWidgetVisible(visible) {
    await game.settings.set(MODULE_ID, FUMBLE_SWITCH_WIDGET_VISIBLE, Boolean(visible));
    return applyFumbleSwitchWidgetVisibility(Boolean(visible));
}

async function toggleFumbleSwitchWidgetVisible() {
    const current = Boolean(game.settings.get(MODULE_ID, FUMBLE_SWITCH_WIDGET_VISIBLE));
    return setFumbleSwitchWidgetVisible(!current);
}

function exposeFumbleSwitchWidgetApi() {
    window.yulongHomebrew ??= {};
    window.yulongHomebrew.showFumbleSwitchWidget = () => setFumbleSwitchWidgetVisible(true);
    window.yulongHomebrew.hideFumbleSwitchWidget = () => setFumbleSwitchWidgetVisible(false);
    window.yulongHomebrew.toggleFumbleSwitchWidget = () => toggleFumbleSwitchWidgetVisible();
    window.yulongHomebrew.applyFumbleSwitchWidgetVisibility = applyFumbleSwitchWidgetVisibility;
}

function installFumbleSwitchWidgetCompat() {
    exposeFumbleSwitchWidgetApi();

    if (!game.modules.get(FUMBLE_SWITCH_MODULE_ID)?.active) return;
    if (!game.user?.isGM) return;
    window.yulongHomebrew ??= {};
    if (window.yulongHomebrew.__yulongFumbleSwitchWidgetCompatInstalled) return;
    window.yulongHomebrew.__yulongFumbleSwitchWidgetCompatInstalled = true;

    applyFumbleSwitchWidgetVisibility();
    setTimeout(() => applyFumbleSwitchWidgetVisibility(), 0);

    const observer = new MutationObserver(() => applyFumbleSwitchWidgetVisibility());
    observer.observe(document.body, { childList: true });
    window.yulongHomebrew.fumbleSwitchWidgetObserver = observer;

    console.log("Yulong Homebrew | Fumble Switch floating widget compatibility ready.");
}

function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(Math.max(number, min), max);
}

function getPF2eHudDefaultHealthLabels() {
    const path = `${PF2E_HUD_MODULE_ID}.health-status.default`;
    const fallback = "Dead, At Death's Door, Not Feeling Good, Seen Better Days, Barely Hurt, Perfectly Fine";
    const localized = game.i18n?.has?.(path, true) ? game.i18n.localize(path) : fallback;
    return localized.split(",").map(label => label.trim());
}

function getPF2eHudDefaultHealthEntry(index) {
    const labels = getPF2eHudDefaultHealthLabels();
    return labels.at(index)?.trim() ?? "";
}

function getPF2eHudDefaultHealthStatusEntries() {
    const labels = getPF2eHudDefaultHealthLabels();
    const nbEntries = labels.length - 1;
    if (nbEntries < 1) return [];

    const segment = 100 / (nbEntries - 1);
    const entries = [];
    for (let i = 1; i < nbEntries; i++) {
        entries.push({
            label: labels[i].trim(),
            marker: Math.max(Math.floor((i - 1) * segment), 1)
        });
    }
    return entries;
}

function normalizePF2eHudHealthStatus(source = {}) {
    const status = {
        dead: typeof source.dead === "string" ? source.dead : getPF2eHudDefaultHealthEntry(0),
        enabled: typeof source.enabled === "boolean" ? source.enabled : true,
        full: typeof source.full === "string" ? source.full : getPF2eHudDefaultHealthEntry(-1),
        entries: Array.isArray(source.entries) ? source.entries : getPF2eHudDefaultHealthStatusEntries()
    };

    const entries = status.entries
        .filter(entry => typeof entry?.label === "string" && Number.isFinite(Number(entry.marker)))
        .map(entry => ({
            label: entry.label,
            marker: Math.trunc(clampNumber(entry.marker, 1, 99))
        }))
        .sort((a, b) => a.marker - b.marker);

    for (let i = entries.length - 1; i >= 0; i--) {
        const previous = entries[i - 1]?.marker ?? 0;
        const next = entries[i + 1]?.marker ?? 100;

        if (entries[i].marker <= previous) entries[i].marker = previous + 1;
        if (entries[i].marker >= next) entries.splice(i, 1);
    }

    if (entries.length === 0) entries.push({ label: "???", marker: 50 });
    status.entries = entries;
    return status;
}

function getPF2eHudHealthStatus() {
    try {
        return normalizePF2eHudHealthStatus(game.settings.get(PF2E_HUD_MODULE_ID, "healthStatusData") || {});
    } catch {
        return normalizePF2eHudHealthStatus();
    }
}

function pf2eHudHueFromPercent(percent) {
    const ratio = clampNumber(percent, 0, 100) / 100;
    return ratio * ratio * 122 + 3;
}

function getPF2eHudHealthBands(status = getPF2eHudHealthStatus()) {
    const bands = [
        { label: status.dead, marker: 0, next: 1, hue: pf2eHudHueFromPercent(0) }
    ];

    status.entries.forEach((entry, index) => {
        const next = status.entries[index + 1]?.marker ?? 100;
        bands.push({
            label: entry.label,
            marker: entry.marker,
            next,
            hue: pf2eHudHueFromPercent((entry.marker + next) / 2)
        });
    });

    bands.push({ label: status.full, marker: 100, next: 100, hue: pf2eHudHueFromPercent(100) });
    return bands;
}

function getPF2eHudHealthBandForValue(value, max, status = getPF2eHudHealthStatus()) {
    const current = Number(value);
    const maximum = Number(max);
    const bands = getPF2eHudHealthBands(status);

    if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0) return null;
    if (current <= 0) return bands[0] ?? null;
    if (current >= maximum) return bands.at(-1) ?? null;

    const percent = Math.max(current / maximum * 100, 1);
    for (let i = status.entries.length - 1; i >= 0; i--) {
        if (percent >= status.entries[i].marker) return bands[i + 1] ?? null;
    }
    return bands[1] ?? null;
}

function getPF2eHudActorHealthTotal(actor) {
    const hp = actor?.system?.attributes?.hp || actor?.attributes?.hp;
    const maxHP = Number(hp?.max);
    if (!hp || !Number.isFinite(maxHP) || maxHP <= 0) return null;

    const currentHP = clampNumber(hp.value, 0, maxHP);
    const useStamina = actor.isOfType?.("character") && game.pf2e?.settings?.variants?.stamina;
    const maxSP = Number((useStamina && hp.sp?.max) || 0);
    const currentSP = clampNumber((useStamina && hp.sp?.value) || 0, 0, maxSP);
    const tempHP = Math.max(Number(hp.temp) || 0, 0);

    return {
        value: currentHP + currentSP + tempHP,
        max: maxHP + maxSP
    };
}

function getPF2eHudCombatant(combatantId) {
    if (!combatantId) return null;

    const current = game.combat?.combatants?.get(combatantId);
    if (current) return current;

    const combats = game.combats instanceof Collection ? game.combats : game.combats?.contents ?? [];
    for (const combat of combats) {
        const combatant = combat?.combatants?.get(combatantId);
        if (combatant) return combatant;
    }

    return null;
}

function setPF2eHudDiscreteHue(element, hue) {
    if (!element) return;
    if (!element.dataset.yulongOriginalHue) {
        element.dataset.yulongOriginalHue = element.style.getPropertyValue("--hue") || "";
    }
    element.style.setProperty("--hue", String(Math.round(hue * 1000) / 1000));
}

function restorePF2eHudDiscreteHealthColors(root = document) {
    root.querySelectorAll?.("[data-yulong-original-hue]").forEach(element => {
        const original = element.dataset.yulongOriginalHue;
        if (original) element.style.setProperty("--hue", original);
        else element.style.removeProperty("--hue");
        delete element.dataset.yulongOriginalHue;
    });
}

function applyPF2eHudDiscreteTrackerHealthColors(status = getPF2eHudHealthStatus()) {
    const tracker = document.querySelector("#pf2e-hud-tracker");
    if (!tracker) return;

    tracker.querySelectorAll("[data-combatant-id]").forEach(element => {
        const combatantId = element.dataset.combatantId;
        const combatant = getPF2eHudCombatant(combatantId);
        const health = getPF2eHudActorHealthTotal(combatant?.actor);
        const band = health && getPF2eHudHealthBandForValue(health.value, health.max, status);
        const healthSpan = element.querySelector(".extras .group .entry:last-child > span[style*='--hue']");

        if (band && healthSpan) setPF2eHudDiscreteHue(healthSpan, band.hue);
    });
}

function applyPF2eHudDiscreteTooltipHealthColors(status = getPF2eHudHealthStatus()) {
    const labelToBand = new Map(getPF2eHudHealthBands(status).map(band => [band.label.trim(), band]));

    document.querySelectorAll("#pf2e-hud-tooltip [data-panel='health-status']").forEach(element => {
        const band = labelToBand.get(element.textContent?.trim() || "");
        if (band) setPF2eHudDiscreteHue(element, band.hue);
    });
}

function applyPF2eHudDiscreteHealthColors() {
    if (!game.modules.get(PF2E_HUD_MODULE_ID)?.active) return;
    if (!game.settings.get(MODULE_ID, PF2E_HUD_DISCRETE_HEALTH_COLORS)) return;

    const status = getPF2eHudHealthStatus();
    applyPF2eHudDiscreteTrackerHealthColors(status);
    applyPF2eHudDiscreteTooltipHealthColors(status);
}

function installPF2eHudDiscreteHealthColors() {
    if (!game.modules.get(PF2E_HUD_MODULE_ID)?.active) return;

    window.yulongHomebrew ??= {};
    window.yulongHomebrew.applyPF2eHudDiscreteHealthColors = applyPF2eHudDiscreteHealthColors;
    window.yulongHomebrew.restorePF2eHudDiscreteHealthColors = restorePF2eHudDiscreteHealthColors;

    if (window.yulongHomebrew.__yulongPF2eHudDiscreteHealthColorsInstalled) return;
    window.yulongHomebrew.__yulongPF2eHudDiscreteHealthColorsInstalled = true;

    applyPF2eHudDiscreteHealthColors();

    let refreshQueued = false;
    const queueRefresh = () => {
        if (refreshQueued) return;
        refreshQueued = true;
        requestAnimationFrame(() => {
            refreshQueued = false;
            applyPF2eHudDiscreteHealthColors();
        });
    };

    const observer = new MutationObserver(() => {
        queueRefresh();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.yulongHomebrew.pf2eHudDiscreteHealthColorObserver = observer;

    Hooks.on("updateActor", queueRefresh);
    Hooks.on("updateCombat", queueRefresh);
    Hooks.on("updateCombatant", queueRefresh);

    console.log("Yulong Homebrew | PF2e HUD discrete health colors ready.");
}

function installToolbeltCompat() {
    const parser = window.CombatParser;
    if (!parser) {
        console.warn("Yulong Homebrew | CombatParser not found. Is PF2e Holodeck enabled?");
        return;
    }

    if (parser.__yulongToolbeltCompatInstalled) return;

    try {
        installToolbeltCompatOn(parser);
    } catch (error) {
        // Leave the install flag unset so a later `ready` (or a manual retry) can try again
        // instead of silently running with a half-wired bridge.
        console.error("Yulong Homebrew | Failed to install the PF2e Holodeck / Toolbelt compatibility bridge.", error);
        return;
    }

    parser.__yulongToolbeltCompatInstalled = MODULE_ID;
    console.log("Yulong Homebrew | PF2e Holodeck Toolbelt compatibility ready.");
}

function installToolbeltCompatOn(parser) {
    const TOOLBELT_PENDING_TIMEOUT_MS = 30000;
    const TOOLBELT_HP_CHANGE_TIMEOUT_MS = 5000;
    const AWA_PENDING_TIMEOUT_MS = 5000;
    const HOLODECK_PENDING_SOURCE_TIMEOUT_MS = 5000;
    const YULONG_KEY_SET_LIMIT = 2000;

    parser.processedToolbeltApplications ??= new Set();
    parser.processedAchievementApplications ??= new Set();
    parser.awaHandledApplications ??= new Set();
    parser.awaHandledApplicationLooseKeys ??= new Set();
    parser.processedAwaPF2eChatMessages ??= new Set();
    parser.yulongProcessedHolodeckMessages ??= new Set();
    parser.processedToolbeltSaveEntries ??= new Set();
    parser.recentHpChanges ??= new Map();
    parser.persistentDamageSources ??= new Map();
    window.yulongHomebrew ??= {};
    window.yulongHomebrew.awaHandledApplications = parser.awaHandledApplications;
    window.yulongHomebrew.awaHandledApplicationLooseKeys = parser.awaHandledApplicationLooseKeys;

    // Every dedupe cache below is append-only. Sets iterate in insertion order, so dropping from
    // the front evicts the oldest keys and keeps a long session from growing without bound.
    parser.rememberYulongKey ??= function(set, key, limit = YULONG_KEY_SET_LIMIT) {
        if (!set || key === undefined || key === null) return;
        set.add(key);
        while (set.size > limit) {
            const oldest = set.values().next().value;
            if (oldest === undefined) break;
            set.delete(oldest);
        }
    };

    parser.isYulongPrimaryGM ??= function() {
        if (!game.user?.isGM) return false;
        const activeGM = game.users?.activeGM;
        if (activeGM) return activeGM.id === game.user.id;
        const activeGMs = game.users?.filter?.(user => user.active && user.isGM)
            || game.users?.contents?.filter?.(user => user.active && user.isGM)
            || [];
        if (activeGMs.length === 0) return true;
        activeGMs.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return activeGMs[0]?.id === game.user.id;
    };

    parser.getToolbeltData ??= function(message) {
        const moduleFlags = message.flags?.["pf2e-toolbelt"];
        if (!moduleFlags) return null;
        return moduleFlags.targetHelper || moduleFlags;
    };

    // Target Helper re-encodes and writes its whole flag object on every change (setMessageData ->
    // setFlag), so `changed` always carries the complete `applied` map even when nothing was
    // applied this time. Treat an empty map as "no applications" and never assume the entries in
    // `changed` are only the new ones - see getChangedToolbeltApplicationEntries.
    parser.hasToolbeltAppliedUpdate ??= function(changed) {
        if (!changed) return false;
        const direct = foundry.utils.getProperty(changed, "flags.pf2e-toolbelt.applied");
        const targetHelper = foundry.utils.getProperty(changed, "flags.pf2e-toolbelt.targetHelper.applied");
        for (const applied of [direct, targetHelper]) {
            if (applied && typeof applied === "object" && Object.keys(applied).length > 0) return true;
        }
        return Object.keys(foundry.utils.flattenObject(changed)).some(k => k.includes("flags.pf2e-toolbelt") && k.includes(".applied."));
    };

    parser.getToolbeltTargetDocument ??= function(targetId, targetRefs = []) {
        for (const ref of targetRefs) {
            let doc = null;
            if (typeof ref === "string") doc = fromUuidSyncSafe(ref);
            else if (ref?.uuid) doc = fromUuidSyncSafe(ref.uuid) || ref;
            else doc = ref;

            if (!doc) continue;
            if (doc.id === targetId || doc.object?.id === targetId) return doc;
            if (doc.actor?.id === targetId) return doc;
        }
        return canvas.scene?.tokens?.get(targetId) || canvas.tokens?.placeables?.find(t => t.id === targetId)?.document || null;
    };

    parser.getToolbeltApplicationEntries ??= function(data) {
        const applied = data?.applied;
        if (!applied || typeof applied !== "object") return [];

        const entries = [];
        Object.entries(applied).forEach(([targetId, rollMap]) => {
            if (!rollMap || typeof rollMap !== "object") return;
            Object.entries(rollMap).forEach(([rollIndex, wasApplied]) => {
                if (wasApplied) entries.push({ targetId, rollIndex: Number(rollIndex) || 0 });
            });
        });
        return entries;
    };

    parser.getChangedToolbeltApplicationEntries ??= function(changed) {
        const flat = foundry.utils.flattenObject(changed || {});
        const entries = new Map();
        for (const [path, value] of Object.entries(flat)) {
            if (!value || !path.includes("flags.pf2e-toolbelt") || !path.includes(".applied.")) continue;
            const match = path.match(/(?:^|\.)applied\.([^.]+)\.(\d+)(?:\.|$)/);
            if (!match) continue;
            const [, targetId, rollIndex] = match;
            entries.set(`${targetId}:${rollIndex}`, { targetId, rollIndex: Number(rollIndex) || 0 });
        }
        return [...entries.values()];
    };

    parser.getToolbeltSaveVariant ??= function(data, variantId = "null") {
        const variants = data?.saveVariants;
        if (!variants || typeof variants !== "object") return null;

        return variants[variantId]
            || variants[String(variantId)]
            || variants.null
            || Object.values(variants).find(variant => variant?.dc !== undefined)
            || null;
    };

    parser.getToolbeltDCSnapshot ??= function(data, variantId = "null") {
        const saveVariant = this.getToolbeltSaveVariant(data, variantId);
        const dc = saveVariant?.dc;
        if (dc === undefined || dc === null) return null;

        if (typeof dc === "object") {
            const value = Number(dc.value ?? dc.dc);
            return Number.isFinite(value) ? foundry.utils.mergeObject(dc, { value }, { inplace: false }) : null;
        }

        const value = Number(dc);
        return Number.isFinite(value) ? { value } : null;
    };

    parser.getChangedToolbeltSaveEntries ??= function(changed) {
        const flat = foundry.utils.flattenObject(changed || {});
        const entries = new Map();
        for (const [path, value] of Object.entries(flat)) {
            if (value === undefined || value === null) continue;
            if (!path.includes("flags.pf2e-toolbelt") || !path.includes(".saveVariants.") || !path.includes(".saves.")) continue;
            const match = path.match(/(?:^|\.)saveVariants\.([^.]+)\.saves\.([^.]+)(?:\.|$)/);
            if (!match) continue;
            const [, variantId, targetId] = match;
            entries.set(`${variantId}:${targetId}`, { variantId, targetId });
        }
        return [...entries.values()];
    };

    parser.getToolbeltSaveEntries ??= function(data, changed) {
        const variants = data?.saveVariants;
        if (!variants || typeof variants !== "object") return [];

        // Best-effort narrowing only: Target Helper rewrites the whole flag, so in practice every
        // save shows up in `changed`. hasProcessedToolbeltSaveEntry is what actually prevents
        // replays.
        const changedEntries = this.getChangedToolbeltSaveEntries(changed);
        const changedKeys = new Set(changedEntries.map(entry => `${entry.variantId}:${entry.targetId}`));
        const entries = [];

        for (const [variantId, variant] of Object.entries(variants)) {
            const saves = variant?.saves;
            if (!saves || typeof saves !== "object") continue;

            for (const [targetId, save] of Object.entries(saves)) {
                if (changedKeys.size > 0 && !changedKeys.has(`${variantId}:${targetId}`)) continue;
                const outcomeSource = typeof save === "object" && save !== null
                    ? save.success ?? save.outcome ?? save.result ?? save.degreeOfSuccess
                    : save;
                const outcome = this.normalizePF2eOutcome(outcomeSource);
                if (!outcome) continue;
                entries.push({ variantId, targetId, variant, save, outcome });
            }
        }

        return entries;
    };

    parser.getYulongStringHash ??= function(value) {
        const text = String(value ?? "");
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
        }
        return `${text.length}-${(hash >>> 0).toString(36)}`;
    };

    parser.getToolbeltSaveEntryFingerprint ??= function(entry) {
        const save = typeof entry?.save === "object" && entry.save !== null ? entry.save : {};
        if (save.roll) {
            const rawRoll = typeof save.roll === "string" ? save.roll : JSON.stringify(save.roll);
            return this.getYulongStringHash(rawRoll);
        }

        return this.getYulongStringHash([
            entry?.outcome,
            save.die ?? save.d20 ?? save.natural,
            save.value ?? save.total ?? save.rollTotal,
            save.success ?? save.outcome ?? save.result,
            save.unadjustedOutcome,
            save.rerolled || save.isReroll ? "reroll" : "roll"
        ].join(":"));
    };

    parser.getToolbeltSaveKey ??= function(messageId, entry) {
        return `${messageId}:${entry.variantId}:${entry.targetId}:${this.getToolbeltSaveEntryFingerprint(entry)}`;
    };

    parser.getYulongLedgerLogs ??= function(ledger) {
        if (!ledger) return [];
        return Array.isArray(ledger.masterLog) ? ledger.masterLog : Object.values(ledger.masterLog || {});
    };

    // The in-memory dedupe caches are wiped by a page reload, but Holodeck restores its ledger
    // from the world backup. Because Target Helper rewrites its whole flag on every change, a
    // single later update would otherwise replay every historical save on that message. Checking
    // the restored ledger for our own marker makes the dedupe survive a reload.
    parser.hasProcessedToolbeltSaveEntry ??= function(saveKey) {
        if (!saveKey) return false;
        if (this.processedToolbeltSaveEntries.has(saveKey)) return true;

        const recorded = [this.ledger, this.explorationLedger].some(ledger =>
            this.getYulongLedgerLogs(ledger).some(entry => entry?.yulongToolbeltSaveKey === saveKey));
        if (recorded) this.rememberYulongKey(this.processedToolbeltSaveEntries, saveKey);
        return recorded;
    };

    parser.getToolbeltApplicationMessageId ??= function(messageId, entry) {
        return `${messageId}-toolbelt-${entry.targetId}-${entry.rollIndex}`;
    };

    parser.hasProcessedToolbeltApplication ??= function(message, entry) {
        const key = this.getToolbeltApplicationKey(message.id, entry.targetId, entry.rollIndex);
        if (this.processedToolbeltApplications.has(key)) return true;

        const syntheticId = this.getToolbeltApplicationMessageId(message.id, entry);
        const recorded = [this.ledger, this.explorationLedger].some(ledger =>
            this.getYulongLedgerLogs(ledger).some(logEntry => logEntry?.yulongMessageId === syntheticId));
        if (recorded) this.rememberYulongKey(this.processedToolbeltApplications, key);
        return recorded;
    };

    parser.buildToolbeltSyntheticD20Roll ??= function({ die, total, outcome, options = [] } = {}) {
        const natural = Number(die);
        const rollTotal = Number(total);
        if (!Number.isInteger(natural) || natural < 1 || natural > 20 || !Number.isFinite(rollTotal)) return null;

        const modifier = rollTotal - natural;
        const signedModifier = modifier === 0 ? "" : `${modifier < 0 ? "" : "+"}${modifier}`;
        return {
            total: rollTotal,
            options: {
                type: "saving-throw",
                degreeOfSuccess: outcome,
                options
            },
            terms: [{
                faces: 20,
                total: natural,
                results: [{ result: natural, active: true }]
            }],
            formula: `1d20${signedModifier}`
        };
    };

    parser.getToolbeltSaveRolls ??= function(entry, options = []) {
        const save = typeof entry?.save === "object" && entry.save !== null ? entry.save : {};
        if (save.roll && typeof Roll !== "undefined" && typeof Roll.fromJSON === "function") {
            try {
                const rawRoll = typeof save.roll === "string" ? save.roll : JSON.stringify(save.roll);
                const roll = Roll.fromJSON(rawRoll);
                if (roll) {
                    roll.options ??= {};
                    roll.options.type ??= "saving-throw";
                    roll.options.degreeOfSuccess ??= entry.outcome;
                    roll.options.options ??= options;
                    return [roll];
                }
            } catch {}
        }

        const synthetic = this.buildToolbeltSyntheticD20Roll({
            die: save.die ?? save.d20 ?? save.natural,
            total: save.value ?? save.total ?? save.rollTotal,
            outcome: entry.outcome,
            options
        });
        return synthetic ? [synthetic] : [];
    };

    parser.getHolodeckResolvedActorName ??= function(actor, alias) {
        const raw = this.getCanonicalName(actor, alias || actor?.name || "Unknown");
        return this.resolveOwner(raw, actor, alias || raw);
    };

    parser.getHolodeckSpeakerTokenDocument ??= function(message) {
        const speaker = message?.speaker;
        if (!speaker?.token) return null;
        const scene = game.scenes?.get?.(speaker.scene)
            || (canvas.scene?.id === speaker.scene ? canvas.scene : null);
        return scene?.tokens?.get?.(speaker.token) || null;
    };

    parser.getHolodeckActiveTokenDocuments ??= function(actor) {
        if (!actor || typeof actor.getActiveTokens !== "function") return [];
        try {
            return actor.getActiveTokens(false, true) || [];
        } catch {
            return [];
        }
    };

    parser.buildHolodeckSourceIdentity ??= function(actor, { speakerToken = null, alias = null, trustAlias = false } = {}) {
        if (!actor) return null;
        const token = selectHolodeckIdentityToken(
            actor,
            speakerToken,
            this.getHolodeckActiveTokenDocuments(actor)
        );
        const preferredAlias = token?.name || (trustAlias ? alias : null) || actor.name;
        return {
            actor,
            token,
            actorUuid: actor.uuid || null,
            tokenUuid: token?.uuid || null,
            alias: preferredAlias || null,
            name: this.getHolodeckResolvedActorName(actor, preferredAlias),
            exactToken: Boolean(token || (trustAlias && alias))
        };
    };

    parser.serializeHolodeckSourceIdentity ??= function(identity) {
        if (!identity) return null;
        return {
            actorUuid: identity.actorUuid || identity.actor?.uuid || null,
            tokenUuid: identity.tokenUuid || identity.token?.uuid || null,
            alias: identity.alias || identity.token?.name || identity.actor?.name || null,
            exactToken: identity.exactToken === true
        };
    };

    parser.getHolodeckMessageOriginActor ??= function(message) {
        const systemFlags = this.getMessageSystemFlags(message) || {};
        const origin = fromUuidSyncSafe(systemFlags.origin?.uuid) || message?.item || null;
        return this.getActorFromDocument(origin);
    };

    parser.getHolodeckSourceIdentity ??= function(message, explicitActor = null) {
        const stored = message?.yulongHolodeckSourceIdentity || message?.toolbeltCompat?.sourceIdentity || null;
        const actor = explicitActor
            || fromUuidSyncSafe(stored?.actorUuid)
            || this.getHolodeckMessageOriginActor(message);
        if (!actor) return null;

        if (stored) {
            return this.buildHolodeckSourceIdentity(actor, {
                speakerToken: fromUuidSyncSafe(stored.tokenUuid),
                alias: stored.alias,
                trustAlias: stored.exactToken === true
            });
        }

        const applied = this.getMessageSystemFlags(message)?.appliedDamage;
        if (!applied) {
            const speakerToken = this.getHolodeckSpeakerTokenDocument(message);
            return this.buildHolodeckSourceIdentity(actor, {
                speakerToken,
                alias: message?.speaker?.alias || message?.alias,
                trustAlias: Boolean(speakerToken)
            });
        }

        return this.buildHolodeckSourceIdentity(actor);
    };

    parser.getHolodeckAppliedTargetToken ??= function(message) {
        const appliedUuid = this.getMessageSystemFlags(message)?.appliedDamage?.uuid;
        const targetDocument = fromUuidSyncSafe(appliedUuid);
        if (!targetDocument) return null;
        if (targetDocument.documentName === "Token") return targetDocument;

        const targetActor = this.getActorFromDocument(targetDocument);
        return selectHolodeckIdentityToken(
            targetActor,
            this.getHolodeckSpeakerTokenDocument(message) || targetActor?.token || null,
            this.getHolodeckActiveTokenDocuments(targetActor)
        );
    };

    parser.hasRecentHolodeckSaveLog ??= function(targetName, outcome) {
        const { ledger } = this.getHolodeckLedger();
        const currentRound = game.combat?.round || 1;
        const normalizedOutcome = this.normalizePF2eOutcome(outcome);
        const logs = Array.isArray(ledger?.masterLog) ? ledger.masterLog : [];

        return logs.slice(-40).some(logEntry => {
            if (logEntry.yulongToolbeltSaveKey) return false;
            if (logEntry.type !== "Save" || logEntry.source !== targetName) return false;
            if (Number(logEntry.round || currentRound) !== currentRound) return false;
            return !normalizedOutcome || this.normalizePF2eOutcome(logEntry.result) === normalizedOutcome;
        });
    };

    parser.getToolbeltApplicationKey ??= function(messageId, targetId, rollIndex) {
        return `${messageId}:${targetId}:${Number(rollIndex) || 0}`;
    };

    parser.getToolbeltApplicationLooseKey ??= function(messageId, rollIndex) {
        return `${messageId}:${Number(rollIndex) || 0}`;
    };

    parser.getDocumentIdFromUuid ??= function(uuid) {
        if (!uuid || typeof uuid !== "string") return null;
        return uuid.split(".").filter(Boolean).at(-1) || null;
    };

    parser.getPendingToolbeltApplication ??= function(messageId) {
        const compat = window.yulongHomebrew;
        const pending = compat?.pendingToolbeltApplication;
        if (!pending) return null;

        if (Date.now() - pending.timestamp > TOOLBELT_PENDING_TIMEOUT_MS) {
            delete compat.pendingToolbeltApplication;
            return null;
        }

        return pending.messageId === messageId ? pending : null;
    };

    parser.clearPendingToolbeltApplication ??= function(pending) {
        const compat = window.yulongHomebrew;
        if (compat?.pendingToolbeltApplication?.timestamp === pending?.timestamp) {
            delete compat.pendingToolbeltApplication;
        }
    };

    parser.isPendingToolbeltEntry ??= function(pending, entry, data) {
        if (!pending) return false;
        if (Number(pending.rollIndex) !== Number(entry.rollIndex)) return false;
        if (pending.targetId && pending.targetId === entry.targetId) return true;

        const targetDoc = this.getToolbeltTargetDocument(entry.targetId, [
            ...(data?.targets || []),
            ...(data?.splashTargets || [])
        ]);

        return Boolean(targetDoc && (
            targetDoc.uuid === pending.targetUuid
            || targetDoc.actor?.uuid === pending.targetActorUuid
            || targetDoc.actor?.id === pending.targetActorId
        ));
    };

    parser.getHolodeckLedger ??= function() {
        const isCombatPhase = (canvas.scene && canvas.scene.getFlag("pf2e-holodeck", "active"))
            || (game.combat && game.combat.active);
        return {
            ledger: isCombatPhase ? this.ledger : this.explorationLedger,
            scope: canvas.scene?.getFlag("pf2e-holodeck", "active")
                ? `holodeck:${canvas.scene.id}`
                : game.combat?.active
                    ? `combat:${game.combat.id}`
                    : "exploration",
            isCombatPhase
        };
    };

    // Several fallbacks below need to hand Holodeck's parser a fuller picture of a message than
    // PF2e actually stores (an inferred outcome, a resolved target, a damage total on
    // appliedDamage). Writing that onto the live ChatMessage would mutate document source data
    // that PF2e and Target Helper read back when applying damage, and any unrelated
    // `message.update({flags})` could persist our guesses. So we parse a detached view instead:
    // a plain snapshot whose system flag branch is copied shallowly down to the two objects we
    // touch. Rolls and documents are shared by reference - nothing mutates them.
    parser.createYulongParseView ??= function(message) {
        const systemKey = this.getMessageSystemKey(message);
        const flags = { ...(message.flags || {}) };
        const systemFlags = systemKey ? message.flags?.[systemKey] : null;

        if (systemFlags) {
            const copy = { ...systemFlags };
            if (systemFlags.context) copy.context = { ...systemFlags.context };
            if (systemFlags.appliedDamage) copy.appliedDamage = { ...systemFlags.appliedDamage };
            flags[systemKey] = copy;
        }

        return {
            id: message.id ?? null,
            actor: message.actor ?? null,
            item: message.item ?? null,
            speaker: message.speaker,
            alias: message.alias,
            flavor: message.flavor,
            content: message.content,
            rolls: message.rolls,
            isDamageRoll: message.isDamageRoll,
            isReroll: message.isReroll,
            whisper: message.whisper,
            blind: message.blind,
            flags,
            toolbeltCompat: message.toolbeltCompat,
            yulongHolodeckSourceIdentity: message.yulongHolodeckSourceIdentity,
            yulongToolbeltApplicationKey: message.yulongToolbeltApplicationKey,
            yulongHpSnapshotTrusted: message.yulongHpSnapshotTrusted,
            yulongSourceMessage: message
        };
    };

    parser.getMessageSystemKey ??= function(message) {
        if (message?.flags?.sf2e) return "sf2e";
        return message?.flags?.pf2e ? "pf2e" : null;
    };

    parser.getMessageSystemFlags ??= function(message) {
        const key = this.getMessageSystemKey(message);
        return key ? message.flags?.[key] : null;
    };

    parser.isAoEEasyResolveMessage ??= function(message) {
        return message?.flags?.["aoe-easy-resolve"]?.damageTotal !== undefined;
    };

    parser.isHolodeckDamageApplicationMessage ??= function(message) {
        const systemFlags = this.getMessageSystemFlags(message);
        if (!systemFlags) return false;
        if (this.isAoEEasyResolveMessage(message)) return false;
        const context = systemFlags.context || {};
        return context.type === "damage-taken" || Boolean(systemFlags.appliedDamage);
    };

    parser.getActorFromDocument ??= function(document) {
        if (!document) return null;
        if (document.documentName === "Actor") return document;
        return document.actor || (document.parent?.documentName === "Actor" ? document.parent : null);
    };

    parser.areSameActorDocument ??= function(first, second) {
        if (!first || !second) return false;
        if (first.uuid && second.uuid) return first.uuid === second.uuid;
        return Boolean(first.id && second.id && first.id === second.id);
    };

    parser.getPersistentDamageSourceKeys ??= function(condition) {
        if (!condition) return [];
        const actor = this.getActorFromDocument(condition);
        return [condition.uuid, actor?.uuid && condition.id ? `${actor.uuid}:${condition.id}` : null].filter(Boolean);
    };

    parser.getPersistentDamageSourceRecord ??= function(condition) {
        for (const key of this.getPersistentDamageSourceKeys(condition)) {
            const record = this.persistentDamageSources.get(key);
            if (record) return record;
        }
        return null;
    };

    parser.getPersistentDamageSourceActor ??= function(condition) {
        const record = this.getPersistentDamageSourceRecord(condition);
        return fromUuidSyncSafe(record?.sourceActorUuid)
            || game.actors.get(record?.sourceActorId)
            || null;
    };

    parser.prunePersistentDamageSources ??= function() {
        while (this.persistentDamageSources.size > 500) {
            const oldest = this.persistentDamageSources.keys().next().value;
            if (!oldest) break;
            this.persistentDamageSources.delete(oldest);
        }
    };

    parser.recordPersistentDamageSources ??= function(message) {
        const systemFlags = this.getMessageSystemFlags(message) || {};
        const applied = systemFlags.appliedDamage;
        const conditionIds = Array.isArray(applied?.persistent) ? applied.persistent.filter(Boolean) : [];
        if (!applied?.uuid || conditionIds.length === 0) return false;

        const targetActor = this.getActorFromDocument(fromUuidSyncSafe(applied.uuid));
        if (!targetActor?.items) return false;

        const origin = fromUuidSyncSafe(systemFlags.origin?.uuid) || message.item || null;
        const inherited = isPersistentDamageItem(origin) ? this.getPersistentDamageSourceRecord(origin) : null;
        const sourceActor = inherited
            ? fromUuidSyncSafe(inherited.sourceActorUuid) || game.actors.get(inherited.sourceActorId)
            : this.getActorFromDocument(origin);
        const sourceIdentity = sourceActor ? this.getHolodeckSourceIdentity(message, sourceActor) : null;
        const sourceName = sourceIdentity?.name || inherited?.sourceName;
        if (!sourceName) return false;

        const record = {
            sourceActorId: sourceActor?.id || inherited?.sourceActorId || null,
            sourceActorUuid: sourceActor?.uuid || inherited?.sourceActorUuid || null,
            sourceTokenUuid: sourceIdentity?.tokenUuid || inherited?.sourceTokenUuid || null,
            sourceAlias: sourceIdentity?.alias || inherited?.sourceAlias || null,
            sourceName,
            sourceType: sourceActor?.type || inherited?.sourceType || "npc",
            sourceLevel: Number(sourceActor?.system?.details?.level?.value ?? inherited?.sourceLevel ?? 0) || 0,
            sourceIsAlly: sourceActor ? Boolean(
                sourceActor.type === "character"
                || sourceActor.type === "familiar"
                || sourceActor.alliance === "party"
                || sourceActor.hasPlayerOwner
            ) : Boolean(inherited?.sourceIsAlly),
            actionName: origin?.name || inherited?.actionName || null,
            timestamp: Date.now()
        };

        let recorded = false;
        for (const conditionId of conditionIds) {
            const condition = targetActor.items.get(conditionId);
            if (!isPersistentDamageItem(condition)) continue;
            for (const key of this.getPersistentDamageSourceKeys(condition)) {
                this.persistentDamageSources.set(key, record);
                recorded = true;
            }
        }
        if (recorded) this.prunePersistentDamageSources();
        return recorded;
    };

    parser.getPersistentDamageMessageContext ??= function(message) {
        const systemFlags = this.getMessageSystemFlags(message) || {};
        const origin = fromUuidSyncSafe(systemFlags.origin?.uuid) || message?.item || null;
        if (!isPersistentDamageItem(origin)) return null;

        const conditionActor = this.getActorFromDocument(origin);
        const appliedTarget = systemFlags.appliedDamage?.uuid
            ? this.getActorFromDocument(fromUuidSyncSafe(systemFlags.appliedDamage.uuid))
            : conditionActor;
        if (!conditionActor || !appliedTarget || !this.areSameActorDocument(conditionActor, appliedTarget)) return null;

        const record = this.getPersistentDamageSourceRecord(origin);
        const sourceActor = this.getPersistentDamageSourceActor(origin);
        return {
            condition: origin,
            targetActor: appliedTarget,
            sourceActor,
            sourceName: record?.sourceName || "Persistent Damage",
            sourceRecord: record,
            resolved: Boolean(record),
            isDamageRoll: Boolean(message?.isDamageRoll || systemFlags.context?.type === "damage-roll")
        };
    };

    parser.ensureHolodeckActorStats ??= function(ledger, name, actor = null, record = null) {
        if (!ledger?.actors || !name) return null;
        if (ledger.actors[name]) return ledger.actors[name];

        const isAlly = record?.sourceIsAlly ?? Boolean(actor && (
            actor.type === "character"
            || actor.type === "familiar"
            || actor.alliance === "party"
            || actor.hasPlayerOwner
        ));
        ledger.actors[name] = {
            name,
            type: actor?.type || record?.sourceType || "npc",
            level: Number(actor?.system?.details?.level?.value ?? record?.sourceLevel ?? 0) || 0,
            isAlly,
            master: actor ? this.getMasterName(actor, actor.name) : null,
            damageDealt: 0,
            healingDealt: 0,
            hits: 0,
            misses: 0,
            crits: 0,
            critMisses: 0,
            damageTakenTypes: {},
            damageTakenSources: {},
            healingReceivedSources: {},
            mitigatedSources: {},
            incomingAttacks: 0,
            incomingAttacksDodged: 0,
            incomingSaves: 0,
            incomingSavesResisted: 0,
            advanced: { huntedShots: 0, huntedShotDmg: 0, taunts: 0, tauntTriggers: 0, surges: 0, surgeFriendlyDmg: 0, surgeTypes: {} },
            nat1s: 0,
            nat20s: 0,
            kills: 0,
            mitigated: 0,
            heroPoints: 0,
            heroPointCrits: 0,
            expectedDamage: 0,
            actualDamageRoll: 0,
            damageTypes: {},
            turnTimes: [],
            d20Rolls: Array(20).fill(0),
            history: []
        };
        return ledger.actors[name];
    };

    parser.getHolodeckMessageActionName ??= function(message, fallback = "Unknown Action") {
        const flavor = String(message?.flavor || "")
            .replace(/<\/h4>/gi, " - ")
            .replace(/<\/span>/gi, " | ")
            .replace(/<[^>]+>/g, "")
            .replace(/\s+/g, " ")
            .replace(/\|\s*\|/g, "|")
            .replace(/\s*\|\s*$/g, "")
            .trim();
        return flavor || message?.item?.name || fallback;
    };

    parser.parsePersistentDamageRoll ??= function(message) {
        const context = this.getPersistentDamageMessageContext(message);
        if (!context?.isDamageRoll || !Array.isArray(message?.rolls) || message.rolls.length === 0) return false;
        // Without a recorded originator there is nobody to re-attribute the tick to, and booking it
        // under the placeholder name would add a fake actor row to the report. Fall through to
        // Holodeck's own parsing instead.
        if (!context.resolved) return false;

        const key = this.getHolodeckParseKey(message);
        if (key && this.yulongProcessedHolodeckMessages.has(key)) return true;
        const { ledger, isCombatPhase } = this.getHolodeckLedger();
        if (!ledger) return false;

        const stats = this.ensureHolodeckActorStats(ledger, context.sourceName, context.sourceActor, context.sourceRecord);
        if (!stats) return false;
        const summary = summarizeHolodeckDamageRolls(message.rolls);
        stats.expectedDamage = Number(stats.expectedDamage || 0) + summary.expectedDamage;
        stats.actualDamageRoll = Number(stats.actualDamageRoll || 0) + summary.actualDamageRoll;
        stats.damageTypes ??= {};
        for (const [type, values] of Object.entries(summary.damageTypes)) {
            stats.damageTypes[type] ??= { instances: 0, total: 0 };
            stats.damageTypes[type].instances += Number(values.instances || 0);
            stats.damageTypes[type].total += Number(values.total || 0);
        }

        const currentRound = game.combat?.round || 1;
        const logEntry = {
            id: foundry.utils.randomID(),
            round: currentRound,
            source: context.sourceName,
            target: "None",
            type: "Roll",
            name: this.getHolodeckMessageActionName(message, context.condition.name || "Persistent Damage"),
            result: `Dice Pool: ${summary.actualDamageRoll}`,
            detail: summary.details.length > 0 ? summary.details.join(", ") : `Rolled ${message.rolls.length} dice`,
            damageVal: 0,
            healVal: 0,
            minion: null,
            yulongMessageId: message.id || null,
            yulongParseKey: key,
            yulongPersistentDamageRoll: true,
            yulongPersistentDamageResolved: context.resolved,
            yulongExpectedDamage: summary.expectedDamage,
            yulongActualDamageRoll: summary.actualDamageRoll,
            yulongRollDamageTypes: foundry.utils.deepClone(summary.damageTypes)
        };
        stats.history.push(logEntry);
        ledger.masterLog.push(logEntry);
        if (key) this.rememberYulongKey(this.yulongProcessedHolodeckMessages, key);
        if (isCombatPhase && typeof this.saveLiveBackup === "function") this.saveLiveBackup();
        return true;
    };

    parser.normalizePF2eOutcome ??= function(value) {
        if (value === undefined || value === null || value === "") return null;
        const degree = Number(value);
        if (Number.isInteger(degree)) {
            return ["criticalFailure", "failure", "success", "criticalSuccess"][degree] || null;
        }

        const normalized = String(value).toLowerCase().replace(/[^a-z]/g, "");
        if (normalized === "criticalfailure" || normalized === "critfailure" || normalized === "criticalfail") return "criticalFailure";
        if (normalized === "failure" || normalized === "fail") return "failure";
        if (normalized === "success") return "success";
        if (normalized === "criticalsuccess" || normalized === "critsuccess") return "criticalSuccess";
        return null;
    };

    parser.getHolodeckRollContextType ??= function(message) {
        const context = this.getMessageSystemFlags(message)?.context || {};
        const type = context.type || message?.rolls?.[0]?.options?.type;
        return [
            "attack-roll",
            "spell-attack-roll",
            "saving-throw",
            "skill-check",
            "perception-check"
        ].includes(type) ? type : null;
    };

    parser.getHolodeckD20Result ??= function(message) {
        const results = getPF2eMessageD20Results(message);
        const value = Number(results[0]);
        return Number.isInteger(value) && value >= 1 && value <= 20 ? value : null;
    };

    parser.getHolodeckRollOutcome ??= function(message, context = {}) {
        const existing = this.normalizePF2eOutcome(context.outcome);
        if (existing) return existing;

        const roll = message?.rolls?.[0];
        const fromRollDegree = this.normalizePF2eOutcome(roll?.options?.degreeOfSuccess);
        if (fromRollDegree) return fromRollDegree;

        const total = Number(roll?.total);
        const dc = Number(context.dc?.value ?? context.dc);
        if (!Number.isFinite(total) || !Number.isFinite(dc)) return null;

        let degree = total >= dc + 10 ? 3 : total >= dc ? 2 : total <= dc - 10 ? 0 : 1;
        const natural = this.getHolodeckD20Result(message);
        if (natural === 20) degree = Math.min(3, degree + 1);
        else if (natural === 1) degree = Math.max(0, degree - 1);
        return this.normalizePF2eOutcome(degree);
    };

    parser.getHolodeckSingleTargetDocument ??= function(message) {
        const systemFlags = this.getMessageSystemFlags(message) || {};
        const context = systemFlags.context || {};
        const directUuid = context.target?.token || systemFlags.target?.token || message?.target?.token?.uuid;
        if (directUuid) return fromUuidSyncSafe(directUuid);

        const data = this.getToolbeltData(message);
        const targets = [...(data?.targets || []), ...(data?.splashTargets || [])];
        if (targets.length !== 1) return null;
        const target = targets[0];
        return typeof target === "string" ? fromUuidSyncSafe(target) : fromUuidSyncSafe(target?.uuid) || target;
    };

    parser.applyHolodeckRollContextFallbacks ??= function(message) {
        const systemFlags = this.getMessageSystemFlags(message);
        if (!systemFlags) return false;

        const context = systemFlags.context ??= {};
        let changed = false;

        if (!context.type) {
            const type = this.getHolodeckRollContextType(message);
            if (type) {
                context.type = type;
                changed = true;
            }
        }

        const outcome = this.getHolodeckRollOutcome(message, context);
        if (outcome && !context.outcome) {
            context.outcome = outcome;
            changed = true;
        }
        if (outcome && !context.unadjustedOutcome) {
            context.unadjustedOutcome = outcome;
            changed = true;
        }

        if (!context.target?.token) {
            const targetDoc = this.getHolodeckAppliedTargetToken(message)
                || this.getHolodeckSingleTargetDocument(message);
            if (targetDoc?.uuid) {
                context.target = {
                    actor: targetDoc.actor?.uuid || targetDoc.uuid,
                    token: targetDoc.uuid
                };
                changed = true;
            }
        }

        const rollOptions = message?.rolls?.[0]?.options || {};
        const contextOptions = new Set(Array.isArray(context.options) ? context.options : []);
        if (Array.isArray(rollOptions.options)) rollOptions.options.forEach(option => contextOptions.add(option));
        else if (rollOptions.options instanceof Set) rollOptions.options.forEach(option => contextOptions.add(option));
        if (message?.isReroll || rollOptions.isReroll || contextOptions.has("check:reroll") || [...contextOptions].some(option => String(option).startsWith("check:reroll:"))) {
            if (!context.isReroll) {
                context.isReroll = true;
                changed = true;
            }
            if (!contextOptions.has("hero-point") && [...contextOptions].some(option => String(option).includes("hero-points"))) {
                contextOptions.add("hero-point");
                changed = true;
            }
        }
        if (contextOptions.size > 0 && JSON.stringify(context.options || []) !== JSON.stringify([...contextOptions])) {
            context.options = [...contextOptions];
            changed = true;
        }

        return changed;
    };

    parser.adjustHolodeckD20Stats ??= function(stats, value, sign) {
        const natural = Number(value);
        if (!Number.isInteger(natural) || natural < 1 || natural > 20 || !stats) return;

        stats.d20Rolls ??= Array(20).fill(0);
        stats.d20Rolls[natural - 1] = Math.max(0, Number(stats.d20Rolls[natural - 1] || 0) + sign);
        if (natural === 1) stats.nat1s = Math.max(0, Number(stats.nat1s || 0) + sign);
        if (natural === 20) stats.nat20s = Math.max(0, Number(stats.nat20s || 0) + sign);
    };

    parser.patchHolodeckRollD20Stats ??= function(message, ledger, newLogs) {
        const natural = this.getHolodeckD20Result(message);
        if (!natural) return false;

        let changed = false;
        for (const logEntry of newLogs || []) {
            if (!["Attack", "Save", "Skill"].includes(logEntry.type)) continue;
            const stats = ledger?.actors?.[logEntry.source];
            if (!stats) continue;

            const detail = String(logEntry.detail || "");
            const logged = Number(detail.match(/\bd20:\s*(\d+)/i)?.[1]);
            if (logged === natural) continue;

            if (Number.isInteger(logged) && logged >= 1 && logged <= 20) this.adjustHolodeckD20Stats(stats, logged, -1);
            this.adjustHolodeckD20Stats(stats, natural, 1);
            logEntry.detail = detail.match(/\bd20:\s*\d+/i)
                ? detail.replace(/\bd20:\s*\d+/i, `d20: ${natural}`)
                : `${detail}<br><span style="color:#aaa;"><b>d20:</b> ${natural}</span>`;
            logEntry.yulongD20Result = natural;
            changed = true;
        }
        return changed;
    };

    parser.getAppliedDamageSummary ??= function(appliedDamage) {
        if (!appliedDamage || appliedDamage.isReverted) return null;
        const updates = Array.isArray(appliedDamage.updates) ? appliedDamage.updates : [];
        const hpUpdates = updates.filter(update => typeof update?.path === "string"
            && /system\.attributes\.hp\.(?:value|temp|sp\.value)$/.test(update.path)
            && Number.isFinite(Number(update.value)));
        const amount = hpUpdates.reduce((total, update) => total + Math.abs(Number(update.value)), 0);
        if (!Number.isFinite(amount) || amount <= 0) return null;

        const actor = fromUuidSyncSafe(appliedDamage.uuid);
        const isHealing = appliedDamage.isHealing === true;

        // Preferred source: the HP values captured in preUpdateActor, which are exact.
        const recorded = this.peekRecentHpChange(actor);
        if (recorded && Number.isFinite(Number(recorded.previousHp)) && Number.isFinite(Number(recorded.currentHp))) {
            return {
                amount,
                isHealing,
                previousHp: Number(recorded.previousHp),
                currentHp: Number(recorded.currentHp),
                trusted: true
            };
        }

        // Fallback: read the actor now and walk the update deltas back. Only correct while the
        // actor still holds exactly the value this application produced, which is not guaranteed
        // on a client that merely received the message, so the result is flagged untrusted.
        const currentHp = Number(actor?.system?.attributes?.hp?.value);
        const hpValueUpdate = hpUpdates.find(update => update.path === "system.attributes.hp.value");
        const hpDelta = Number(hpValueUpdate?.value);
        const previousHp = Number.isFinite(currentHp) && Number.isFinite(hpDelta) ? currentHp + hpDelta : undefined;

        return {
            amount,
            isHealing,
            previousHp,
            currentHp: Number.isFinite(currentHp) ? currentHp : undefined,
            trusted: false
        };
    };

    parser.augmentPF2eAppliedDamage ??= function(message) {
        const systemFlags = this.getMessageSystemFlags(message);
        const appliedDamage = systemFlags?.appliedDamage;
        if (!appliedDamage || appliedDamage.isReverted) return false;

        const summary = this.getAppliedDamageSummary(appliedDamage);
        if (!summary) return false;

        let changed = false;
        if (!Number.isFinite(Number(appliedDamage.amount ?? appliedDamage.damage))) {
            appliedDamage.amount = summary.amount;
            appliedDamage.damage = summary.amount;
            changed = true;
        }
        if (appliedDamage.isHealing === undefined) {
            appliedDamage.isHealing = summary.isHealing;
            changed = true;
        }
        if (!Number.isFinite(Number(appliedDamage.previousHp)) && summary.previousHp !== undefined) {
            appliedDamage.previousHp = summary.previousHp;
            changed = true;
        }
        if (!Number.isFinite(Number(appliedDamage.currentHp)) && summary.currentHp !== undefined) {
            appliedDamage.currentHp = summary.currentHp;
            changed = true;
        }
        // Recorded on the view (not the flag) so kill normalisation knows whether it may act on a
        // "this was not a kill" verdict or should only ever add one.
        message.yulongHpSnapshotTrusted = summary.trusted === true;
        return changed;
    };

    parser.getHolodeckParseKey ??= function(message) {
        if (!message?.id) return null;
        const { scope } = this.getHolodeckLedger();
        const systemFlags = this.getMessageSystemFlags(message) || {};
        const applied = systemFlags.appliedDamage || {};
        const appliedPart = applied.uuid ? `:${applied.uuid}:${Number(applied.amount ?? applied.damage ?? 0)}` : "";
        return `${scope}:${message.id}${appliedPart}`;
    };

    parser.snapshotDamageTakenTypes ??= function(ledger) {
        const snapshot = {};
        for (const [name, stats] of Object.entries(ledger?.actors || {})) {
            snapshot[name] = foundry.utils.deepClone(stats.damageTakenTypes || {});
        }
        return snapshot;
    };

    parser.getDamageTypeDiff ??= function(before = {}, after = {}) {
        const diff = {};
        const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
        for (const key of keys) {
            const change = Number(after?.[key] || 0) - Number(before?.[key] || 0);
            if (change > 0) diff[key] = change;
        }
        return diff;
    };

    parser.addDamageTypeMap ??= function(stats, values = {}, sign = 1) {
        if (!stats) return;
        stats.damageTakenTypes ??= {};
        for (const [type, amount] of Object.entries(values || {})) {
            const value = Number(amount);
            if (!Number.isFinite(value) || value === 0) continue;
            stats.damageTakenTypes[type] = Math.max(0, Number(stats.damageTakenTypes[type] || 0) + value * sign);
            if (stats.damageTakenTypes[type] === 0) delete stats.damageTakenTypes[type];
        }
    };

    parser.getRollDamageTypeTotals ??= function(message) {
        const totals = {};
        for (const roll of message?.rolls || []) {
            for (const instance of roll.instances || []) {
                const amount = Number(instance.total);
                if (!Number.isFinite(amount) || amount <= 0) continue;
                const type = instance.type || "untyped";
                totals[type] = (totals[type] || 0) + amount;
            }
        }
        return totals;
    };

    parser.scaleDamageTypeTotals ??= function(typeTotals, targetTotal) {
        const total = Math.max(0, Math.trunc(Number(targetTotal) || 0));
        const entries = Object.entries(typeTotals || {}).filter(([, value]) => Number(value) > 0);
        const rawTotal = entries.reduce((sum, [, value]) => sum + Number(value), 0);
        if (total <= 0) return {};
        if (rawTotal <= 0 || entries.length === 0) return { applied: total };

        const scaled = {};
        const remainders = entries.map(([type, value]) => {
            const exact = Number(value) / rawTotal * total;
            const base = Math.floor(exact);
            scaled[type] = base;
            return { type, remainder: exact - base };
        }).sort((a, b) => b.remainder - a.remainder);

        let remaining = total - Object.values(scaled).reduce((sum, value) => sum + value, 0);
        for (const entry of remainders) {
            if (remaining <= 0) break;
            scaled[entry.type] += 1;
            remaining -= 1;
        }

        return Object.fromEntries(Object.entries(scaled).filter(([, value]) => value > 0));
    };

    parser.getNormalizedDamageTypeMap ??= function(message, logEntry) {
        if (!logEntry || logEntry.type !== "Damage") return null;
        const amount = Number(logEntry.damageVal || 0);
        if (!Number.isFinite(amount) || amount <= 0) return null;
        const rollTypes = this.getRollDamageTypeTotals(message);
        if (Object.keys(rollTypes).length > 0) return this.scaleDamageTypeTotals(rollTypes, amount);

        const persistent = this.getPersistentDamageMessageContext(message)?.condition?.system?.persistent;
        const damageType = persistent?.damageType
            || persistent?.damage?.damageType
            || persistent?.damage?.type
            || null;
        return damageType ? { [damageType]: amount } : { applied: amount };
    };

    parser.normalizeHolodeckDamageTypes ??= function(message, ledger, beforeTypes, newLogs) {
        let changed = false;
        // The baseline has to advance per entry: if one message books two Damage logs against the
        // same target, comparing both against the pre-parse snapshot would attribute the first
        // entry's amounts to the second and then subtract them twice.
        const baseline = { ...(beforeTypes || {}) };

        for (const logEntry of newLogs || []) {
            if (logEntry.type !== "Damage" || !logEntry.target || logEntry.target === "None") continue;
            const targetStats = ledger?.actors?.[logEntry.target];
            if (!targetStats) continue;

            const rawDiff = this.getDamageTypeDiff(baseline[logEntry.target] || {}, targetStats.damageTakenTypes || {});
            const normalized = this.getNormalizedDamageTypeMap(message, logEntry) || rawDiff;
            logEntry.yulongDamageTypeAdjustments = foundry.utils.deepClone(normalized);

            if (JSON.stringify(rawDiff) !== JSON.stringify(normalized)) {
                this.addDamageTypeMap(targetStats, rawDiff, -1);
                this.addDamageTypeMap(targetStats, normalized, 1);
                changed = true;
            }
            baseline[logEntry.target] = foundry.utils.deepClone(targetStats.damageTakenTypes || {});
        }
        return changed;
    };

    parser.getHolodeckMessageText ??= function(message) {
        return `${message?.flavor || ""} ${message?.content || ""}`.replace(/<[^>]*>?/gm, " ");
    };

    parser.snapshotHolodeckMitigated ??= function(ledger) {
        const snapshot = {};
        for (const [name, stats] of Object.entries(ledger?.actors || {})) {
            snapshot[name] = Number(stats?.mitigated || 0);
        }
        return snapshot;
    };

    // We used to re-derive the mitigated amount with our own regex, which did not match the one
    // Holodeck books with - so reverting or re-attributing an entry subtracted a number that had
    // never been added. Diffing the ledger instead records exactly what Holodeck credited, and
    // naturally records nothing for healing entries (which Holodeck never books mitigation for).
    parser.assignHolodeckMitigatedAmounts ??= function(ledger, beforeMitigated, newLogs) {
        const unassigned = {};
        for (const logEntry of newLogs || []) {
            const target = logEntry?.target;
            if (!target || target === "None") continue;
            if (!["Damage", "Mitigation"].includes(logEntry.type)) continue;

            if (unassigned[target] === undefined) {
                const after = Number(ledger?.actors?.[target]?.mitigated || 0);
                unassigned[target] = Math.max(0, after - Number(beforeMitigated?.[target] || 0));
            }
            if (unassigned[target] <= 0) continue;

            logEntry.yulongMitigatedAmount = unassigned[target];
            unassigned[target] = 0;
        }
    };

    parser.getHolodeckAdvancedAdjustments ??= function(message, ledger, logEntry) {
        if (logEntry?.type !== "Damage") return null;
        const amount = Number(logEntry.damageVal || 0);
        if (!Number.isFinite(amount) || amount <= 0) return null;

        const fullText = this.getHolodeckMessageText(message).toLowerCase();
        const actionName = String(logEntry.name || "").toLowerCase();
        const adjustments = {};
        if (actionName.includes("hunted shot") || fullText.includes("hunted shot")) adjustments.huntedShotDmg = amount;

        const sourceStats = ledger?.actors?.[logEntry.source];
        const targetStats = ledger?.actors?.[logEntry.target];
        if (fullText.includes("wellspring surge") && sourceStats?.isAlly && targetStats?.isAlly) {
            adjustments.surgeFriendlyDmg = amount;
        }

        return Object.keys(adjustments).length > 0 ? adjustments : null;
    };

    parser.getHolodeckActionKey ??= function(logEntry) {
        return String(logEntry?.name || "Unknown Action")
            .split(/(?: - | \| )/)[0]
            .trim()
            .replace(/\s*\([^)]*$/, "")
            .replace(/^(?:Damage Roll:\s*|Roll:\s*)/i, "")
            .trim();
    };

    parser.moveHolodeckNestedSourceValue ??= function(container, oldSource, newSource, key, amount) {
        const value = Number(amount);
        if (!container || !oldSource || !newSource || !key || !Number.isFinite(value) || value <= 0) return;
        const oldMap = container[oldSource];
        if (oldMap) {
            oldMap[key] = Math.max(0, Number(oldMap[key] || 0) - value);
            if (oldMap[key] === 0) delete oldMap[key];
            if (Object.keys(oldMap).length === 0) delete container[oldSource];
        }
        container[newSource] ??= {};
        container[newSource][key] = Number(container[newSource][key] || 0) + value;
    };

    parser.reassignHolodeckLogSource ??= function(ledger, logEntry, sourceName, sourceActor = null, sourceRecord = null) {
        const oldSource = logEntry?.source;
        if (!ledger || !logEntry || !oldSource || !sourceName || oldSource === sourceName) return false;

        const oldStats = ledger.actors?.[oldSource];
        const newStats = this.ensureHolodeckActorStats(ledger, sourceName, sourceActor, sourceRecord);
        if (!newStats) return false;

        const damage = Number(logEntry.damageVal || 0);
        const healing = Number(logEntry.healVal || 0);
        if (logEntry.type === "Damage" && damage > 0) {
            if (oldStats) oldStats.damageDealt = Math.max(0, Number(oldStats.damageDealt || 0) - damage);
            newStats.damageDealt = Number(newStats.damageDealt || 0) + damage;
            const advanced = logEntry.yulongAdvancedAdjustments || {};
            for (const key of ["huntedShotDmg", "surgeFriendlyDmg"]) {
                const value = Number(advanced[key] || 0);
                if (value <= 0) continue;
                if (oldStats?.advanced) oldStats.advanced[key] = Math.max(0, Number(oldStats.advanced[key] || 0) - value);
                newStats.advanced ??= {};
                newStats.advanced[key] = Number(newStats.advanced[key] || 0) + value;
            }
        } else if (logEntry.type === "Heal" && healing > 0) {
            if (oldStats) oldStats.healingDealt = Math.max(0, Number(oldStats.healingDealt || 0) - healing);
            newStats.healingDealt = Number(newStats.healingDealt || 0) + healing;
        }

        if (hasHolodeckKillMarker(logEntry.result)) {
            if (oldStats) oldStats.kills = Math.max(0, Number(oldStats.kills || 0) - 1);
            newStats.kills = Number(newStats.kills || 0) + 1;
        }

        const targetStats = ledger.actors?.[logEntry.target];
        const actionKey = this.getHolodeckActionKey(logEntry);
        if (logEntry.type === "Damage" && damage > 0) {
            this.moveHolodeckNestedSourceValue(targetStats?.damageTakenSources, oldSource, sourceName, actionKey, damage);
        } else if (logEntry.type === "Heal" && healing > 0) {
            this.moveHolodeckNestedSourceValue(targetStats?.healingReceivedSources, oldSource, sourceName, actionKey, healing);
        }

        const mitigated = Number(logEntry.yulongMitigatedAmount || 0);
        if (targetStats?.mitigatedSources && mitigated > 0) {
            targetStats.mitigatedSources[oldSource] = Math.max(0, Number(targetStats.mitigatedSources[oldSource] || 0) - mitigated);
            if (targetStats.mitigatedSources[oldSource] === 0) delete targetStats.mitigatedSources[oldSource];
            targetStats.mitigatedSources[sourceName] = Number(targetStats.mitigatedSources[sourceName] || 0) + mitigated;
        }

        let historyEntry = null;
        if (Array.isArray(oldStats?.history)) {
            const historyIndex = oldStats.history.findIndex(entry => entry.id === logEntry.id);
            if (historyIndex >= 0) historyEntry = oldStats.history.splice(historyIndex, 1)[0];
        }
        logEntry.source = sourceName;
        if (historyEntry && historyEntry !== logEntry) historyEntry.source = sourceName;
        const movedEntry = historyEntry || logEntry;
        if (!newStats.history.some(entry => entry.id === movedEntry.id)) newStats.history.push(movedEntry);
        return true;
    };

    parser.removeEmptyHolodeckActorStats ??= function(ledger, names = []) {
        for (const name of new Set(names)) {
            const stats = ledger?.actors?.[name];
            if (stats && !holodeckStatsHaveValues(stats)) delete ledger.actors[name];
        }
    };

    parser.correctHolodeckSourceIdentity ??= function(message, ledger, newLogs) {
        if (!this.getMessageSystemFlags(message)?.appliedDamage) return false;
        if (this.getPersistentDamageMessageContext(message)) return false;
        const identity = this.getHolodeckSourceIdentity(message);
        if (!identity?.exactToken || !identity.name) return false;

        let changed = false;
        const previousSources = [];
        for (const logEntry of newLogs || []) {
            if (!["Damage", "Heal", "Mitigation"].includes(logEntry.type)) continue;
            const previousSource = logEntry.source;
            previousSources.push(previousSource);
            const moved = this.reassignHolodeckLogSource(ledger, logEntry, identity.name, identity.actor);
            logEntry.yulongSourceIdentity = {
                ...this.serializeHolodeckSourceIdentity(identity),
                previousSource,
                source: identity.name
            };
            changed = moved || changed;
        }
        this.removeEmptyHolodeckActorStats(ledger, previousSources);
        return changed;
    };

    parser.correctPersistentDamageHolodeckSources ??= function(message, ledger, newLogs) {
        const context = this.getPersistentDamageMessageContext(message);
        if (!context || !this.getMessageSystemFlags(message)?.appliedDamage) return false;
        // Same reasoning as parsePersistentDamageRoll: never move stats onto the placeholder name.
        if (!context.resolved) return false;

        let changed = false;
        const previousSources = [];
        for (const logEntry of newLogs || []) {
            if (!["Damage", "Mitigation"].includes(logEntry.type)) continue;
            const previousSource = logEntry.source;
            previousSources.push(previousSource);
            const moved = this.reassignHolodeckLogSource(
                ledger,
                logEntry,
                context.sourceName,
                context.sourceActor,
                context.sourceRecord
            );
            logEntry.yulongPersistentDamageSource = {
                conditionUuid: context.condition.uuid || null,
                previousSource,
                source: context.sourceName,
                resolved: context.resolved
            };
            changed = moved || changed;
        }
        this.removeEmptyHolodeckActorStats(ledger, previousSources);
        return changed;
    };

    parser.normalizeHolodeckKillStats ??= function(message, ledger, newLogs) {
        const applied = this.getMessageSystemFlags(message)?.appliedDamage;
        const previousHp = Number(applied?.previousHp);
        const currentHp = Number(applied?.currentHp);
        if (!Number.isFinite(previousHp) || !Number.isFinite(currentHp)) return false;

        // Only HP values captured in preUpdateActor are exact. With a reconstructed snapshot we
        // may promote a missed kill, but we must never revoke one Holodeck already booked - a
        // wrong "no kill" verdict is worse than leaving its own heuristic alone.
        const trusted = message?.yulongHpSnapshotTrusted === true;

        let changed = false;
        for (const logEntry of newLogs || []) {
            if (logEntry.type !== "Damage") continue;
            const amount = Number(applied?.amount ?? applied?.damage ?? logEntry.damageVal);
            const shouldCount = isHpDefeatTransition({
                previousHp,
                currentHp,
                amount,
                isHealing: applied?.isHealing === true
            });
            const hasMarker = hasHolodeckKillMarker(logEntry.result);
            if (!shouldCount && !trusted) continue;

            const sourceStats = ledger?.actors?.[logEntry.source];
            if (sourceStats && hasMarker !== shouldCount) {
                sourceStats.kills = Math.max(0, Number(sourceStats.kills || 0) + (shouldCount ? 1 : -1));
                changed = true;
            }
            const normalizedResult = setHolodeckKillMarker(logEntry.result, shouldCount);
            if (normalizedResult !== logEntry.result) {
                logEntry.result = normalizedResult;
                changed = true;
            }
            logEntry.yulongCountedKill = shouldCount;
            logEntry.yulongPreviousHp = previousHp;
            logEntry.yulongCurrentHp = currentHp;
        }
        return changed;
    };

    parser.subtractHolodeckLogEntry ??= function(ledger, logEntry) {
        if (!ledger || !logEntry) return false;
        const sourceStats = ledger.actors?.[logEntry.source];
        const targetStats = ledger.actors?.[logEntry.target];
        const damage = Number(logEntry.damageVal || 0);
        const healing = Number(logEntry.healVal || 0);
        const mitigated = Number(logEntry.yulongMitigatedAmount || 0);

        if (logEntry.type === "Damage") {
            if (sourceStats) {
                sourceStats.damageDealt = Math.max(0, Number(sourceStats.damageDealt || 0) - damage);
                const advanced = logEntry.yulongAdvancedAdjustments || {};
                if (sourceStats.advanced && Number(advanced.huntedShotDmg) > 0) {
                    sourceStats.advanced.huntedShotDmg = Math.max(0, Number(sourceStats.advanced.huntedShotDmg || 0) - Number(advanced.huntedShotDmg));
                }
                if (sourceStats.advanced && Number(advanced.surgeFriendlyDmg) > 0) {
                    sourceStats.advanced.surgeFriendlyDmg = Math.max(0, Number(sourceStats.advanced.surgeFriendlyDmg || 0) - Number(advanced.surgeFriendlyDmg));
                }
                const countedKill = logEntry.yulongCountedKill === true
                    || (logEntry.yulongCountedKill === undefined && hasHolodeckKillMarker(logEntry.result));
                if (countedKill) {
                    sourceStats.kills = Math.max(0, Number(sourceStats.kills || 0) - 1);
                }
            }
            ledger.totalDamage = Math.max(0, Number(ledger.totalDamage || 0) - damage);

            if (targetStats?.damageTakenSources?.[logEntry.source]) {
                const actionKey = this.getHolodeckActionKey(logEntry);
                const sourceMap = targetStats.damageTakenSources[logEntry.source];
                sourceMap[actionKey] = Math.max(0, Number(sourceMap[actionKey] || 0) - damage);
                if (sourceMap[actionKey] === 0) delete sourceMap[actionKey];
                if (Object.keys(sourceMap).length === 0) delete targetStats.damageTakenSources[logEntry.source];
            }
            this.addDamageTypeMap(targetStats, logEntry.yulongDamageTypeAdjustments || { applied: damage }, -1);
        } else if (logEntry.type === "Heal") {
            if (sourceStats) sourceStats.healingDealt = Math.max(0, Number(sourceStats.healingDealt || 0) - healing);
            if (targetStats?.healingReceivedSources?.[logEntry.source]) {
                const actionKey = this.getHolodeckActionKey(logEntry);
                const sourceMap = targetStats.healingReceivedSources[logEntry.source];
                sourceMap[actionKey] = Math.max(0, Number(sourceMap[actionKey] || 0) - healing);
                if (sourceMap[actionKey] === 0) delete sourceMap[actionKey];
                if (Object.keys(sourceMap).length === 0) delete targetStats.healingReceivedSources[logEntry.source];
            }
        } else if (logEntry.type === "Mitigation") {
            if (!targetStats || mitigated <= 0) return false;
        } else {
            return false;
        }

        if (targetStats && mitigated > 0) {
            targetStats.mitigated = Math.max(0, Number(targetStats.mitigated || 0) - mitigated);
            if (targetStats.mitigatedSources?.[logEntry.source] !== undefined) {
                targetStats.mitigatedSources[logEntry.source] = Math.max(0, Number(targetStats.mitigatedSources[logEntry.source] || 0) - mitigated);
                if (targetStats.mitigatedSources[logEntry.source] === 0) delete targetStats.mitigatedSources[logEntry.source];
            }
        }

        if (sourceStats?.history) {
            const index = sourceStats.history.findIndex(entry => entry.id === logEntry.id);
            if (index >= 0) sourceStats.history.splice(index, 1);
        }
        return true;
    };

    parser.revertHolodeckMessageStats ??= function(message) {
        if (!message?.id) return false;
        let reverted = false;
        const revertedKeys = new Set();
        for (const ledger of [this.ledger, this.explorationLedger].filter(Boolean)) {
            const logs = this.getYulongLedgerLogs(ledger);
            for (let index = logs.length - 1; index >= 0; index--) {
                const logEntry = logs[index];
                if (logEntry?.yulongMessageId !== message.id) continue;
                if (this.subtractHolodeckLogEntry(ledger, logEntry)) {
                    if (logEntry.yulongParseKey) revertedKeys.add(logEntry.yulongParseKey);
                    logs.splice(index, 1);
                    reverted = true;
                }
            }
            ledger.masterLog = logs;
        }
        // Take the key from the log entries: recomputing it from the live message would miss the
        // applied-damage total we only ever add to the detached parse view.
        for (const key of revertedKeys) this.yulongProcessedHolodeckMessages.delete(key);
        return reverted;
    };

    parser.getHolodeckMessageSourceActor ??= function(message) {
        if (message?.actor) return message.actor;
        const systemFlags = this.getMessageSystemFlags(message) || {};
        const originUuid = systemFlags.origin?.uuid;
        const origin = fromUuidSyncSafe(originUuid);
        return origin?.actor || origin?.parent || (origin?.documentName === "Actor" ? origin : null);
    };

    parser.recordPendingHolodeckDamageSource ??= function(event) {
        const button = event.target?.closest?.("button[data-action]");
        if (!button || button.dataset.multiplier === undefined) return;
        if (button.dataset.action === "target-shieldBlock" || button.dataset.action === "shieldBlock") return;

        const messageElement = button.closest("[data-message-id]");
        const message = messageElement ? game.messages.get(messageElement.dataset.messageId) : null;
        if (!message) return;

        const systemFlags = this.getMessageSystemFlags(message) || {};
        const context = systemFlags.context || {};
        if (!message.isDamageRoll && context.type !== "damage-roll") return;

        const targetRow = button.closest("[data-target-uuid]");
        const targetUuid = targetRow?.dataset.targetUuid || null;
        const targetDoc = fromUuidSyncSafe(targetUuid);
        const targetActor = targetDoc?.actor || targetDoc || null;
        const sourceActor = this.getHolodeckMessageSourceActor(message);
        const sourceIdentity = this.getHolodeckSourceIdentity(message, sourceActor);
        const originUuid = systemFlags.origin?.uuid || message.item?.uuid || sourceActor?.uuid || null;

        window.yulongHomebrew ??= {};
        const pendingToolbelt = window.yulongHomebrew.pendingToolbeltApplication;
        window.yulongHomebrew.pendingHolodeckDamageSource = {
            messageId: message.id,
            rollIndex: Number(targetRow?.dataset.targetRollIndex) || 0,
            applicationKey: pendingToolbelt?.messageId === message.id ? pendingToolbelt.applicationKey : null,
            sourceActorId: sourceActor?.id || null,
            sourceActorUuid: sourceActor?.uuid || null,
            sourceActorName: sourceActor?.name || null,
            sourceIdentity: this.serializeHolodeckSourceIdentity(sourceIdentity),
            originUuid,
            targetUuid,
            targetActorId: targetActor?.id || null,
            targetActorUuid: targetActor?.uuid || null,
            timestamp: Date.now()
        };
    };

    parser.applyPendingHolodeckDamageSource ??= function(message) {
        const systemFlags = this.getMessageSystemFlags(message);
        const applied = systemFlags?.appliedDamage;
        if (!systemFlags || !applied) return false;

        const compat = window.yulongHomebrew;
        const pending = compat?.pendingHolodeckDamageSource;
        if (!pending) return false;

        if (Date.now() - pending.timestamp > HOLODECK_PENDING_SOURCE_TIMEOUT_MS) {
            delete compat.pendingHolodeckDamageSource;
            return false;
        }

        const targetDoc = fromUuidSyncSafe(applied.uuid);
        const targetActor = targetDoc?.actor || targetDoc;
        const targetMatches = !pending.targetActorId && !pending.targetUuid
            || pending.targetActorId === targetActor?.id
            || pending.targetActorUuid === targetActor?.uuid
            || pending.targetUuid === targetDoc?.uuid
            || pending.targetUuid === applied.uuid;
        if (!targetMatches) return false;

        if (!systemFlags.origin?.uuid && pending.originUuid) systemFlags.origin = { uuid: pending.originUuid };
        const pendingTargetDoc = fromUuidSyncSafe(pending.targetUuid);
        if (!systemFlags.context?.target?.token && pendingTargetDoc?.documentName === "Token") {
            systemFlags.context ??= {};
            systemFlags.context.target = {
                actor: pendingTargetDoc.actor?.uuid || targetActor?.uuid || pendingTargetDoc.uuid,
                token: pendingTargetDoc.uuid
            };
        }
        if (pending.sourceIdentity) message.yulongHolodeckSourceIdentity = pending.sourceIdentity;
        if (pending.applicationKey) message.yulongToolbeltApplicationKey = pending.applicationKey;
        delete compat.pendingHolodeckDamageSource;
        return Boolean(systemFlags.origin?.uuid || message.yulongHolodeckSourceIdentity);
    };

    parser.parseMessageWithYulongCompat ??= function(original, message) {
        if (!message) return original.call(this, message);
        if (this.isAoEEasyResolveMessage(message)) return original.call(this, message);

        // Everything from here on reads and writes the detached view, never the live document.
        const view = this.createYulongParseView(message);

        this.applyPendingHolodeckDamageSource(view);
        this.applyHolodeckRollContextFallbacks(view);
        this.augmentPF2eAppliedDamage(view);
        this.recordPersistentDamageSources(view);
        if (this.parsePersistentDamageRoll(view)) return;

        const key = this.getHolodeckParseKey(view);
        if (key && this.yulongProcessedHolodeckMessages.has(key)) return;

        const { ledger, isCombatPhase } = this.getHolodeckLedger();
        const beforeLength = Array.isArray(ledger?.masterLog) ? ledger.masterLog.length : 0;
        const beforeTypes = this.snapshotDamageTakenTypes(ledger);
        const beforeMitigated = this.snapshotHolodeckMitigated(ledger);

        const result = original.call(this, view);

        const logs = Array.isArray(ledger?.masterLog) ? ledger.masterLog : [];
        const newLogs = logs.slice(beforeLength);
        if (newLogs.length > 0 && key) this.rememberYulongKey(this.yulongProcessedHolodeckMessages, key);

        const applied = this.getMessageSystemFlags(view)?.appliedDamage;
        for (const logEntry of newLogs) {
            logEntry.yulongMessageId = view.id || null;
            logEntry.yulongParseKey = key;
            if (view.toolbeltCompat?.saveKey) logEntry.yulongToolbeltSaveKey = view.toolbeltCompat.saveKey;
            if (applied?.uuid) logEntry.yulongAppliedDamageUuid = applied.uuid;
            if (Number.isFinite(Number(applied?.amount ?? applied?.damage))) {
                logEntry.yulongAppliedAmount = Number(applied.amount ?? applied.damage);
            }
        }
        // Must run before the source corrections, which move the recorded mitigation between actors.
        this.assignHolodeckMitigatedAmounts(ledger, beforeMitigated, newLogs);

        for (const logEntry of newLogs) {
            const advancedAdjustments = this.getHolodeckAdvancedAdjustments(view, ledger, logEntry);
            if (advancedAdjustments) logEntry.yulongAdvancedAdjustments = advancedAdjustments;
        }
        const correctedSourceIdentity = this.correctHolodeckSourceIdentity(view, ledger, newLogs);
        const correctedPersistentSource = this.correctPersistentDamageHolodeckSources(view, ledger, newLogs);
        const normalizedKills = this.normalizeHolodeckKillStats(view, ledger, newLogs);
        const patchedD20 = this.patchHolodeckRollD20Stats(view, ledger, newLogs);
        const normalized = this.normalizeHolodeckDamageTypes(view, ledger, beforeTypes, newLogs);
        const taggedApplication = newLogs.some(logEntry => ["Damage", "Heal", "Mitigation"].includes(logEntry.type));
        if (taggedApplication && view.yulongToolbeltApplicationKey) {
            this.rememberYulongKey(this.processedToolbeltApplications, view.yulongToolbeltApplicationKey);
            const pending = window.yulongHomebrew?.pendingToolbeltApplication;
            if (pending?.applicationKey === view.yulongToolbeltApplicationKey) this.clearPendingToolbeltApplication(pending);
        }
        if ((normalized || normalizedKills || correctedSourceIdentity || correctedPersistentSource || taggedApplication || patchedD20)
            && isCombatPhase
            && typeof this.saveLiveBackup === "function") this.saveLiveBackup();
        return result;
    };

    parser.installHolodeckParserWrapper ??= function() {
        if (this.__yulongHolodeckParserWrapped) return;
        if (typeof this.parseMessage !== "function") return;

        const original = this.parseMessage;
        const parser = this;
        this.parseMessage = function(message) {
            return parser.parseMessageWithYulongCompat.call(parser, original, message);
        };
        this.__yulongHolodeckParserWrapped = true;
    };

    parser.installYulongPrimaryGMSaveGuard ??= function() {
        if (this.__yulongPrimaryGMSaveGuardInstalled) return;
        if (typeof this.saveLiveBackup !== "function") return;

        const original = this.saveLiveBackup;
        const parser = this;
        this.saveLiveBackup = function(...args) {
            if (!parser.isYulongPrimaryGM()) return;
            return original.apply(this, args);
        };
        this.__yulongPrimaryGMSaveGuardInstalled = true;
    };

    parser.handleSecretHolodeckDamageMessage ??= function(message) {
        if (!message?.id) return;
        const isSecret = (message.whisper && message.whisper.length > 0) || message.blind;
        const isHolodeck = canvas.scene?.getFlag("pf2e-holodeck", "active");
        if (!isSecret || isHolodeck) return;
        if (!this.isHolodeckDamageApplicationMessage(message)) return;

        this.parseMessage(message);
        if (window.combatForensicsInstance?.rendered) window.combatForensicsInstance.render();
    };

    parser.handleRevertedHolodeckDamageMessage ??= function(message, changed) {
        const reverted = foundry.utils.getProperty(changed || {}, "flags.pf2e.appliedDamage.isReverted")
            ?? foundry.utils.getProperty(changed || {}, "flags.sf2e.appliedDamage.isReverted")
            ?? message?.flags?.pf2e?.appliedDamage?.isReverted
            ?? message?.flags?.sf2e?.appliedDamage?.isReverted;
        if (!reverted) return false;

        const didRevert = this.revertHolodeckMessageStats(message);
        if (didRevert && window.combatForensicsInstance?.rendered) window.combatForensicsInstance.render();
        return didRevert;
    };

    parser.isToolbeltHealing = function(message) {
        const text = `${message.flavor || ""} ${message.content || ""}`.replace(/<[^>]*>?/gm, " ");
        const healingKeywords = [
            "healing", "healed", "heal", "restored", "recovered",
            "治疗", "治療", "恢复", "恢復", "回復", "回复", "治愈", "治癒"
        ];
        return healingKeywords.some(keyword => text.toLowerCase().includes(keyword.toLowerCase()));
    };

    parser.getRecentHpComponentChange ??= function(actor, changed, path) {
        const nextValue = foundry.utils.getProperty(changed, path) ?? changed?.[path];
        if (nextValue === undefined || nextValue === null) return null;

        const previous = Number(foundry.utils.getProperty(actor, path));
        const current = Number(nextValue);
        if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;

        const delta = previous - current;
        return delta === 0 ? null : { path, previous, current, delta };
    };

    parser.pushRecentHpChange ??= function(actor, change) {
        const keys = [actor?.uuid, actor?.id].filter(Boolean);
        change.keys = keys;
        for (const key of keys) {
            const queue = this.recentHpChanges.get(key) || [];
            queue.push(change);
            this.recentHpChanges.set(key, queue.slice(-20));
        }
    };

    // Non-consuming lookup used by the applied-damage summary: the Target Helper bridge still owns
    // consumption, this only borrows the exact pre/post HP values captured in preUpdateActor.
    parser.peekRecentHpChange ??= function(actor) {
        const target = actor?.actor || actor;
        const now = Date.now();
        for (const key of [target?.uuid, target?.id].filter(Boolean)) {
            const queue = this.recentHpChanges.get(key);
            if (!Array.isArray(queue)) continue;
            // Newest first: PF2e posts the damage-taken card straight after its own update, so the
            // latest entry is the one this message describes.
            for (let index = queue.length - 1; index >= 0; index--) {
                const change = queue[index];
                if (now - change.timestamp <= TOOLBELT_HP_CHANGE_TIMEOUT_MS) return change;
            }
        }
        return null;
    };

    parser.removeRecentHpChange ??= function(change) {
        for (const key of change?.keys || []) {
            const queue = this.recentHpChanges.get(key) || [];
            const filtered = queue.filter(entry => entry.id !== change.id);
            if (filtered.length > 0) this.recentHpChanges.set(key, filtered);
            else this.recentHpChanges.delete(key);
        }
    };

    parser.recordRecentHpChange = function(actor, changed, options = {}) {
        if (!actor) return;
        const components = [
            this.getRecentHpComponentChange(actor, changed, "system.attributes.hp.value"),
            this.getRecentHpComponentChange(actor, changed, "system.attributes.hp.temp"),
            this.getRecentHpComponentChange(actor, changed, "system.attributes.hp.sp.value")
        ].filter(Boolean);

        const optionDelta = Number(options.damageTaken);
        const componentDelta = components.reduce((total, component) => total + component.delta, 0);
        const delta = Number.isFinite(optionDelta) && optionDelta !== 0 ? optionDelta : componentDelta;
        if (!Number.isFinite(delta) || delta === 0) return;

        const hpValue = components.find(component => component.path === "system.attributes.hp.value");
        const previousHp = hpValue?.previous ?? Number(actor.system?.attributes?.hp?.value);
        const currentHp = hpValue?.current ?? previousHp;

        this.pushRecentHpChange(actor, {
            id: foundry.utils.randomID(),
            delta,
            amount: Math.abs(delta),
            isHealing: delta < 0,
            previousHp,
            currentHp,
            actor,
            components,
            timestamp: Date.now()
        });
    };

    parser.consumeRecentHpChange = function(targetDoc, fallbackAmount, fallbackHealing, options = {}) {
        const actor = targetDoc?.actor || targetDoc;
        const now = Date.now();
        const keys = [actor?.uuid, actor?.id, targetDoc?.uuid, targetDoc?.id].filter(Boolean);

        for (const key of keys) {
            const queue = this.recentHpChanges.get(key);
            if (!Array.isArray(queue) || queue.length === 0) continue;

            const fresh = queue.filter(change => now - change.timestamp <= TOOLBELT_HP_CHANGE_TIMEOUT_MS);
            if (fresh.length !== queue.length) {
                if (fresh.length > 0) this.recentHpChanges.set(key, fresh);
                else this.recentHpChanges.delete(key);
            }
            const change = fresh[0];
            if (!change) continue;

            this.removeRecentHpChange(change);
            return {
                amount: Number(change.amount ?? Math.abs(change.delta)),
                isHealing: change.isHealing ?? change.delta < 0,
                previousHp: change.previousHp,
                currentHp: change.currentHp,
                targetActor: change.actor,
                components: change.components || []
            };
        }

        for (const [key, queue] of this.recentHpChanges.entries()) {
            const fresh = (Array.isArray(queue) ? queue : [queue]).filter(change => now - change.timestamp <= TOOLBELT_HP_CHANGE_TIMEOUT_MS);
            if (fresh.length > 0) this.recentHpChanges.set(key, fresh);
            else this.recentHpChanges.delete(key);
        }

        if (options.requireRecent) return null;
        return { amount: fallbackAmount, isHealing: fallbackHealing };
    };

    parser.getAchievementsApi ??= function() {
        if (!game.modules.get("achievements-with-automation")?.active) return null;
        return window.AchievementsAPI || null;
    };

    parser.isAchievementsTrackingEnabled ??= function() {
        try {
            return game.settings.get("achievements-with-automation", "trackingEnabled") !== false;
        } catch {
            return true;
        }
    };

    parser.getToolbeltSourceActor ??= function(message, data) {
        if (message.actor) return message.actor;

        const systemFlags = message.flags?.pf2e || message.flags?.sf2e || {};
        const originUuid = systemFlags.origin?.uuid || data?.author || data?.item;
        const origin = fromUuidSyncSafe(originUuid);
        return origin?.actor || origin || null;
    };

    parser.isAwaNativeAttributionAlreadyCorrect ??= function(sourceActor) {
        if (!game.combat?.active || !sourceActor) return false;
        const combatant = game.combat.combatant;
        return combatant?.actorId === sourceActor.id || combatant?.actor?.id === sourceActor.id;
    };

    parser.recordPendingAwaToolbeltSource ??= function(event) {
        const button = event.target?.closest?.("button[data-action]");
        const action = button?.dataset.action || "";
        if (!action.startsWith("target-")) return;
        if (action === "target-shieldBlock") return;
        if (button.dataset.multiplier === undefined) return;

        const targetRow = button.closest("[data-target-uuid]");
        const messageElement = button.closest("[data-message-id]");
        if (!targetRow || !messageElement) return;

        const message = game.messages.get(messageElement.dataset.messageId);
        if (!message) return;

        const data = this.getToolbeltData(message);
        if (!data) return;

        const rollIndex = Number(targetRow.dataset.targetRollIndex) || 0;
        const targetUuid = targetRow.dataset.targetUuid;
        const targetDoc = fromUuidSyncSafe(targetUuid);
        const targetActor = targetDoc?.actor || targetDoc;
        const targetId = targetDoc?.id || this.getDocumentIdFromUuid(targetUuid) || targetRow.dataset.targetUuid;
        const applicationKey = this.getToolbeltApplicationKey(message.id, targetId, rollIndex);
        const applicationLooseKey = this.getToolbeltApplicationLooseKey(message.id, rollIndex);

        window.yulongHomebrew.pendingToolbeltApplication = {
            applicationKey,
            applicationLooseKey,
            messageId: message.id,
            rollIndex,
            targetId,
            targetUuid,
            targetActorId: targetActor?.id,
            targetActorUuid: targetActor?.uuid,
            timestamp: Date.now()
        };

        const sourceActor = this.getToolbeltSourceActor(message, data);
        if (!sourceActor) return;

        window.yulongHomebrew.pendingAwaToolbeltSource = {
            applicationKey,
            applicationLooseKey,
            messageId: message.id,
            rollIndex,
            sourceActor,
            sourceActorId: sourceActor.id,
            targetActor,
            targetActorId: targetActor?.id,
            targetUuid,
            timestamp: Date.now()
        };
    };

    parser.recordPendingAwaPF2eDamageSource ??= function(event) {
        const button = event.target?.closest?.("button[data-action]");
        if (!button || button.dataset.multiplier === undefined) return;
        if (button.dataset.action === "target-shieldBlock" || button.dataset.action === "shieldBlock") return;

        const messageElement = button.closest("[data-message-id]");
        const message = messageElement ? game.messages.get(messageElement.dataset.messageId) : null;
        if (!message || this.getToolbeltData(message)) return;

        const systemFlags = this.getMessageSystemFlags(message) || {};
        const context = systemFlags.context || {};
        if (!message.isDamageRoll && context.type !== "damage-roll") return;

        const targetRow = button.closest("[data-target-uuid]");
        const targetUuid = targetRow?.dataset.targetUuid || null;
        const targetDoc = fromUuidSyncSafe(targetUuid);
        const targetActor = targetDoc?.actor || targetDoc || null;
        const messageItem = message.item || fromUuidSyncSafe(this.getMessageSystemFlags(message)?.origin?.uuid);
        const sourceActor = isPersistentDamageItem(messageItem)
            ? this.getPersistentDamageSourceActor(messageItem)
            : this.getHolodeckMessageSourceActor(message);

        recordPendingAwaPF2eDamageSourceContext({
            sourceActor,
            targetActor,
            targetUuid,
            item: messageItem,
            messageId: message.id,
            reason: "pf2e-damage-button"
        });
    };

    parser.pendingAwaSourceMatchesActor ??= function(pending, actor) {
        if (!pending || !actor) return false;
        return pending.targetActorId === actor.id
            || pending.targetActorUuid === actor.uuid
            || pending.targetUuid === actor.uuid
            || pending.targetUuid === actor.token?.uuid;
    };

    parser.consumePendingAwaToolbeltSource ??= function(actor) {
        const compat = window.yulongHomebrew;
        const pending = compat?.pendingAwaToolbeltSource;
        if (!pending) return null;

        if (Date.now() - pending.timestamp > AWA_PENDING_TIMEOUT_MS) {
            delete compat.pendingAwaToolbeltSource;
            return null;
        }

        if (!this.pendingAwaSourceMatchesActor(pending, actor)) return null;

        this.rememberYulongKey(compat.awaHandledApplications, pending.applicationKey);
        this.rememberYulongKey(compat.awaHandledApplicationLooseKeys, pending.applicationLooseKey);
        delete compat.pendingAwaToolbeltSource;
        return {
            ...pending,
            sourceActor: pending.sourceActor || game.actors.get(pending.sourceActorId) || fromUuidSyncSafe(pending.sourceActorUuid)
        };
    };

    parser.consumePendingAwaPF2eDamageSource ??= function(actor) {
        const compat = window.yulongHomebrew;
        const pending = compat?.pendingAwaPF2eDamageSource;
        if (!pending) return null;

        if (Date.now() - pending.timestamp > AWA_PF2E_PENDING_SOURCE_TIMEOUT_MS) {
            delete compat.pendingAwaPF2eDamageSource;
            return null;
        }

        if (!this.pendingAwaSourceMatchesActor(pending, actor)) return null;

        delete compat.pendingAwaPF2eDamageSource;
        return {
            ...pending,
            sourceActor: pending.sourceActor || game.actors.get(pending.sourceActorId) || fromUuidSyncSafe(pending.sourceActorUuid)
        };
    };

    parser.getAwaDamageSourceContext ??= function(actor) {
        return this.consumePendingAwaToolbeltSource(actor)
            || this.consumePendingAwaPF2eDamageSource(actor);
    };

    parser.getToolbeltCompatDamageActor ??= function(actor) {
        return this.consumePendingAwaToolbeltSource(actor)?.sourceActor || null;
    };

    parser.getAwaUpdatedHpValue ??= function(actor, changed) {
        const nextHp = foundry.utils.getProperty(changed || {}, "system.attributes.hp.value")
            ?? changed?.["system.attributes.hp.value"];
        const value = Number(nextHp);
        if (Number.isFinite(value)) return value;
        const current = Number(actor?.system?.attributes?.hp?.value);
        return Number.isFinite(current) ? current : null;
    };

    // `hitPoints` must be captured synchronously by the caller, while preUpdateActor is still on
    // the stack. Reading the actor here would be too late: granting the damage achievements above
    // awaits actor.update(), by which point the HP change has already landed and the
    // before/after comparison can no longer see the defeat transition.
    parser.applyAwaDamageHealingStats ??= async function(api, sourceActor, targetActor, damageDelta, hitPoints = {}) {
        const amount = Math.abs(Number(damageDelta));
        if (!Number.isFinite(amount) || amount <= 0) return;

        if (damageDelta < 0) {
            if (api.triggerProgressAchievements) await api.triggerProgressAchievements("healing_progressable", sourceActor, amount);
            await this.applyOneTimeAchievementHooks(api, sourceActor, "healing_one_time", amount);
            return;
        }

        if (targetActor.type !== "npc") return;

        if (api.triggerProgressAchievements) await api.triggerProgressAchievements("damage_progressable", sourceActor, amount);
        await this.applyOneTimeAchievementHooks(api, sourceActor, "damage_one_time", amount);

        if (isHpDefeatTransition({
            previousHp: hitPoints.previousHp,
            currentHp: hitPoints.currentHp,
            amount,
            isHealing: false
        })) {
            await this.applyMonsterKilledAchievementHooks(api, sourceActor, targetActor);
        }
    };

    parser.matchesAchievementMonsterFilter ??= function(achievement, killedActor) {
        const hookId = achievement.automationHookId || "";
        if (!hookId.startsWith("monster_killed")) return false;
        if (hookId.includes("_any")) return true;

        const filter = String(achievement.monsterFilter || "").trim().toLowerCase();
        if (!filter) return false;

        if (hookId.includes("_name")) return killedActor.name?.toLowerCase() === filter;
        if (hookId.includes("_type")) {
            const traits = killedActor.system?.traits?.value || [];
            return traits.join(" ").toLowerCase().includes(filter);
        }

        return false;
    };

    parser.applyOneTimeAchievementHooks ??= async function(api, sourceActor, hookId, amount) {
        const achievements = api.getAchievements?.() || [];
        for (const achievement of achievements) {
            if (achievement.automationHookId !== hookId) continue;
            if (sourceActor.getFlag(AWA_MODULE_ID, achievement.id) === undefined) continue;
            if (sourceActor.getFlag(AWA_MODULE_ID, achievement.id)) continue;
            if (amount < Number(achievement.target || 0)) continue;
            // AWA pins the progress flag to the target on completion; do the same so the bar in
            // its UI does not sit at zero for a completed one-time achievement.
            await setAwaProgressFlag(sourceActor, achievement.flag, Number(achievement.target || amount));
            await api.grantAchievement(achievement.id, sourceActor);
        }
    };

    parser.applyMonsterKilledAchievementHooks ??= async function(api, sourceActor, killedActor) {
        if (!killedActor || killedActor.type !== "npc") return;
        const achievements = api.getAchievements?.() || [];

        for (const achievement of achievements) {
            if (!this.matchesAchievementMonsterFilter(achievement, killedActor)) continue;
            if (sourceActor.getFlag(AWA_MODULE_ID, achievement.id) === undefined) continue;
            if (sourceActor.getFlag(AWA_MODULE_ID, achievement.id)) continue;

            if (!achievement.progressable) {
                await api.grantAchievement(achievement.id, sourceActor);
                continue;
            }

            const flag = achievement.flag;
            const current = Number(sourceActor.getFlag(AWA_MODULE_ID, flag) || 0) + 1;
            if (current >= Number(achievement.target || 0)) {
                await setAwaProgressFlag(sourceActor, flag, Number(achievement.target || current));
                await api.grantAchievement(achievement.id, sourceActor);
            } else {
                await setAwaProgressFlag(sourceActor, flag, current);
            }
        }
    };

    // Split out of handleAwaPF2eActorUpdate so the decision - including consuming the pending
    // source and snapshotting HP - happens synchronously inside preUpdateActor. Returning null
    // means "not ours": Achievements With Automation's own handler must still run.
    parser.getAwaActorUpdatePlan ??= function(actor, changed, options = {}) {
        const api = this.getAchievementsApi();
        if (!api) return null;
        if (!this.isAchievementsTrackingEnabled()) return null;

        const damageDelta = Number(options.damageTaken);
        if (!Number.isFinite(damageDelta) || damageDelta === 0) return null;
        if (options.damageUndo) return { handled: true };

        const context = this.getAwaDamageSourceContext(actor);
        const sourceActor = context?.sourceActor;
        // We could not work out who dealt this. Falling through to AWA's own attribution (the
        // active combatant) is imprecise, but silently dropping the achievement is worse - and it
        // is what happened whenever the pending-source tracking missed, or libWrapper was absent
        // and the applyDamage wrapper never got installed.
        if (!sourceActor?.getFlag) return null;
        // A resolved but ineligible source (an NPC, say) is still a deliberate suppression: AWA
        // would otherwise hand the credit to whoever's turn it happens to be.
        if (!canReceiveAwaCredit(sourceActor)) return { handled: true };

        return {
            handled: true,
            api,
            sourceActor,
            damageDelta,
            hitPoints: {
                previousHp: Number(actor?.system?.attributes?.hp?.value),
                currentHp: this.getAwaUpdatedHpValue(actor, changed)
            }
        };
    };

    parser.runAwaActorUpdatePlan ??= function(plan, actor) {
        if (!plan?.api) return;
        void this.applyAwaDamageHealingStats(plan.api, plan.sourceActor, actor, plan.damageDelta, plan.hitPoints)
            .catch(error => console.warn("Yulong Homebrew | Failed to apply damage achievements.", error));
    };

    parser.handleAwaPF2eActorUpdate ??= async function(actor, changed, options = {}) {
        const plan = this.getAwaActorUpdatePlan(actor, changed, options);
        if (!plan) return false;
        if (plan.api) {
            await this.applyAwaDamageHealingStats(plan.api, plan.sourceActor, actor, plan.damageDelta, plan.hitPoints);
        }
        return true;
    };

    // Identified by source text because Foundry's hook registry does not record which module
    // registered a handler. `updateQueue` is the distinctive token and stays mandatory; the second
    // marker may be either of the remaining two so a light refactor upstream does not break us.
    // A miss is now reported instead of silently disabling the whole attribution fix.
    parser.isAwaActorUpdateHook ??= function(hook) {
        const fn = hook?.fn || hook;
        if (typeof fn !== "function" || fn.__yulongHomebrewWrapped) return false;

        let source = "";
        try {
            source = Function.prototype.toString.call(fn);
        } catch {
            return false;
        }
        if (!source.includes("updateQueue")) return false;
        return source.includes("processQueue") || source.includes("trackingEnabled");
    };

    parser.wrapAwaActorUpdateHook ??= function(hook) {
        const original = hook?.fn;
        if (typeof original !== "function" || original.__yulongHomebrewWrapped) return false;

        const parser = this;
        // Deliberately not async: the original handler must be reached in the same tick that
        // preUpdateActor fires, so AWA still queues the update against the pre-update actor state.
        const wrapped = function(actor, data, options, userId) {
            let plan = null;
            try {
                plan = parser.getAwaActorUpdatePlan(actor, data || {}, options || {});
            } catch (error) {
                console.warn("Yulong Homebrew | Failed to resolve the achievement damage source.", error);
            }
            if (!plan) return original.call(this, actor, data, options, userId);
            parser.runAwaActorUpdatePlan(plan, actor);
            return undefined;
        };
        wrapped.__yulongHomebrewWrapped = true;

        hook.fn = wrapped;
        return true;
    };

    parser.installAchievementsCompat ??= function() {
        if (!game.modules.get(AWA_MODULE_ID)?.active) return;
        if (this.__achievementsCompatInstalled) return;

        const actorHooks = Hooks.events?.preUpdateActor || Hooks._hooks?.preUpdateActor || [];
        const awaHook = actorHooks.find(hook => this.isAwaActorUpdateHook(hook));
        if (!awaHook) {
            console.warn("Yulong Homebrew | Could not find the Achievements With Automation preUpdateActor handler; damage attribution will fall back to its default (the active combatant).");
            return;
        }

        this.__achievementsCompatInstalled = this.wrapAwaActorUpdateHook(awaHook);
        if (!this.__achievementsCompatInstalled) {
            console.warn("Yulong Homebrew | Found the Achievements With Automation preUpdateActor handler but could not wrap it.");
        }
    };

    // Runs only on the client that actually applied the damage: its caller needs a matching
    // recent HP change, which preUpdateActor only records there. Requiring the primary GM on top
    // of that made the two conditions mutually exclusive whenever a player applied the damage, so
    // this branch never fired for them. The dedupe below is what keeps it single-shot.
    parser.applyAchievementsForToolbeltApplication ??= async function(message, data, entry, syntheticMessage) {
        const api = this.getAchievementsApi();
        if (!api) return;
        if (!this.isAchievementsTrackingEnabled()) return;

        const achievementKey = this.getToolbeltApplicationKey(message.id, entry.targetId, entry.rollIndex);
        const achievementLooseKey = this.getToolbeltApplicationLooseKey(message.id, entry.rollIndex);
        if (this.processedAchievementApplications.has(achievementKey)) return;
        if (this.awaHandledApplications.has(achievementKey)) return;
        if (this.awaHandledApplicationLooseKeys.has(achievementLooseKey)) return;

        const sourceActor = this.getToolbeltSourceActor(message, data);
        if (!sourceActor?.getFlag) return;

        if (this.isAwaNativeAttributionAlreadyCorrect(sourceActor)) return;

        const systemFlags = syntheticMessage.flags?.pf2e || syntheticMessage.flags?.sf2e || {};
        const appliedDamage = systemFlags.appliedDamage || {};
        const amount = Number(appliedDamage.amount ?? appliedDamage.damage ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) return;

        this.rememberYulongKey(this.processedAchievementApplications, achievementKey);

        if (appliedDamage.isHealing) {
            if (api.triggerProgressAchievements) await api.triggerProgressAchievements("healing_progressable", sourceActor, amount);
            await this.applyOneTimeAchievementHooks(api, sourceActor, "healing_one_time", amount);
            return;
        }

        if (api.triggerProgressAchievements) await api.triggerProgressAchievements("damage_progressable", sourceActor, amount);
        await this.applyOneTimeAchievementHooks(api, sourceActor, "damage_one_time", amount);

        const targetActor = syntheticMessage.toolbeltCompat?.targetActor;
        const killedActor = targetActor || this.getToolbeltTargetDocument(entry.targetId, [...(data.targets || []), ...(data.splashTargets || [])])?.actor;
        const previousHp = Number(appliedDamage.previousHp);
        const currentHp = Number(appliedDamage.currentHp);
        if (isHpDefeatTransition({ previousHp, currentHp, amount, isHealing: false })) {
            await this.applyMonsterKilledAchievementHooks(api, sourceActor, killedActor);
        }
    };

    // ChatMessage#user was removed in Foundry V13; the author is now a DocumentAuthorField.
    parser.getAwaMessageUser ??= function(message) {
        const author = message?.author;
        if (author && typeof author === "object") return author;
        const userId = author ?? message?.user?.id ?? message?.user;
        return typeof userId === "string" ? game.users.get(userId) : null;
    };

    // Achievements With Automation's own createChatMessage handlers bail on `game.user.isGM` and
    // require `actor.isOwner`, so they run on any connected non-GM owner's client. Foundry
    // broadcasts chat messages to every client (whisper only affects rendering), so whether the
    // message was whispered does not change this - only whether such a client is connected.
    parser.hasAwaNativeOwnerHandler ??= function(actor) {
        if (typeof actor?.testUserPermission !== "function") return false;
        const users = game.users?.contents ?? game.users ?? [];
        for (const user of users) {
            if (user.isGM || !user.active) continue;
            if (actor.testUserPermission(user, "OWNER")) return true;
        }
        return false;
    };

    // Our supplements always run on exactly one client, the primary GM, and only for the cases
    // Achievements With Automation will not cover itself. `nativeHandles` says whether AWA's
    // native path applies to this kind of message at all.
    parser.shouldHandleAwaPF2eChat ??= function(actor, nativeHandles) {
        if (!this.isYulongPrimaryGM()) return false;
        return !nativeHandles || !this.hasAwaNativeOwnerHandler(actor);
    };

    parser.getAwaPF2eChatActor ??= function(message) {
        const actor = getActorFromMessageSpeaker(message);
        return canReceiveAwaCredit(actor) ? actor : null;
    };

    parser.getAwaPF2eChatKey ??= function(message, scope) {
        return `${message?.id || foundry.utils.randomID()}:${scope}`;
    };

    parser.markAwaPF2eChatProcessed ??= function(message, scope) {
        const key = this.getAwaPF2eChatKey(message, scope);
        if (this.processedAwaPF2eChatMessages.has(key)) return false;
        this.rememberYulongKey(this.processedAwaPF2eChatMessages, key);
        return true;
    };

    parser.nativeAwaCanDetectHealingConsumable ??= function(message) {
        if (message?.flags?.pf2e?.origin?.type !== "consumable") return false;
        const text = (message.rolls || []).flatMap(roll => roll.terms || [])
            .flatMap(term => term.terms || [])
            .join(" ")
            .toLowerCase();
        return text.includes("healing");
    };

    parser.applyAwaPF2eThrowAchievements ??= async function(message) {
        const api = this.getAchievementsApi();
        if (!api || !this.isAchievementsTrackingEnabled()) return false;

        const context = message.flags?.pf2e?.context || {};
        const type = context.type;
        const category = type === "attack-roll" || type === "spell-attack-roll"
            ? "attack"
            : type === "saving-throw"
                ? "save"
                : ["skill-check", "perception-check"].includes(type)
                    ? "check"
                    : null;
        if (!category) return false;

        const actor = this.getAwaPF2eChatActor(message);
        if (!actor) return false;

        // AWA's checkThrowPF only looks at these three context types, so spell attack rolls and
        // perception checks are ours to cover regardless of who else is connected.
        const nativeHandles = AWA_NATIVE_PF2E_THROW_TYPES.has(type);
        if (!this.shouldHandleAwaPF2eChat(actor, nativeHandles)) return false;
        if (!this.markAwaPF2eChatProcessed(message, "throw")) return false;

        const d20Results = getPF2eMessageD20Results(message);
        if (!d20Results.length) return false;

        const statistic = getPF2eMessageStatistic(message);
        const achievements = api.getAchievements?.() || [];
        for (const natural of [20, 1]) {
            if (!d20Results.includes(natural)) continue;
            const baseHook = `${category}_nat_${natural}`;
            for (const achievement of achievements) {
                const hookId = achievement.automationHookId || "";
                const matches = category === "attack"
                    ? hookId === baseHook || achievementHookMatchesStatistic(hookId, baseHook, statistic)
                    : achievementHookMatchesStatistic(hookId, baseHook, statistic);
                if (matches) await advanceAwaCounterAchievement(api, actor, achievement, 1);
            }
        }

        if (category === "check") {
            const total = Number(message.rolls?.[0]?.total ?? 0);
            if (Number.isFinite(total)) {
                for (const achievement of achievements) {
                    const hookId = achievement.automationHookId || "";
                    if (!achievementHookMatchesStatistic(hookId, "check_score", statistic)) continue;
                    if (total < Number(achievement.scoreThreshold || 0)) continue;
                    await advanceAwaCounterAchievement(api, actor, achievement, 1);
                }
            }
        }

        return true;
    };

    parser.awaNativeHandlesConsumable ??= function(message, actor) {
        return this.nativeAwaCanDetectHealingConsumable(message) && this.hasAwaNativeOwnerHandler(actor);
    };

    // AWA's checkItemUsedPF returns early whenever the message carries a pf2e context type, so
    // context-bearing item cards are always ours.
    parser.awaNativeHandlesItemUse ??= function(message, actor) {
        const hasContext = Boolean(message?.flags?.pf2e?.context?.type);
        return !hasContext && this.hasAwaNativeOwnerHandler(actor);
    };

    parser.applyAwaPF2eItemAchievements ??= async function(message) {
        const api = this.getAchievementsApi();
        if (!api || !this.isAchievementsTrackingEnabled()) return false;

        const actor = this.getAwaPF2eChatActor(message);
        if (!actor) return false;

        const handleConsumable = this.shouldHandleAwaPF2eChat(actor, this.awaNativeHandlesConsumable(message, actor));
        const handleItemUse = this.shouldHandleAwaPF2eChat(actor, this.awaNativeHandlesItemUse(message, actor));
        if (!handleConsumable && !handleItemUse) return false;

        const item = await resolvePF2eMessageItem(message);
        if (!item) return false;

        const achievements = api.getAchievements?.() || [];
        let handled = false;

        if (handleConsumable
            && isPF2eHealingConsumableMessage(message, item)
            && this.markAwaPF2eChatProcessed(message, "consumable")) {
            for (const achievement of achievements.filter(achievement => achievement.automationHookId === "consumables")) {
                await advanceAwaCounterAchievement(api, actor, achievement, 1);
                handled = true;
            }
        }

        if (handleItemUse && this.markAwaPF2eChatProcessed(message, "item-used")) {
            const itemName = String(item.name || "").toLowerCase();
            for (const achievement of achievements.filter(achievement => achievement.automationHookId === "item_used_name")) {
                const filter = String(achievement.itemFilter || "").trim().toLowerCase();
                if (!filter || !itemName.includes(filter)) continue;
                await advanceAwaCounterAchievement(api, actor, achievement, 1);
                handled = true;
            }
        }

        return handled;
    };

    parser.handleAwaPF2eChatMessage ??= async function(message) {
        if (game.system.id !== "pf2e") return false;
        if (message.flags?.[AWA_MODULE_ID]?.["achievement-message"]) return false;
        const handledThrow = await this.applyAwaPF2eThrowAchievements(message);
        const handledItem = await this.applyAwaPF2eItemAchievements(message);
        return handledThrow || handledItem;
    };

    parser.buildToolbeltSaveMessage ??= function(message, data, entry) {
        const targets = [...(data.targets || []), ...(data.splashTargets || [])];
        const targetDoc = this.getToolbeltTargetDocument(entry.targetId, targets);
        const targetActor = targetDoc?.actor || (targetDoc?.system ? targetDoc : null);
        if (!targetActor) return null;

        const save = typeof entry.save === "object" && entry.save !== null ? entry.save : {};
        // Target Helper records the reroll kind ("hero" | "mythic" | "new" | "lower" | "higher").
        // Holodeck treats context.isReroll as a hero point spend, so only forward it for the one
        // kind that actually is one; the rest still count as rerolls for our own dedupe.
        const rerollType = typeof save.rerolled === "string"
            ? save.rerolled
            : (save.rerolled || save.isReroll ? "new" : null);
        const isReroll = Boolean(rerollType);
        const isHeroPointReroll = rerollType === "hero";
        const targetName = this.getHolodeckResolvedActorName(targetActor, targetDoc.name || targetActor.name);
        if (!isReroll && this.hasRecentHolodeckSaveLog(targetName, entry.outcome)) return null;

        const systemKey = message.flags?.sf2e ? "sf2e" : "pf2e";
        const systemFlags = foundry.utils.deepClone(message.flags?.[systemKey] || {});
        const dcSnapshot = this.getToolbeltDCSnapshot(data, entry.variantId);
        const statistic = save.statistic || entry.variant?.statistic || dcSnapshot?.statistic;
        const contextOptions = Array.isArray(data.options)
            ? data.options
            : Array.isArray(systemFlags.context?.options)
                ? systemFlags.context.options
                : [];
        const context = foundry.utils.mergeObject(systemFlags.context || {}, {
            type: "saving-throw",
            target: { actor: targetActor.uuid, token: targetDoc.uuid || targetActor.uuid },
            outcome: entry.outcome,
            unadjustedOutcome: this.normalizePF2eOutcome(save.unadjustedOutcome) || entry.outcome,
            isReroll: isHeroPointReroll,
            options: contextOptions
        }, { inplace: false });
        if (statistic) context.statistic = statistic;
        if (dcSnapshot && context.dc == null) context.dc = dcSnapshot;
        systemFlags.context = context;

        const flags = foundry.utils.deepClone(message.flags || {});
        flags[systemKey] = systemFlags;

        const saveLabel = statistic ? `${statistic} save` : "Saving Throw";
        const saveFingerprint = this.getToolbeltSaveEntryFingerprint(entry);
        const rolls = this.getToolbeltSaveRolls(entry, contextOptions);
        return {
            id: `${message.id}-toolbelt-save-${entry.variantId}-${entry.targetId}-${saveFingerprint}`,
            actor: targetActor,
            speaker: foundry.utils.mergeObject(message.speaker || {}, { alias: targetDoc.name || targetActor.name }, { inplace: false }),
            alias: targetDoc.name || targetActor.name,
            item: message.item,
            rolls,
            flavor: message.flavor || `<h4>${saveLabel}</h4>`,
            content: `<span>${saveLabel}: ${entry.outcome}</span>`,
            flags,
            toolbeltCompat: {
                saveKey: this.getToolbeltSaveKey(message.id, entry),
                rerollType,
                targetActor
            },
            isDamageRoll: false
        };
    };

    parser.parseToolbeltSaveVariants ??= function(message, changed) {
        const data = this.getToolbeltData(message);
        if (!data?.saveVariants) return false;

        const entries = this.getToolbeltSaveEntries(data, changed);
        let parsed = false;

        for (const entry of entries) {
            const key = this.getToolbeltSaveKey(message.id, entry);
            if (this.hasProcessedToolbeltSaveEntry(key)) continue;

            const syntheticMessage = this.buildToolbeltSaveMessage(message, data, entry);
            if (!syntheticMessage) continue;

            this.rememberYulongKey(this.processedToolbeltSaveEntries, key);
            this.parseMessage(syntheticMessage);
            parsed = true;
        }

        return parsed;
    };

    parser.buildToolbeltApplicationMessage = function(message, data, entry) {
        const targets = [...(data.targets || []), ...(data.splashTargets || [])];
        const targetDoc = this.getToolbeltTargetDocument(entry.targetId, targets);
        if (!targetDoc) return null;

        const roll = message.rolls?.[entry.rollIndex] || message.rolls?.[0];
        const fallbackAmount = Number(roll?.total ?? 0);
        const fallbackHealing = this.isToolbeltHealing(message);
        const appliedChange = this.consumeRecentHpChange(targetDoc, fallbackAmount, fallbackHealing, { requireRecent: true });
        if (!appliedChange) return null;

        const amount = appliedChange.amount;
        if (!Number.isFinite(amount)) return null;

        const systemKey = message.flags?.sf2e ? "sf2e" : "pf2e";
        const systemFlags = foundry.utils.deepClone(message.flags?.[systemKey] || {});
        const originUuid = systemFlags.origin?.uuid || data.author || data.item || message.item?.uuid || message.actor?.uuid;
        const sourceActor = this.getToolbeltSourceActor(message, data);
        const sourceIdentity = this.getHolodeckSourceIdentity(message, sourceActor);

        systemFlags.context = foundry.utils.mergeObject(systemFlags.context || {}, {
            type: "damage-taken",
            target: { token: targetDoc.uuid },
            options: data.options || systemFlags.context?.options || []
        }, { inplace: false });
        const dcSnapshot = this.getToolbeltDCSnapshot(data);
        if (dcSnapshot && systemFlags.context.dc == null) systemFlags.context.dc = dcSnapshot;
        systemFlags.appliedDamage = {
            uuid: targetDoc.uuid,
            damage: amount,
            amount,
            isHealing: appliedChange.isHealing,
            previousHp: appliedChange.previousHp,
            currentHp: appliedChange.currentHp
        };
        if (originUuid) systemFlags.origin = { uuid: originUuid };

        const flags = foundry.utils.deepClone(message.flags || {});
        flags[systemKey] = systemFlags;
        const applicationText = appliedChange.isHealing ? "Healing Applied" : "Damage Taken";
        const targetActor = appliedChange.targetActor || targetDoc.actor || (targetDoc.system ? targetDoc : null);

        return {
            id: this.getToolbeltApplicationMessageId(message.id, entry),
            actor: targetActor || message.actor,
            speaker: foundry.utils.mergeObject(message.speaker || {}, { alias: targetDoc.name || message.speaker?.alias }, { inplace: false }),
            alias: targetDoc.name || message.alias,
            item: message.item,
            rolls: roll ? [roll] : message.rolls,
            flavor: message.flavor,
            content: `${message.content || ""} <span>${applicationText} ${amount}</span>`,
            flags,
            toolbeltCompat: {
                targetActor,
                sourceIdentity: this.serializeHolodeckSourceIdentity(sourceIdentity)
            },
            // These HP values come straight out of the preUpdateActor record, so kill
            // normalisation may act on them in both directions.
            yulongHpSnapshotTrusted: true,
            isDamageRoll: false
        };
    };

    parser.parseToolbeltApplications = function(message, changed) {
        if (!this.hasToolbeltAppliedUpdate(changed)) return false;
        const data = this.getToolbeltData(message);
        if (!data?.applied) return false;

        // Target Helper rewrites its whole flag on every change, so `changed` lists every
        // application ever made on this message, not just the new one. What actually keeps this
        // single-shot is hasProcessedToolbeltApplication plus buildToolbeltApplicationMessage
        // requiring a matching recent HP change.
        const pending = this.getPendingToolbeltApplication(message.id);
        const changedEntries = this.getChangedToolbeltApplicationEntries(changed);
        const entries = changedEntries.length > 0 ? changedEntries : this.getToolbeltApplicationEntries(data);
        const candidateEntries = pending
            ? entries.filter(entry => this.isPendingToolbeltEntry(pending, entry, data))
            : entries;

        let parsed = false;
        for (const entry of candidateEntries) {
            const key = this.getToolbeltApplicationKey(message.id, entry.targetId, entry.rollIndex);
            const holodeckHandled = this.hasProcessedToolbeltApplication(message, entry);

            const syntheticMessage = this.buildToolbeltApplicationMessage(message, data, entry);
            if (!syntheticMessage) continue;

            if (!holodeckHandled) {
                this.rememberYulongKey(this.processedToolbeltApplications, key);
                this.parseMessage(syntheticMessage);
                parsed = true;
            }
            void this.applyAchievementsForToolbeltApplication(message, data, entry, syntheticMessage)
                .catch(error => console.warn("Yulong Homebrew | Failed to forward Toolbelt application to Achievements With Automation.", error));
        }
        if (parsed && pending) this.clearPendingToolbeltApplication(pending);
        return parsed;
    };

    parser.installHolodeckParserWrapper();
    parser.installYulongPrimaryGMSaveGuard();

    // The registry lives on window.yulongHomebrew rather than on the parser so it survives the
    // CombatParser object being replaced. It used to work by searching registered handlers for
    // one of our identifiers, which would silently re-register every hook (doubling all stats)
    // the moment this file was bundled or minified.
    const registeredHooks = window.yulongHomebrew.registeredHooks ??= {};
    const registerHookOnce = (event, id, callback) => {
        const key = `${event}:${id}`;
        if (registeredHooks[key] !== undefined) return;
        registeredHooks[key] = Hooks.on(event, callback);
    };

    registerHookOnce("createChatMessage", "secretHolodeckDamage", message => {
        parser.handleSecretHolodeckDamageMessage(message);
    });

    registerHookOnce("createChatMessage", "awaPF2eChat", message => {
        void parser.handleAwaPF2eChatMessage(message)
            .catch(error => console.warn("Yulong Homebrew | Failed to apply PF2e chat achievement compatibility.", error));
    });

    registerHookOnce("updateChatMessage", "toolbeltApplications", async (message, changed) => {
        if (!message || !message.id) return;
        const isSecret = (message.whisper && message.whisper.length > 0) || message.blind;
        const isHolodeck = canvas.scene?.getFlag("pf2e-holodeck", "active");
        if (isSecret && !isHolodeck) return;

        const parsedSaves = parser.parseToolbeltSaveVariants(message, changed);
        const parsedApplications = await parser.parseToolbeltApplications(message, changed);
        const parsed = parsedSaves || parsedApplications;
        if (!parsed) return;

        if (window.combatForensicsInstance?.rendered) window.combatForensicsInstance.render();
    });

    registerHookOnce("updateChatMessage", "revertedHolodeckDamage", (message, changed) => {
        parser.handleRevertedHolodeckDamageMessage(message, changed);
    });

    registerHookOnce("preUpdateActor", "recordRecentHpChange", (actor, changed, options = {}) => {
        if (!actor) return;
        parser.recordRecentHpChange(actor, changed, options);
    });

    if (!window.yulongHomebrew.__yulongPendingSourceClickListenerInstalled) {
        window.yulongHomebrew.__yulongPendingSourceClickListenerInstalled = true;
        // Capture phase: Target Helper's own row handlers call stopPropagation, so a bubbling
        // listener would never see the click.
        document.body.addEventListener("click", event => {
            parser.recordPendingAwaToolbeltSource(event);
            parser.recordPendingAwaPF2eDamageSource(event);
            parser.recordPendingHolodeckDamageSource(event);
        }, true);
    }

    parser.installAchievementsCompat();
}

Hooks.once("init", registerHomebrewSettings);
Hooks.once("ready", () => {
    installFumbleSwitchWidgetCompat();
    installPF2eHudDiscreteHealthColors();
    installTroopDamageHouseRules();
    installToolbeltCompat();
    setTimeout(installPatreonLowHpIncapacitation, 0);
});
