import { ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, REST, Routes, StringSelectMenuBuilder, } from 'discord.js';
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
if (!TOKEN || !CLIENT_ID)
    throw new Error('Missing DISCORD_TOKEN or CLIENT_ID');
const API_BASE = 'https://api.tcgdex.net/v2';
const LANGUAGE_LABELS = {
    en: 'English',
    'zh-tw': 'Chinese',
    ja: 'Japanese',
};
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tcgdex(lang, path) {
    const url = `${API_BASE}/${lang}/${path.replace(/^\//, '')}`;
    for (let attempt = 0; attempt < 4; attempt++) {
        const response = await fetch(url, { headers: { 'User-Agent': 'PokeMarket-QuickSet/1.0' } });
        if (response.ok)
            return (await response.json());
        if (response.status === 429 || response.status >= 500) {
            await sleep(1000 * (attempt + 1));
            continue;
        }
        const body = await response.text();
        throw new Error(`TCGdex ${response.status}: ${body.slice(0, 300)}`);
    }
    throw new Error(`TCGdex request failed after retries: ${path}`);
}
async function getSets(lang) {
    // TCGdex's default set ordering is releaseDate > localId > id, but we ask explicitly
    // for releaseDate ASC so QuickSet always starts with the oldest sets.
    return tcgdex(lang, 'sets?sort:field=releaseDate&sort:order=ASC');
}
async function getSet(lang, id) {
    return tcgdex(lang, `sets/${encodeURIComponent(id)}`);
}
async function getCard(lang, id) {
    return tcgdex(lang, `cards/${encodeURIComponent(id)}`);
}
function languageSelect(customId) {
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder('Choose a language')
        .addOptions({ label: 'English', value: 'en', emoji: '🇬🇧' }, { label: 'Chinese', value: 'zh-tw', emoji: '🇨🇳' }, { label: 'Japanese', value: 'ja', emoji: '🇯🇵' }));
}
function forumSelect(customId) {
    return new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder('Choose the forum to post the sets in')
        .setChannelTypes(ChannelType.GuildForum));
}
function sortSelect(customId) {
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder('Choose how to sort the cards')
        .addOptions({ label: 'A–Z ascending', value: 'name:asc' }, { label: 'Z–A descending', value: 'name:desc' }, { label: 'Card number ascending', value: 'number:asc' }, { label: 'Card number descending', value: 'number:desc' }, { label: 'Rarity ascending', value: 'rarity:asc' }, { label: 'Rarity descending', value: 'rarity:desc' }));
}
const englishSetCache = new Map();
// TCGdex serves localized set names, but a Japanese/Chinese set does not
// necessarily have a one-to-one English set entry. For forum titles we need
// the English translation of the native name, not an unrelated English set
// that happens to share an ID. Keep exact translations for common official
// names and use the translation service as a fallback for newer sets.
const SET_TRANSLATIONS = {
    '未来の一閃': 'Future Flash',
    '古代の咆哮': 'Ancient Roar',
    'ロケット団の栄光': 'Glory of Team Rocket',
    '火箭队的荣耀': 'Glory of Team Rocket',
    '火箭隊的榮耀': 'Glory of Team Rocket',
};
async function translateNativeSetName(nativeName, language) {
    if (language === 'en')
        return nativeName;
    const exact = SET_TRANSLATIONS[nativeName.trim()];
    if (exact)
        return exact;
    const cacheKey = `${language}:translation:${nativeName}`;
    const cached = englishSetCache.get(cacheKey);
    if (cached)
        return cached;
    // Google Translate's public translation endpoint is used only as a fallback
    // for set names that are not in the exact-name map above. This keeps the bot
    // current as new Japanese/Chinese expansions are added.
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(nativeName)}`;
        const response = await fetch(url, { headers: { 'User-Agent': 'PokeMarket-QuickSet/1.0' } });
        if (response.ok) {
            const data = await response.json();
            const translated = Array.isArray(data) && Array.isArray(data[0])
                ? data[0]
                    .filter((part) => Array.isArray(part))
                    .map((part) => String(part[0] ?? ''))
                    .join('')
                    .trim()
                : '';
            if (translated) {
                englishSetCache.set(cacheKey, translated);
                return translated;
            }
        }
    }
    catch {
        // Fall through to a visible placeholder rather than repeating the native name.
    }
    return 'English translation unavailable';
}
async function getEnglishSetName(set, language) {
    if (language === 'en')
        return set.name;
    // Always translate the native title. Do NOT use the English API set with the
    // same ID because Japanese/Chinese IDs can refer to a different expansion
    // (for example Japanese SV10 is Glory of Team Rocket while English SV10 is
    // Destined Rivals).
    return translateNativeSetName(set.name, language);
}
async function threadName(index, set, language) {
    // Forum titles never expose the internal TCGdex ID/marker. Japanese and
    // Chinese posts show the native title followed by its English translation.
    const nativeName = set.name;
    const englishName = await getEnglishSetName(set, language);
    const title = language === 'en' || englishName === nativeName
        ? nativeName
        : `${nativeName} — ${englishName}`;
    return `${String(index + 1).padStart(3, '0')} • ${title}`.slice(0, 100);
}
function isLegacyQuickSetThread(thread) {
    return /\[TCGDEX:[^\]]+\]$/.test(thread.name);
}
function extractLegacySetId(thread) {
    const match = thread.name.match(/\[TCGDEX:([^\]]+)\]$/);
    return match?.[1] ?? null;
}
async function getQuickSetSetId(thread) {
    // Keep old posts compatible, but new posts are identified from their embed.
    const legacy = extractLegacySetId(thread);
    if (legacy)
        return legacy;
    try {
        const starter = await thread.fetchStarterMessage();
        if (!starter)
            return null;
        const embed = starter.embeds[0];
        if (!embed)
            return null;
        const field = embed.fields.find((f) => f.name.toLowerCase() === 'set id');
        return field?.value?.replace(/`/g, '').trim() || null;
    }
    catch {
        return null;
    }
}
function setEmbed(set, language, index, total) {
    const fields = [
        { name: 'Set', value: set.name || set.id, inline: true },
        { name: 'Set ID', value: `\`${set.id}\``, inline: true },
        { name: 'Series', value: set.serie?.name ?? 'Unknown', inline: true },
        { name: 'Release date', value: set.releaseDate ?? 'Unknown', inline: true },
        { name: 'Cards', value: `${set.cardCount?.official ?? '?'} official / ${set.cardCount?.total ?? '?'} total`, inline: true },
        { name: 'Language', value: LANGUAGE_LABELS[language], inline: true },
    ];
    const embed = new EmbedBuilder()
        .setTitle(`${set.name} — Card List`)
        .setDescription(`Set **${index + 1} of ${total}**\nChoose a sort below to publish the cards in this post.`)
        .addFields(fields)
        .setFooter({ text: 'Data and images: TCGdex' });
    if (set.logo ?? set.symbol)
        embed.setThumbnail(set.logo ?? set.symbol);
    return embed;
}
function cardImageUrl(image, language, set, localId) {
    if (image) {
        // TCGdex commonly returns an asset URL without an extension.
        // Use an explicit high-quality PNG so Discord reliably renders localized
        // Japanese/Chinese scans as well as English scans.
        if (/\.(png|jpe?g|webp)(\?.*)?$/i.test(image))
            return image;
        return `${image}/high.png`;
    }
    // Some localized TCGdex card records do not currently include an `image`
    // field even though the scan exists in the assets service. Reconstruct the
    // documented asset path from the set's series/set/local card ID so those
    // cards still get an image in Discord.
    if (language && set && localId !== undefined) {
        const serieId = set.serie?.id;
        if (serieId) {
            const assetLanguage = language;
            return `https://assets.tcgdex.net/${assetLanguage}/${encodeURIComponent(serieId)}/${encodeURIComponent(set.id)}/${encodeURIComponent(String(localId))}/high.png`;
        }
    }
    return undefined;
}
function cardEmbed(card, language, set) {
    const fields = [
        { name: 'Number', value: String(card.localId), inline: true },
        { name: 'Rarity', value: card.rarity ?? 'Unknown', inline: true },
        { name: 'Type', value: card.types?.length ? card.types.join(', ') : 'Unknown', inline: true },
        { name: 'Stage', value: card.stage ?? 'Unknown', inline: true },
        { name: 'Illustrator', value: card.illustrator ?? 'Unknown', inline: true },
    ];
    const nativeName = card.name || 'Unknown card';
    const title = language && language !== 'en' && card.englishName && card.englishName !== nativeName
        ? `${nativeName} — ${card.englishName}`
        : nativeName;
    const embed = new EmbedBuilder()
        .setTitle(title)
        .addFields(fields);
    const imageUrl = cardImageUrl(card.image, language, set, card.localId);
    if (imageUrl)
        embed.setImage(imageUrl);
    return embed;
}
function sortCards(cards, key, order) {
    const direction = order === 'asc' ? 1 : -1;
    return [...cards].sort((a, b) => {
        if (key === 'name')
            return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) * direction;
        if (key === 'rarity')
            return (a.rarity ?? 'Unknown').localeCompare(b.rarity ?? 'Unknown', undefined, { sensitivity: 'base' }) * direction;
        return compareCardNumber(String(a.localId), String(b.localId)) * direction;
    });
}
function compareCardNumber(a, b) {
    const parse = (v) => {
        const m = v.match(/^(\d+)(.*)$/);
        return m ? [Number(m[1]), m[2]] : [Number.MAX_SAFE_INTEGER, v];
    };
    const [an, as] = parse(a);
    const [bn, bs] = parse(b);
    return an - bn || as.localeCompare(bs, undefined, { numeric: true });
}
async function fetchFullCards(lang, set) {
    const briefs = set.cards ?? [];
    const cards = [];
    const concurrency = 6;
    let cursor = 0;
    async function worker() {
        while (cursor < briefs.length) {
            const i = cursor++;
            const brief = briefs[i];
            try {
                const full = await getCard(lang, brief.id);
                // TCGdex uses the same card IDs across supported languages, so for
                // Japanese/Chinese cards fetch the English record using the exact same
                // ID. This gives us the official English card name instead of relying
                // on machine translation (e.g. ジャンプラフ -> Jumpluff).
                let englishName = full.name;
                if (lang !== 'en') {
                    try {
                        const english = await getCard('en', brief.id);
                        englishName = english.name || full.name;
                    }
                    catch {
                        englishName = await translateNativeSetName(full.name, lang);
                    }
                }
                // TCGdex card detail normally includes the image, but keep the image
                // from the set's card brief as a guaranteed fallback.
                cards[i] = { ...full, englishName, image: full.image ?? brief.image };
            }
            catch (error) {
                console.error(`Card fetch failed ${brief.id}:`, error);
                cards[i] = { ...brief, rarity: 'Unknown', englishName: lang === 'en' ? brief.name : await translateNativeSetName(brief.name, lang) };
            }
            await sleep(75);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, briefs.length) }, worker));
    return cards.filter(Boolean);
}
async function sendPrivateCardPages(interaction, cards, set, key, order) {
    const setLanguage = (interaction.customId.split(':')[2] || 'en');
    // Discord allows up to 10 embeds per message. These are sent as ephemeral
    // interaction responses/follow-ups, so only the person who chose the sort sees them.
    for (let i = 0; i < cards.length; i += 10) {
        const chunk = cards.slice(i, i + 10);
        const page = Math.floor(i / 10) + 1;
        const totalPages = Math.ceil(cards.length / 10);
        const content = `📚 **${set.name}** — ${cards.length} cards\nSort: **${sortLabel(key, order)}**\nPage **${page}/${totalPages}**`;
        if (i === 0) {
            await interaction.editReply({ content, embeds: chunk.map((card) => cardEmbed(card, setLanguage, set)), components: [] });
        }
        else {
            await interaction.followUp({ content, embeds: chunk.map((card) => cardEmbed(card, setLanguage, set)), ephemeral: true });
        }
        await sleep(150);
    }
}
async function findForumThreads(forum) {
    const candidates = new Map();
    const active = await forum.threads.fetchActive();
    for (const thread of active.threads.values())
        candidates.set(thread.id, thread);
    let before;
    for (let page = 0; page < 50; page++) {
        const archived = await forum.threads.fetchArchived({ type: 'public', limit: 100, before });
        for (const thread of archived.threads.values())
            candidates.set(thread.id, thread);
        if (!archived.hasMore || archived.threads.size === 0)
            break;
        const oldest = [...archived.threads.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))[0];
        if (!oldest)
            break;
        before = oldest.id;
    }
    const quickSets = [];
    for (const thread of candidates.values()) {
        if (await getQuickSetSetId(thread))
            quickSets.push(thread);
    }
    return quickSets;
}
async function getExistingSetIds(forum) {
    const threads = await findForumThreads(forum);
    const ids = await Promise.all(threads.map(getQuickSetSetId));
    return new Set(ids.filter((x) => Boolean(x)));
}
async function postSet(forum, set, language, index, total) {
    const thread = await forum.threads.create({
        name: await threadName(index, set, language),
        message: {
            embeds: [setEmbed(set, language, index, total)],
            components: [sortSelect(`quickset:sort:${language}:${set.id}`)],
        },
        reason: `QuickSet ${LANGUAGE_LABELS[language]} — ${set.name}`,
    });
    return thread;
}
async function startQuickSet(interaction) {
    await interaction.reply({
        content: '**QuickSet setup — step 1/2**\nChoose the language to use for the set and card names.',
        components: [languageSelect('quickset:language')],
        ephemeral: true,
    });
}
async function handleQuickSetLanguage(interaction) {
    const language = interaction.values[0];
    await interaction.update({
        content: `**QuickSet setup — step 2/2**\nLanguage: **${LANGUAGE_LABELS[language]}**\nNow choose the forum.`,
        components: [forumSelect(`quickset:forum:${language}`)],
    });
}
async function safeEdit(interaction, content) {
    try {
        await interaction.editReply(content);
    }
    catch (error) {
        console.warn('Interaction update skipped:', error);
    }
}
async function runQuickSet(interaction, language, forum) {
    await interaction.update({
        content: `⏳ Starting QuickSet in **${forum.name}** using **${LANGUAGE_LABELS[language]}**.\nFetching the set list from TCGdex…`,
        components: [],
    });
    const sets = await getSets(language);
    let posted = 0;
    let failed = 0;
    for (let i = 0; i < sets.length; i++) {
        const brief = sets[i];
        try {
            const full = await getSet(language, brief.id);
            await postSet(forum, full, language, i, sets.length);
            posted++;
            await sleep(300);
            if (posted % 10 === 0) {
                await safeEdit(interaction, `⏳ QuickSet is posting sets… **${posted}/${sets.length}** created.`);
            }
        }
        catch (error) {
            failed++;
            console.error(`Failed to post set ${brief.id}:`, error);
        }
    }
    await interaction.editReply(`✅ **QuickSet complete**\nCreated **${posted}** set posts in ${forum}.` +
        (failed ? `\n⚠️ **${failed}** sets failed and can be recovered with **/set continue**.` : '') +
        `\n\nEach set post has its own sort menu.`);
}
async function continueSets(interaction) {
    await interaction.reply({
        content: '**Continue setup — step 1/2**\nChoose the language used by the set posts you want to continue.',
        components: [languageSelect('continue:language')],
        ephemeral: true,
    });
}
async function handleContinueLanguage(interaction) {
    const language = interaction.values[0];
    await interaction.update({
        content: `**Continue setup — step 2/2**\nLanguage: **${LANGUAGE_LABELS[language]}**\nChoose the forum to scan and continue.`,
        components: [forumSelect(`continue:forum:${language}`)],
    });
}
async function runContinue(interaction, language, forum) {
    await interaction.update({
        content: `🔎 Checking ${forum} for existing TCGdex set posts…`,
        components: [],
    });
    const [sets, existing] = await Promise.all([getSets(language), getExistingSetIds(forum)]);
    const missing = sets.filter((set) => !existing.has(set.id));
    if (!missing.length) {
        await safeEdit(interaction, `✅ No missing sets found. All **${sets.length}** TCGdex sets are already flagged in ${forum}.`);
        return;
    }
    const preview = missing.slice(0, 15).map((s) => `• ${s.name} \`${s.id}\``).join('\n');
    await interaction.editReply(`🚩 **${missing.length} sets are missing from ${forum}.**\n\n${preview}` +
        (missing.length > 15 ? `\n…and ${missing.length - 15} more.` : '') +
        `\n\nContinuing in oldest → newest order…`);
    let posted = 0;
    let failed = 0;
    const total = sets.length;
    for (const brief of missing) {
        const originalIndex = sets.findIndex((s) => s.id === brief.id);
        try {
            const full = await getSet(language, brief.id);
            await postSet(forum, full, language, originalIndex, total);
            posted++;
            await sleep(300);
            if (posted % 10 === 0)
                await interaction.editReply(`⏳ Continuing… **${posted}/${missing.length}** missing set posts created.`);
        }
        catch (error) {
            failed++;
            console.error(`Continue failed ${brief.id}:`, error);
        }
    }
    await interaction.editReply(`✅ **Continue complete**\nAdded **${posted}** missing set posts.` +
        (failed ? `\n⚠️ **${failed}** failed; run **/set continue** again after checking permissions/API access.` : ''));
}
async function handleSort(interaction) {
    const [, , languageRaw, setId] = interaction.customId.split(':');
    const language = languageRaw;
    const [key, order] = interaction.values[0].split(':');
    const thread = interaction.channel;
    if (!thread?.isThread()) {
        await interaction.reply({ content: 'This menu can only be used inside a QuickSet forum post.', ephemeral: true });
        return;
    }
    // Everything produced by the sort menu is private to the person who selected it.
    await interaction.deferReply({ ephemeral: true });
    try {
        const set = await getSet(language, setId);
        const cards = sortCards(await fetchFullCards(language, set), key, order);
        await sendPrivateCardPages(interaction, cards, set, key, order);
    }
    catch (error) {
        console.error(error);
        await interaction.editReply({ content: '❌ I could not load this set from TCGdex. Check the bot logs and try again.' });
    }
}
function sortLabel(key, order) {
    if (key === 'name')
        return order === 'asc' ? 'A–Z ascending' : 'Z–A descending';
    if (key === 'number')
        return order === 'asc' ? 'Card number ascending' : 'Card number descending';
    return order === 'asc' ? 'Rarity ascending' : 'Rarity descending';
}
const MARKET_CONFIG_PATH = './pokemarket-market-config.json';
let marketConfig = { forums: {}, transcriptChannels: {}, logChannels: {} };
async function loadMarketConfig() {
    try {
        const fs = await import('node:fs');
        if (fs.existsSync(MARKET_CONFIG_PATH)) {
            const x = JSON.parse(fs.readFileSync(MARKET_CONFIG_PATH, 'utf8'));
            marketConfig = { forums: x.forums ?? {}, transcriptChannels: x.transcriptChannels ?? {}, logChannels: x.logChannels ?? {} };
        }
    }
    catch (e) {
        console.error('Market config load failed:', e);
    }
}
async function saveMarketConfig() {
    try {
        const fs = await import('node:fs');
        fs.writeFileSync(MARKET_CONFIG_PATH, JSON.stringify(marketConfig, null, 2));
    }
    catch (e) {
        console.error('Market config save failed:', e);
    }
}
function canConfigure(i) {
    return Boolean(i.memberPermissions?.has('ManageChannels') || i.memberPermissions?.has('Administrator'));
}
function norm(s) {
    return s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}/.'-]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
const STOP = new Set('the and for with this that card pokemon tcg buy sell selling sold want wanted take taking please deal price offer offers negotiable negotiation available looking have has is are was were from you your me my a an to of in on at it i we they he she english japanese chinese traditional language condition nm near mint'.split(' '));
function tokens(s) {
    return new Set(norm(s).split(/\s+/).map(x => x.replace(/^[.'-]+|[.'-]+$/g, '')).filter(x => x.length >= 3 && !STOP.has(x) && !/^\d+$/.test(x)));
}
function numbers(s) {
    return new Set([...s.matchAll(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/g)].map(m => `${Number(m[1])}/${Number(m[2])}`));
}
function prices(s) {
    const out = new Set();
    for (const m of s.matchAll(/(?:[$€£]|R)\s?(\d+(?:[.,]\d{1,2})?)/gi))
        out.add(m[1].replace(',', '.'));
    for (const m of s.matchAll(/\b(\d+(?:[.,]\d{1,2})?)\s?(?:USD|EUR|GBP|ZAR)\b/gi))
        out.add(m[1].replace(',', '.'));
    return out;
}
function language(s) {
    const n = norm(s);
    if (/\bjapanese\b|\bjp\b|日本語|日本/.test(n))
        return 'japanese';
    if (/\bchinese\b|\bcn\b|中文|繁體|简体/.test(n))
        return 'chinese';
    if (/\benglish\b|\ben\b/.test(n))
        return 'english';
    return '';
}
function itemHints(s) {
    return s.split(/\r?\n/).map(x => x.match(/(?:card|item|product|listing|pokemon|pokémon|set)\s*[:=-]\s*(.+)/i)?.[1] ?? '')
        .filter(Boolean).join(' ');
}
async function transcriptText(message) {
    const parts = [message.content || ''];
    for (const e of message.embeds ?? []) {
        parts.push(e.title || '', e.description || '', ...(e.fields ?? []).flatMap((f) => [f.name, f.value]));
    }
    for (const a of message.attachments?.values?.() ?? []) {
        if (!/\.(txt|html?|json|csv)$/i.test(String(a.name)))
            continue;
        try {
            const r = await fetch(a.url);
            if (r.ok)
                parts.push(await r.text());
        }
        catch { }
    }
    return parts.join('\n').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').trim();
}
async function speakingMembers(guild, text) {
    const ids = new Set([...text.matchAll(/<@!?(\d{15,22})>/g)].map(m => m[1]));
    const found = new Map();
    for (const id of ids) {
        try {
            const m = await guild.members.fetch(id);
            if (m)
                found.set(m.id, m.displayName || m.user.username);
        }
        catch { }
    }
    try {
        const members = await guild.members.fetch();
        for (const m of members.values()) {
            const names = [m.displayName, m.user.username, m.user.globalName].filter(Boolean).sort((a, b) => b.length - a.length);
            for (const name of names) {
                const e = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (new RegExp(`(?:^|\\n)\\s*(?:\\[[^\\]]+\\]\\s*)?(?:@)?${e}(?:#\\d{4})?\\s*[:>-]\\s*`, 'i').test(text)) {
                    found.set(m.id, String(name));
                    break;
                }
            }
        }
    }
    catch (e) {
        console.warn('Speaker lookup failed:', e);
    }
    return found;
}
async function allThreads(forum) {
    const map = new Map();
    const active = await forum.threads.fetchActive();
    for (const t of active.threads.values())
        map.set(t.id, t);
    let before;
    for (let page = 0; page < 50; page++) {
        const a = await forum.threads.fetchArchived({ type: 'public', limit: 100, before });
        for (const t of a.threads.values())
            map.set(t.id, t);
        if (!a.hasMore || !a.threads.size)
            break;
        const oldest = [...a.threads.values()].sort((x, y) => BigInt(x.id) < BigInt(y.id) ? -1 : 1)[0];
        if (!oldest)
            break;
        before = oldest.id;
    }
    return [...map.values()];
}
function listingText(t, s) {
    return `${t.name}\n${s?.content || ''}\n${(s?.embeds ?? []).map((e) => [e.title, e.description, ...((e.fields ?? []).flatMap((f) => [f.name, f.value]))].filter(Boolean).join('\n')).join('\n')}`;
}
function listingScore(transcript, hints, t, s) {
    const lt = listingText(t, s), a = tokens(transcript + ' ' + hints), b = tokens(lt);
    const overlap = [...a].filter(x => b.has(x));
    const ns = [...numbers(transcript)].filter(x => numbers(lt).has(x));
    const ps = [...prices(transcript)].filter(x => prices(lt).has(x));
    let score = Math.min(45, overlap.length * 9) + ns.length * 45 + ps.length * 20;
    const lang = language(transcript);
    if (lang && language(lt) === lang)
        score += 12;
    const ht = [...tokens(hints)].filter(x => b.has(x));
    score += Math.min(25, ht.length * 8);
    return { score, itemMatched: overlap.length > 0 || ns.length > 0 || ht.length > 0, ns, ps, overlap };
}
async function tagThread(t, inStock, soldOut) {
    const set = new Set(t.appliedTags);
    if (soldOut) {
        set.add(soldOut);
        if (inStock)
            set.delete(inStock);
    }
    else if (inStock)
        set.add(inStock);
    await t.setAppliedTags([...set]);
}
async function marketLog(guild, text) {
    const id = marketConfig.logChannels[guild.id];
    if (id) {
        const c = await guild.channels.fetch(id).catch(() => null);
        if (c?.isTextBased()) {
            await c.send(text).catch(() => { });
            return;
        }
    }
    console.log(`[Marketplace] ${guild.name}: ${text.replace(/\n/g, ' | ')}`);
}
async function processTranscript(message) {
    const text = await transcriptText(message);
    if (!text.trim())
        return;
    const speakers = await speakingMembers(message.guild, text);
    if (!speakers.size) {
        await marketLog(message.guild, `⚠️ Transcript ${message.id}: no speaker could be identified. No listing changed.`);
        return;
    }
    const hints = itemHints(text), matches = [];
    for (const [forumId, cfg] of Object.entries(marketConfig.forums)) {
        if (cfg.guildId !== message.guild.id)
            continue;
        const forum = await message.guild.channels.fetch(forumId).catch(() => null);
        if (!forum || forum.type !== ChannelType.GuildForum)
            continue;
        for (const t of await allThreads(forum)) {
            let starter;
            try {
                starter = await t.fetchStarterMessage();
            }
            catch {
                continue;
            }
            if (!starter?.author?.id || !speakers.has(starter.author.id))
                continue;
            const x = listingScore(text, hints, t, starter);
            if (x.itemMatched && x.score >= 30)
                matches.push({ t, cfg, x, owner: speakers.get(starter.author.id) });
        }
    }
    matches.sort((a, b) => b.x.score - a.x.score);
    if (!matches.length) {
        await marketLog(message.guild, `⚠️ Transcript ${message.id}: identified speaker(s) **${[...speakers.values()].join(', ')}**, but no matching listing from those users was found. Listings remain **IN STOCK**.`);
        return;
    }
    const best = matches[0], second = matches[1];
    if (second && best.x.score - second.x.score < 15) {
        await marketLog(message.guild, `⚠️ Transcript ${message.id}: multiple listings matched. No listing was changed because the match is ambiguous.`);
        return;
    }
    if (!best.cfg.soldOutTagId) {
        await marketLog(message.guild, `⚠️ Matched **${best.t.name}**, but SOLD OUT is not configured. Use /forum tags.`);
        return;
    }
    try {
        await tagThread(best.t, best.cfg.inStockTagId, best.cfg.soldOutTagId);
        await marketLog(message.guild, `✅ **SOLD OUT**\nSpeaker/listing owner: **${best.owner}**\nListing: **${best.t.name}**\nMatch score: **${best.x.score}**`);
    }
    catch (e) {
        console.error(e);
        await marketLog(message.guild, `❌ Matched **${best.t.name}**, but could not apply SOLD OUT. Check permissions.`);
    }
}
async function syncInStock(forum) {
    const cfg = marketConfig.forums[forum.id];
    if (!cfg?.inStockTagId)
        return 0;
    let n = 0;
    for (const t of await allThreads(forum)) {
        if (cfg.soldOutTagId && t.appliedTags.includes(cfg.soldOutTagId))
            continue;
        if (t.appliedTags.includes(cfg.inStockTagId))
            continue;
        try {
            await tagThread(t, cfg.inStockTagId, cfg.soldOutTagId);
            n++;
        }
        catch { }
    }
    return n;
}
async function handleForum(interaction) {
    if (!canConfigure(interaction)) {
        await interaction.reply({ content: '❌ You need Manage Channels or Administrator.', ephemeral: true });
        return;
    }
    const sub = interaction.options.getSubcommand();
    const ch = interaction.options.getChannel('forum', sub !== 'list');
    if (sub === 'add' || sub === 'remove') {
        if (!ch || ch.type !== ChannelType.GuildForum) {
            await interaction.reply({ content: '❌ Choose a Forum channel.', ephemeral: true });
            return;
        }
        if (sub === 'add') {
            marketConfig.forums[ch.id] = { guildId: interaction.guildId };
            await saveMarketConfig();
            await interaction.reply({ content: `✅ Added ${ch}. Now use /forum tags to set IN STOCK and SOLD OUT.`, ephemeral: true });
        }
        else {
            delete marketConfig.forums[ch.id];
            await saveMarketConfig();
            await interaction.reply({ content: `✅ Removed ${ch}.`, ephemeral: true });
        }
        return;
    }
    if (sub === 'list') {
        const a = Object.entries(marketConfig.forums).filter(([, v]) => v.guildId === interaction.guildId);
        await interaction.reply({ content: a.length ? a.map(([id, v]) => `• <#${id}> — IN STOCK: \`${v.inStockTagId || 'not set'}\` — SOLD OUT: \`${v.soldOutTagId || 'not set'}\``).join('\n') : 'No marketplace forums configured.', ephemeral: true });
        return;
    }
    if (!ch || ch.type !== ChannelType.GuildForum) {
        await interaction.reply({ content: '❌ Choose a Forum channel.', ephemeral: true });
        return;
    }
    const inStock = interaction.options.getString('in_stock_tag', true), soldOut = interaction.options.getString('sold_out_tag', true);
    const f = ch, valid = new Set(f.availableTags.map(x => x.id));
    if (!valid.has(inStock) || !valid.has(soldOut)) {
        await interaction.reply({ content: `❌ Invalid tag ID. Available tags:\n${f.availableTags.map(x => `• ${x.name}: \`${x.id}\``).join('\n') || 'None'}`, ephemeral: true });
        return;
    }
    marketConfig.forums[f.id] = { ...(marketConfig.forums[f.id] || { guildId: interaction.guildId }), guildId: interaction.guildId, inStockTagId: inStock, soldOutTagId: soldOut };
    await saveMarketConfig();
    const n = await syncInStock(f);
    await interaction.reply({ content: `✅ Tags configured. Added IN STOCK to ${n} existing listing(s).`, ephemeral: true });
}
async function handleTview(interaction) {
    if (!canConfigure(interaction)) {
        await interaction.reply({ content: '❌ You need Manage Channels or Administrator.', ephemeral: true });
        return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
        const a = Object.entries(marketConfig.transcriptChannels).filter(([, g]) => g === interaction.guildId);
        await interaction.reply({ content: a.length ? a.map(([id]) => `• <#${id}>`).join('\n') : 'No transcript channels configured.', ephemeral: true });
        return;
    }
    const ch = interaction.options.getChannel('channel', true);
    if (!ch || typeof ch.isTextBased !== 'function' || !ch.isTextBased()) {
        await interaction.reply({ content: '❌ Choose a text channel.', ephemeral: true });
        return;
    }
    if (sub === 'add') {
        marketConfig.transcriptChannels[ch.id] = interaction.guildId;
        await saveMarketConfig();
        await interaction.reply({ content: `✅ ${ch} is now watched for new ticket transcripts.`, ephemeral: true });
    }
    else if (sub === 'remove') {
        delete marketConfig.transcriptChannels[ch.id];
        await saveMarketConfig();
        await interaction.reply({ content: `✅ ${ch} is no longer watched.`, ephemeral: true });
    }
    else {
        marketConfig.logChannels[interaction.guildId] = ch.id;
        await saveMarketConfig();
        await interaction.reply({ content: `✅ Match results will be posted in ${ch}.`, ephemeral: true });
    }
}
async function registerCommands() {
    const commands = [
        {
            name: 'quickset',
            description: 'Post one TCGdex forum post for every Pokémon TCG set.',
        },
        {
            name: 'set',
            description: 'Manage TCGdex set posts.',
            options: [
                { type: 1, name: 'continue', description: 'Find and post any TCGdex sets missing from a forum.' },
            ],
        },
        {
            name: 'forum', description: 'Configure marketplace forums and stock tags.',
            options: [
                { type: 1, name: 'add', description: 'Add a marketplace forum.', options: [{ type: 7, name: 'forum', description: 'Forum channel.', required: true, channel_types: [15] }] },
                { type: 1, name: 'remove', description: 'Remove a marketplace forum.', options: [{ type: 7, name: 'forum', description: 'Forum channel.', required: true, channel_types: [15] }] },
                { type: 1, name: 'list', description: 'List configured marketplace forums.' },
                { type: 1, name: 'tags', description: 'Configure IN STOCK and SOLD OUT tags.', options: [
                        { type: 7, name: 'forum', description: 'Forum channel.', required: true, channel_types: [15] },
                        { type: 3, name: 'in_stock_tag', description: 'IN STOCK tag ID.', required: true },
                        { type: 3, name: 'sold_out_tag', description: 'SOLD OUT tag ID.', required: true },
                    ] },
            ],
        },
        {
            name: 'tview', description: 'Configure automatic ticket transcript watching.',
            options: [
                { type: 1, name: 'add', description: 'Watch a transcript channel.', options: [{ type: 7, name: 'channel', description: 'Transcript channel.', required: true }] },
                { type: 1, name: 'remove', description: 'Stop watching a transcript channel.', options: [{ type: 7, name: 'channel', description: 'Transcript channel.', required: true }] },
                { type: 1, name: 'list', description: 'List watched transcript channels.' },
                { type: 1, name: 'log', description: 'Set match-result log channel.', options: [{ type: 7, name: 'channel', description: 'Log channel.', required: true }] },
            ],
        },
    ];
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    if (GUILD_ID) {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log(`Registered commands in guild ${GUILD_ID}`);
    }
    else {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Registered global commands');
    }
}
client.once(Events.ClientReady, async (ready) => {
    console.log(`Logged in as ${ready.user.tag}`);
    try {
        await registerCommands();
    }
    catch (error) {
        console.error('Command registration failed:', error);
    }
});
client.on(Events.InteractionCreate, async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'quickset')
                return startQuickSet(interaction);
            if (interaction.commandName === 'set' && interaction.options.getSubcommand() === 'continue')
                return continueSets(interaction);
            if (interaction.commandName === 'forum')
                return handleForum(interaction);
            if (interaction.commandName === 'tview')
                return handleTview(interaction);
        }
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'quickset:language')
                return handleQuickSetLanguage(interaction);
            if (interaction.customId.startsWith('continue:language'))
                return handleContinueLanguage(interaction);
            if (interaction.customId.startsWith('quickset:sort:'))
                return handleSort(interaction);
        }
        if (interaction.isChannelSelectMenu()) {
            const [, mode, language] = interaction.customId.split(':');
            const channel = interaction.channels.first();
            if (!channel || channel.type !== ChannelType.GuildForum) {
                await interaction.reply({ content: 'Please choose a forum channel.', ephemeral: true });
                return;
            }
            if (mode === 'forum' && interaction.customId.startsWith('quickset:')) {
                return runQuickSet(interaction, language, channel);
            }
            if (mode === 'forum' && interaction.customId.startsWith('continue:')) {
                return runContinue(interaction, language, channel);
            }
        }
    }
    catch (error) {
        console.error('Interaction error:', error);
        if (interaction.isRepliable()) {
            const message = '❌ Something went wrong. Check the Railway logs for details.';
            if (interaction.replied || interaction.deferred)
                await interaction.followUp({ content: message, ephemeral: true }).catch(() => { });
            else
                await interaction.reply({ content: message, ephemeral: true }).catch(() => { });
        }
    }
});
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);
void loadMarketConfig();
client.on(Events.ThreadCreate, async (thread) => {
    try {
        if (thread.parent?.type !== ChannelType.GuildForum)
            return;
        if (!thread.parentId)
            return;
        const cfg = marketConfig.forums[thread.parentId];
        if (!cfg?.inStockTagId || (cfg.soldOutTagId && thread.appliedTags.includes(cfg.soldOutTagId)))
            return;
        await tagThread(thread, cfg.inStockTagId, cfg.soldOutTagId);
    }
    catch (e) {
        console.error('IN STOCK auto-tag failed:', e);
    }
});
client.on(Events.MessageCreate, async (message) => {
    try {
        if (message.author.bot || !message.guild || !marketConfig.transcriptChannels[message.channelId])
            return;
        await processTranscript(message);
    }
    catch (e) {
        console.error('Transcript processing failed:', e);
    }
});
client.login(TOKEN);
