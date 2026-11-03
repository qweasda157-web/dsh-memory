// 把一天的事写成**第一人称日记**。
//
// 这一层只做一件事：把结构化 episode 翻成读起来像"我那天干了什么"的自然语言。
// 硬规则（每条都有理由）：
//   - 主语是"我"，不出现"记录""操作""日志""执行"这类监控腔词；
//   - 时间点只保留"HH:mm"，不写时区、不写毫秒、不写 UTC；
//   - 没有的事就不写 —— 不编造感受，felt 为空就不输出"心里"那一段；
//   - 顺序严格按时间戳排。
import { clockOf, humanTime, weekdayCN, dateKeyOf } from './time.js';

function ensurePeriod(sentence) {
	const s = sentence.trim();
	if (s === '') return '';
	return /[。！？…~～]$/.test(s) ? s : `${s}。`;
}

function wherePhrase(item, fallbackWhere) {
	const where = item.where ?? fallbackWhere;
	return where === undefined || where === null || where === '' ? '' : String(where);
}

function linkTag(item) {
	if (typeof item.link === 'string' && item.link !== '') return `（${item.link}）`;
	return '';
}

function describeSaw(item, fallbackWhere) {
	const where = wherePhrase(item, fallbackWhere);
	let main = item.what !== '' ? item.what : '一些东西';
	// 不写"我在评论区看到了评论区里…"这种叠词：正文开头的场景词在前半句已经出现过了。
	// 注意正文可能只以场景词结尾（"《X》的评论区里关于…"），所以按「正文以场景的尾巴开头」判断。
	const redundant = where !== '' && main.includes(where);
	const tail = where === '' ? '' : (where.split(/的/).pop() ?? '');
	if (tail !== '' && main.startsWith(tail)) {
		// 「我在《X》的评论区」+「评论区里关于…」→ 把后一个场景词去掉
		main = main.slice(tail.length).replace(/^[里中]/, '');
	}
	const alreadySaw = main.startsWith('看到');
	let s = where === '' || redundant || alreadySaw ? `我看到${main}` : `我在${where}看到了${main}`;
	if (item.author) s += `（${String(item.author).replace(/^，/, '，作者 ')}）`;
	if (item.notes) s += `，${item.notes}`;
	return ensurePeriod(`${s}${linkTag(item)}`);
}

function describeLeft(item, fallbackWhere) {
	const action = String(item.notes ?? '').trim();
	if (action !== '') {
		// 这里的"留下"是动作：没有回他 / 删掉了那条评论 / 只点了个赞。
		// 这些片段常常是"没有回他"这种没有主语的写法，补一个"我"读起来才完整。
		const sentence = /^(我|自己)/.test(action) ? action : `我${action}`;
		return ensurePeriod(sentence + linkTag(item));
	}
	const where = wherePhrase(item, fallbackWhere);
	const what = item.what !== '' ? item.what : '一点东西';
	// 「一条评论」这种泛指的"留下"，同一条里通常还会跟一句具体留了什么，这里就不重复了
	if (/^(一条|一条条|个|一个)?(评论|回复|留言)$/.test(what)) return '';
	const redundant = where !== '' && what.includes(where);
	let s = where === '' || redundant ? `我留下了${what}` : `我在${where}留下了${what}`;
	return ensurePeriod(`${s}${linkTag(item)}`);
}

function describeAction(action) {
	const kind = action.kind ?? '其他';
	const target = action.target ?? '';
	const detail = action.detail ?? '';
	let head;
	if (kind === '其他') {
		head = detail !== '' ? detail : target;
		return ensurePeriod(head);
	}
	if (kind === '点赞') head = target === '' ? '我点了个赞' : `我给${target}点了个赞`;
	else if (kind === '投币') head = target === '' ? '我投了个币' : `我给${target}投了币`;
	else if (kind === '收藏') head = target === '' ? '我收藏了点东西' : `我收藏了${target}`;
	else if (kind === '发视频') head = target === '' ? '我发了个视频' : `我发了视频《${target}》`;
	else if (kind === '打开页面') head = target === '' ? '我翻到了一个页面' : `我翻到了${target}`;
	else if (kind === '观看') head = target === '' ? '我看了一会儿' : `我看了${target}`;
	else if (kind === '搜索') head = target === '' ? '我搜了点东西' : `我搜了${target}`;
	else if (kind === '关注') head = target === '' ? '我关注了一个人' : `我关注了${target}`;
	else if (kind === '评论') head = target === '' ? '我留了条评论' : `我在${target}下面留了条评论`;
	else if (kind === '回复') head = target === '' ? '我回了句话' : `我回了${target}`;
	else if (kind === '私信') head = target === '' ? '我发了条私信' : `我给${target}发了条私信`;
	else head = target === '' ? `我${kind}` : `我${kind}了${target}`;
	if (detail !== '') {
		// 「观看」这类动作的 detail 是发生了什么，不是正文，所以不套引号
		if (kind === '观看' || kind === '打开页面' || kind === '搜索' || kind === '回复' || kind === '关注') {
			head += `（${detail}）`;
		} else {
			head += `，写的是：「${detail}」`;
		}
	}
	return ensurePeriod(head + linkTag(action));
}

function describeResponse(action) {
	const kind = action.kind ?? '其他';
	const target = action.target ?? '';
	const detail = action.detail ?? '';
	let head;
	if (kind === '回复' || kind === '评论') {
		head = target === '' ? `有人回了句「${detail}」` : `${target}回了句「${detail}」`;
	} else if (kind === '点赞') head = target === '' ? '有人给我点了赞' : `${target}给我点了赞`;
	else if (kind === '踩' || kind === '举报') head = `${target === '' ? '有人' : target}给了我一个${kind}`;
	else if (kind === '关注') head = `${target === '' ? '有人' : target}关注了我`;
	else if (kind === '私信') head = `${target === '' ? '有人' : target}给我发了私信${detail === '' ? '' : `：「${detail}」`}`;
	else if (kind === '投币') head = `${target === '' ? '有人' : target}给我投了币`;
	else if (kind === '推荐变化') head = detail === '' ? '我那边的推荐好像变了' : `推荐里${detail}`;
	else if (kind === '限流迹象') head = detail === '' ? '我感觉自己有点被限流了' : `我感觉有点被限流：${detail}`;
	else if (kind === '无回应') head = '等了半天，没什么人理会';
	else head = detail !== '' ? `${kind}：${detail}` : `${kind}${target === '' ? '' : `（${target}）`}`;
	return ensurePeriod(head + (action.link ? `（${action.link}）` : ''));
}

/** 把一条 episode 写成若干句（不含时间戳）。 */
export function renderEpisodeSentences(episode, fallbackWhere = 'B站') {
	const lines = [];
	for (const item of episode.saw ?? []) {
		const s = describeSaw(item, fallbackWhere);
		if (s !== '') lines.push(s);
	}
	if (episode.sawNote) lines.push(ensurePeriod(episode.sawNote));
	for (const item of episode.left ?? []) {
		const s = describeLeft(item, fallbackWhere);
		if (s !== '') lines.push(s);
	}
	if (episode.leftNote) lines.push(ensurePeriod(episode.leftNote));
	for (const action of episode.actions ?? []) {
		const s = describeAction(action);
		if (s !== '') lines.push(s);
	}
	if (episode.actionsNote) lines.push(ensurePeriod(episode.actionsNote));
	for (const action of episode.responses ?? []) {
		const s = describeResponse(action);
		if (s !== '') lines.push(s);
	}
	if (episode.notes) lines.push(ensurePeriod(episode.notes));
	if (episode.felt) lines.push(`当时心里：${ensurePeriod(episode.felt)}`);
	return lines;
}

/** 空内容条目（只有时间、没有任何描述）—— 渲染时给个中性句子，避免出现空白行。 */
function fallbackSentence(episode) {
	if (episode.felt) return `那时候我心里：${ensurePeriod(episode.felt)}`;
	return '这一段没留下什么特别的印象。';
}

/**
 * 渲染单条 episode 的一行：**HH:mm 句子**。
 * @param {object} episode
 * @param {object} [opts]
 * @param {string} [opts.tz] - 用来把时间戳换成本地钟点
 * @param {string} [opts.where] - 场景名，默认 B站
 */
export function renderEpisodeLine(episode, opts = {}) {
	const tz = opts.tz;
	const clock = tz === undefined ? (/(\d{2}:\d{2})/.exec(String(episode.at).slice(11)) ?? [])[1] : clockOf(episode.at, tz);
	const sentences = renderEpisodeSentences(episode, opts.where);
	const body = sentences.length > 0 ? sentences.join('') : fallbackSentence(episode);
	return `- ${clock ?? '--:--'} ${body}`;
}

/** 一天的标题行：2026-11-02（周一）。 */
export function dayHeading(day) {
	return `${day}（${weekdayCN(day)}）`;
}

/**
 * 渲染一整天的日记。
 * @param {object} day - day 文档
 * @param {object} [opts]
 * @param {string} [opts.tz]
 * @param {string} [opts.where]
 * @param {boolean} [opts.withHeading] - 是否带日期标题（多天拼接时每段都要）
 * @param {string} [opts.title] - 覆盖默认标题
 * @returns {string}
 */
export function renderDiaryDay(day, opts = {}) {
	const lines = [];
	const hasOverview = typeof day.overview === 'string' && day.overview.trim() !== '';
	if (opts.withHeading !== false) {
		lines.push(`## ${opts.title ?? dayHeading(day.day)}`);
	}
	if (hasOverview) {
		lines.push('');
		lines.push(`那天大概是这样：${ensurePeriod(day.overview.trim())}`);
	}
	const entries = Array.isArray(day.entries) ? day.entries : [];
	if (entries.length > 0) {
		lines.push('');
		for (const entry of entries) lines.push(renderEpisodeLine(entry, opts));
	} else if (!hasOverview) {
		lines.push('');
		lines.push('- 这天好像没留下什么记录。');
	}
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * 把多天日记拼成一段「回灌正文」。
 * 只在**最早那天开始之前**加一句开场，不从第二天起重复。
 */
export function renderDiaryDays(days, opts = {}) {
	const list = days.filter((d) => d !== null && d !== undefined);
	if (list.length === 0) return '';
	const blocks = list.map((d) => renderDiaryDay(d, { ...opts, withHeading: true }));
	return blocks.join('\n\n');
}

/** 日期键的显示：今天 / 昨天 / 前天，其余原样。 */
export function relativeDayName(day, today) {
	if (day === today) return '今天';
	const t = Date.parse(`${today}T00:00:00Z`);
	const d = Date.parse(`${day}T00:00:00Z`);
	if (!Number.isFinite(t) || !Number.isFinite(d)) return day;
	const diff = Math.round((t - d) / 86400000);
	if (diff === 1) return '昨天';
	if (diff === 2) return '前天';
	if (diff < 0) return `之后（${day}）`;
	return `${diff} 天前（${day}）`;
}

export { humanTime, dateKeyOf };
