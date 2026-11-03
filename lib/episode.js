// 「事」的数据模型：一次经历 = 一条 episode。
//
// 为什么用 episode 而不是自由文本：记忆要能按天回取、按日期拼接，
// 也要能事后修正。所以每条事都带一个稳定的 id、明确的时间戳，
// 以及四类内容：看到了什么 / 留下了什么 / 做了什么 / 当时在想什么。
//
// 本文件只做「规范化」：把调用方给进来的松散输入收敛成确定形状，非法输入直接报错，
// 绝不静默吞掉（记忆宁可报错让人改，也不要悄悄丢一条）。
import { datePartOf, isDateKey, normalizeTimestamp, parseDateKey, timestampOf } from './time.js';

export const ACTION_KINDS = [
	'观看',
	'点赞',
	'投币',
	'收藏',
	'评论',
	'回复',
	'发视频',
	'搜索',
	'关注',
	'私信',
	'打开页面',
	'其他',
];

export const RESPONSE_KINDS = [
	'回复',
	'评论',
	'点赞',
	'踩',
	'举报',
	'关注',
	'私信',
	'投币',
	'收藏',
	'推荐变化',
	'限流迹象',
	'无回应',
	'其他',
];

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 生成 episode id：day 前缀 + 时间 + 随机后缀，肉眼可读、字典序≈时间序。 */
export function makeEpisodeId(day, stamp, salt = '') {
	if (!isDateKey(day)) throw new Error(`无法用 ${day} 生成 id`);
	const hhmmss = /T(\d{2})(\d{2})(\d{2})/.exec(String(stamp ?? ''));
	const time = hhmmss === null ? '000000' : `${hhmmss[1]}${hhmmss[2]}${hhmmss[3]}`;
	let hash = 2166136261;
	const seed = `${day}T${time}:${salt}:${Math.random()}`;
	for (let i = 0; i < seed.length; i += 1) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	let tail = '';
	let h = hash >>> 0;
	for (let i = 0; i < 4; i += 1) {
		tail += ID_ALPHABET[h % ID_ALPHABET.length];
		h = Math.floor(h / ID_ALPHABET.length) + 7;
	}
	return `${day.replace(/-/g, '')}-${time}-${tail}`;
}

const ID_PATTERN = /^\d{8}-\d{6}-[0-9a-z]{4}$/;
export function isEpisodeId(value) {
	return typeof value === 'string' && ID_PATTERN.test(value);
}

/** 从 episode id 前缀读出日期键（20261103-… → 2026-11-03）；没有就回落到 fallback。 */
export function dayHintOf(id, fallback) {
	if (!isEpisodeId(id)) return fallback;
	const d = id.slice(0, 8);
	const key = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
	return isDateKey(key) ? key : fallback;
}

function text(value) {
	if (value === undefined || value === null) return '';
	return String(value).trim();
}

function textList(value) {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.map(text).filter((s) => s !== '');
	if (typeof value === 'string') {
		return value
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter((s) => s !== '');
	}
	return [text(value)].filter((s) => s !== '');
}

function cleanObject(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const out = {};
	for (const [k, v] of Object.entries(value)) {
		if (v === undefined || v === null || v === '') continue;
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
		else if (Array.isArray(v)) {
			const list = v.map(text).filter((s) => s !== '');
			if (list.length > 0) out[k] = list;
		}
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * 规范化「看到了什么」。
 * 允许字符串（整段描述）、字符串数组、或对象 { what?, where?, link?, author?, notes? }。
 */
export function normalizeSaw(input) {
	if (input === undefined || input === null) return [];
	const items = Array.isArray(input) ? input : [input];
	const out = [];
	for (const item of items) {
		if (item === undefined || item === null) continue;
		if (typeof item === 'string') {
			const what = item.trim();
			if (what !== '') out.push({ what });
			continue;
		}
		if (typeof item !== 'object') {
			out.push({ what: text(item) });
			continue;
		}
		const what = text(item.what ?? item.title ?? item.text ?? item.description);
		const where = text(item.where ?? item.platform ?? item.site);
		const link = text(item.link ?? item.url);
		const author = text(item.author ?? item.by ?? item.up);
		const notes = text(item.notes ?? item.note);
		if (what === '' && where === '' && link === '' && author === '' && notes === '') continue;
		const entry = { what };
		if (where !== '') entry.where = where;
		if (link !== '') entry.link = link;
		if (author !== '') entry.author = author;
		if (notes !== '') entry.notes = notes;
		out.push(entry);
	}
	return out;
}

/** 规范化一个动作。 */
export function normalizeAction(input) {
	if (input === undefined || input === null) return null;
	if (typeof input === 'string') {
		const s = input.trim();
		if (s === '') return null;
		return { kind: '其他', target: '', detail: s };
	}
	if (typeof input !== 'object' || Array.isArray(input)) return null;
	const kind = text(input.kind ?? input.action ?? input.type);
	const target = text(input.target ?? input.to ?? input.object);
	const detail = text(input.detail ?? input.content ?? input.text ?? input.note);
	const link = text(input.link ?? input.url);
	if (kind === '' && target === '' && detail === '' && link === '') return null;
	const out = { kind: kind === '' ? '其他' : kind, target };
	if (detail !== '') out.detail = detail;
	if (link !== '') out.link = link;
	const extra = cleanObject(input.extra);
	if (extra !== undefined) out.extra = extra;
	return out;
}

/** 规范化「世界怎么回应」（主要用于观察记录）。 */
export function normalizeResponse(input) {
	if (input === undefined || input === null) return [];
	const items = Array.isArray(input) ? input : [input];
	const out = [];
	for (const item of items) {
		if (item === undefined || item === null) continue;
		const action = normalizeAction(item);
		if (action === null) continue;
		out.push(action);
	}
	return out;
}

function pickSource(input) {
	const src = input?.source;
	if (src === 'seed' || src === 'manual' || src === 'agent') return src;
	return null;
}

/** 已经是规范化形状（有 day + 数组型 saw）的条目。 */
export function isNormalizedEpisode(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof value.at === 'string' &&
		isDateKey(value.day) &&
		Array.isArray(value.saw) &&
		Array.isArray(value.actions)
	);
}

/**
 * 规范化一条 episode（字段：time/at、saw、sawNote、left、leftNote、actions、actionsNote、
 * felt、responses、notes、tags、author、source）。不认识的字段直接报错，防止拼错字段名被静默丢掉。
 * 已经规范化的条目原样通过（幂等）。
 * @param {object} input
 * @param {object} opts
 * @param {string} opts.tz - 时区
 * @param {string} opts.today - 默认日期（补齐无日期的时间戳）
 * @param {string} [opts.source] - 默认来源
 * @param {string} [opts.author] - 默认作者
 * @param {string} [opts.note] - 默认备注（人工推演的记录用这个记「依据」）
 * @returns {object} 规范化后的 episode（未含 id，id 在库里分配）
 */
export function normalizeEpisode(input, opts = {}) {
	if (isNormalizedEpisode(input)) return input;
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new Error('一条记录必须是对象');
	}
	const known = new Set([
		'id', 'time', 'at', 'timestamp', 'source', 'author',
		'saw', 'sawNote', 'left', 'leaves', 'leftNote',
		'actions', 'actionsNote', 'felt', 'thought', 'mood',
		'responses', 'response', 'notes', 'note', 'tags',
	]);
	const unknown = Object.keys(input).filter((k) => !known.has(k));
	if (unknown.length > 0) {
		throw new Error(`记录里有不认识的字段：${unknown.join('、')}（可用字段见 README）`);
	}
	const rawTime = input.at ?? input.time ?? input.timestamp;
	// 只给了 "HH:mm" 时用哪天补全？优先用 id 前缀（20261103-…）里的日期 ——
	// 回放/补写历史时，"今天"往往是错的，而 id 是当时钉下的日期。
	const at = normalizeTimestamp(rawTime, { tz: opts.tz, today: dayHintOf(input.id, opts.today) });
	if (at === null) throw new Error(`time 字段无法解析：${JSON.stringify(input.at ?? input.time)}`);
	const day = datePartOf(at);
	parseDateKey(day);
	return {
		id: typeof input.id === 'string' && isEpisodeId(input.id) ? input.id : null,
		at,
		day,
		source: pickSource(input) ?? opts.source ?? 'manual',
		author: text(input.author) || (opts.author ?? ''),
		saw: normalizeSaw(input.saw),
		sawNote: text(input.sawNote),
		left: normalizeSaw(input.left ?? input.leaves),
		leftNote: text(input.leftNote),
		actions: (Array.isArray(input.actions) ? input.actions : input.actions ? [input.actions] : [])
			.map(normalizeAction)
			.filter((a) => a !== null),
		actionsNote: text(input.actionsNote),
		felt: text(input.felt ?? input.thought ?? input.mood),
		responses: normalizeResponse(input.responses ?? input.response),
		notes: text(input.notes ?? input.note),
		tags: textList(input.tags),
	};
}

/** 给已经落库的 episode 盖 id（幂等）。 */
export function ensureEpisodeId(episode) {
	if (isEpisodeId(episode.id)) return episode;
	return { ...episode, id: makeEpisodeId(episode.day, episode.at, `${episode.author}|${episode.sawNote}`) };
}

/** 按时间排序（稳定：同时刻按 id）。 */
export function sortEpisodes(list) {
	return [...list].sort((a, b) => {
		const ta = Date.parse(a.at);
		const tb = Date.parse(b.at);
		if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
		return String(a.id).localeCompare(String(b.id));
	});
}

/** 观察记录的短指纹，用于发现「日记内容被改过」。 */
export function fingerprint(values) {
	let h1 = 0x811c9dc5;
	let h2 = 0x1000193;
	for (const value of values) {
		const s = String(value);
		for (let i = 0; i < s.length; i += 1) {
			h1 ^= s.charCodeAt(i);
			h1 = Math.imul(h1, 16777619);
			h2 = (h2 + s.charCodeAt(i) * (i + 1)) >>> 0;
		}
		h1 ^= 0x0a;
		h1 = Math.imul(h1, 16777619);
	}
	return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export { timestampOf };
