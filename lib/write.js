// 「记下今天的事」：把一段经历写进第一份记录，并把当天 / 那几天的 .md 重新渲染出来。
//
// 结构化数据是真相源（days/*.json），.md 是给人看、也给 Chatbox 之类工具直接读的镜像。
// 每次写入都把涉及的日子的 .md 整体重渲染 —— 保证两份视图永远同源，不会各说各话。
import { renderDiaryDay } from './diary.js';
import { normalizeEpisode, ensureEpisodeId, sortEpisodes } from './episode.js';
import { fingerprintOfDiary } from './store.js';

/**
 * 构造待写的条目（还没落库）。校验在落库前完成：一条非法就整体不写，
 * 免得出现"写了一半"的日记。
 */
export function buildDiaryEntries(inputs, { tz, today, source = 'agent', author = '它' }) {
	const list = Array.isArray(inputs) ? inputs : [inputs];
	return list.map((raw) =>
		ensureEpisodeId(normalizeEpisode(raw, { tz, today, source, author })),
	);
}

/**
 * 写入并重渲染 .md。
 * @param {import('./store.js').MemoryStore} store
 * @param {object[]} rawEntries
 * @param {object} opts
 * @param {string} opts.tz
 * @param {string} opts.today
 * @param {string} [opts.source]
 * @param {string} [opts.author]
 * @param {string} [opts.overview] - 给当天写一句「那天大概是这样」
 * @returns {{days:string[], entries:object[], files:string[]}}
 */
export function remember(store, rawEntries, opts) {
	const entries = buildDiaryEntries(rawEntries, opts);
	const { written } = store.writeDiary(entries, {
		tz: opts.tz,
		today: opts.today,
		source: opts.source ?? 'agent',
		author: opts.author ?? '它',
		overview: opts.overview,
	});
	const files = [];
	for (const day of written) files.push(redrawDiaryDay(store, day, opts));
	return { days: written, entries, files };
}
/** 把某天的 .md 重新渲染（以 json 为准），返回文件路径。 */
export function redrawDiaryDay(store, day, { tz } = {}) {
	const doc = store.readDiaryDay(day);
	if (doc === null) return null;
	doc.entries = sortEpisodes(doc.entries ?? []);
	doc.fingerprint = fingerprintOfDiary(doc);
	doc.md = `${renderDiaryDay(doc, { tz })}\n`;
	store.diary.writeDay(day, doc);
	return store.diary.mdFile(day);
}

/** 校验一个「日子」参数：可以是 YYYY-MM-DD，也可以是 "today"/"昨天" 这类相对写法。 */
export function resolveDayArg(input, { today, tz }) {
	if (input === undefined || input === null || String(input).trim() === '') return today;
	const raw = String(input).trim().toLowerCase();
	if (raw === 'today' || raw === '今天' || raw === 'now') return today;
	if (raw === 'yesterday' || raw === '昨天') return shift(today, -1);
	if (raw === '前天') return shift(today, -2);
	return input;
}

function shift(day, delta) {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + delta);
	return d.toISOString().slice(0, 10);
}
