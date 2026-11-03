// 回灌：把日记变成模型能读的一段文字。
//
// 设计要点：
//   - 两个入口：启动时注入最近三天；按日期调取任意一天。
//   - 正文用自然语言日记体，末尾跟一个很短的「记事」区（最近帮它记下的几件事），
//     让工具调用与日记有连续性。
import { addDays, lastDays, todayKey } from './time.js';
import { renderDiaryDays, dayHeading, relativeDayName } from './diary.js';

export const DEFAULT_BOOTSTRAP_DAYS = 3;
/** 注入正文的硬上限（字符）。超了就只保留最近几天并说明。 */
export const MAX_INJECT_CHARS = 12000;
/** 单日回取的字数上限，超了截断并提示。 */
export const MAX_DAY_CHARS = 20000;

const OPENING =
	'（这是你自己这几天的记事。下面最后一天的末尾就是"现在"，接着过就好 —— 不用复述，也不用谢。）';

const FALLBACK_NOTE_REFRESH = '（它暂时没有可用的小记录区。）';

function clip(text, max, label) {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 40)}\n\n…（${label}太长，后面的先略过了）`;
}

/**
 * 最近 n 天的回灌正文。
 *
 * 取的是**日历上的最近 n 天**（含今天），不是"有记录的日子"——
 * 因为"昨天没记=昨天没发生什么"本身就是它该知道的事实。
 * 空白天写了「这天没有留下记录」，而不是跳过。
 *
 * @param {object} store - MemoryStore
 * @param {object} opts
 * @param {number} [opts.days=3]
 * @param {string} opts.today
 * @param {string} [opts.tz]
 * @param {number} [opts.maxChars]
 * @returns {{text:string, days:string[], used:string[]}}
 */
export function recallRecent(store, opts) {
	const count = opts.days ?? DEFAULT_BOOTSTRAP_DAYS;
	if (!Number.isInteger(count) || count < 1 || count > 60) throw new Error(`天数非法：${String(count)}`);
	const today = opts.today;
	const wanted = lastDays(today, count);
	let used = wanted;
	let docs = wanted.map((day) => store.readDiary(day));
	let blocks = docs.map((doc, i) => {
		if (doc === null) {
			return `## ${dayHeading(wanted[i])}\n\n- 这天没有留下什么记录。`;
		}
		return renderDiaryDays([doc], { tz: opts.tz });
	});
	let text = `${OPENING}\n\n${blocks.join('\n\n')}`;
	const max = opts.maxChars ?? MAX_INJECT_CHARS;
	// 太长就从最早的那天开始丢，保证"最近"一定在
	while (text.length > max && blocks.length > 1) {
		blocks = blocks.slice(1);
		used = used.slice(1);
		docs = docs.slice(1);
		text = `${OPENING}\n\n（更早的几天为省篇幅先略过了。）\n\n${blocks.join('\n\n')}`;
	}
	text = clip(text, max, '最近几天的记事');
	return { text, days: used, used: used.filter((d, i) => docs[i] !== null) };
}

/**
 * 按日期调取一天的回灌正文。
 * @param {object} store
 * @param {string} day - YYYY-MM-DD
 * @param {object} [opts]
 * @param {string} [opts.today]
 * @param {string} [opts.tz]
 * @returns {{text:string, found:boolean, day:string}}
 */
export function recallDay(store, day, opts = {}) {
	const doc = store.readDiary(day);
	const rel = opts.today ? ` · ${relativeDayName(day, opts.today)}` : '';
	if (doc === null) {
		return {
			found: false,
			day,
			text: `## ${dayHeading(day)}${rel}\n\n- 这天没有留下什么记录。`,
		};
	}
	const body = renderDiaryDays([doc], { tz: opts.tz, title: `${dayHeading(day)}${rel}` });
	return { found: true, day, text: clip(body, opts.maxChars ?? MAX_DAY_CHARS, '这一天的记录') };
}

/**
 * 启动注入用的完整系统提示片段：开场 + 最近三天 + 很短的记事。
 * @param {object} store
 * @param {object} opts
 * @param {number} [opts.days]
 * @param {string} opts.today
 * @param {string} [opts.tz]
 * @param {string} [opts.notebookText] - 第三方注入的小记录区（可以不给）
 * @param {number} [opts.maxChars]
 */
export function buildBootstrap(store, opts) {
	const recall = recallRecent(store, {
		days: opts.days ?? DEFAULT_BOOTSTRAP_DAYS,
		today: opts.today,
		tz: opts.tz,
		maxChars: opts.maxChars,
	});
	const notebook = typeof opts.notebookText === 'string' && opts.notebookText.trim() !== ''
		? opts.notebookText.trim()
		: FALLBACK_NOTE_REFRESH;
	return {
		text: [
			'# 我的记事（自动带过来的）',
			'',
			'这是你之前几天的记事，一上来就带着，不用重新想一遍。',
			'',
			recall.text,
			'',
			'## 小记录（最近几笔）',
			'',
			notebook,
		].join('\n'),
		days: recall.days,
		used: recall.used,
	};
}

/**
 * 「按日期调取」的工具结果：带日期、条数，方便模型自己判断。
 * 工具输出刻意分为 title / text 两段，宿主渲染时好排版。
 */
export function describeDayRecall(store, day, opts = {}) {
	const r = recallDay(store, day, opts);
	const doc = store.readDiary(day);
	const count = doc === null ? 0 : (doc.entries ?? []).length;
	return {
		day,
		found: r.found,
		count,
		title: `${dayHeading(day)}：${count} 件事`,
		text: r.text,
	};
}

/** 最近几天（给工具的参数校验/展示用）。 */
export function recentDayKeys(today, count = DEFAULT_BOOTSTRAP_DAYS) {
	return lastDays(today, count);
}

export { todayKey, addDays };
