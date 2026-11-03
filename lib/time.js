// 时间与日期工具：纯函数，零依赖。
//
// 约定（整个插件只认这一套）：
//   - 日期键一律 "YYYY-MM-DD"，按**给定时区**换算，不是 UTC。
//   - 日期时间戳一律带偏移写成 "2026-11-02T19:09:01+08:00"，
//     这样人和别的工具（Chatbox、记事本）一眼能看懂，也不怕时区歧义。
//   - 除了显式传入 Date 的入口，其余都要求「今天」由调用方决定（params.today），
//     这样回放历史、跑测试都能复现，不会因为机器时钟变化而出不同的结果。

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

/** 本地时区 IANA 名（失败时退回 UTC）。 */
function localTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/** 时区名是否可用。传空 = 本地时区，永远视为可用。 */
export function isValidTimeZone(tz) {
	if (tz === undefined || tz === null || tz === '') return true;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: String(tz) });
		return true;
	} catch {
		return false;
	}
}

function zone(tz) {
	return tz === undefined || tz === null || tz === '' ? localTimeZone() : String(tz);
}

/** 格式化器缓存：构造 Intl.DateTimeFormat 相对贵，按「时区+选项」复用。 */
const formatters = new Map();
function formatter(tz, options) {
	const key = `${tz}\u0000${JSON.stringify(options)}`;
	let f = formatters.get(key);
	if (f === undefined) {
		f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz });
		formatters.set(key, f);
	}
	return f;
}

function partsOf(date, tz) {
	const f = formatter(tz, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	});
	const out = {};
	for (const p of f.formatToParts(date)) {
		if (p.type !== 'literal') out[p.type] = p.value;
	}
	return out;
}

/** 某个时刻在给定时区里的日期键。 */
export function dateKeyOf(date, tz) {
	const t = date instanceof Date ? date : new Date(date);
	if (Number.isNaN(t.getTime())) throw new Error(`不是合法时间：${String(date)}`);
	const p = partsOf(t, zone(tz));
	return `${p.year}-${p.month}-${p.day}`;
}

/** 某时区此刻的日期键。 */
export function todayKey(tz, now = new Date()) {
	return dateKeyOf(now, tz);
}

/** 某时区此刻的偏移（分钟，东八区 = 480）。 */
function offsetMinutes(date, tz) {
	const p = partsOf(date, tz);
	const asUtc = Date.UTC(
		Number(p.year),
		Number(p.month) - 1,
		Number(p.day),
		Number(p.hour),
		Number(p.minute),
		Number(p.second),
	);
	return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** "+08:00" 形式的偏移。 */
export function offsetString(date, tz) {
	const minutes = offsetMinutes(date instanceof Date ? date : new Date(date), zone(tz));
	const sign = minutes < 0 ? '-' : '+';
	const abs = Math.abs(minutes);
	const hh = String(Math.floor(abs / 60)).padStart(2, '0');
	const mm = String(abs % 60).padStart(2, '0');
	return `${sign}${hh}:${mm}`;
}

/** 带偏移的日期时间戳。 */
export function timestampOf(date, tz) {
	const t = date instanceof Date ? date : new Date(date);
	if (Number.isNaN(t.getTime())) throw new Error(`不是合法时间：${String(date)}`);
	const z = zone(tz);
	const p = partsOf(t, z);
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offsetString(t, z)}`;
}

/** 只取 "HH:mm"。 */
export function clockOf(date, tz) {
	const p = partsOf(date instanceof Date ? date : new Date(date), zone(tz));
	return `${p.hour}:${p.minute}`;
}

/** 校验日期键并拆出年月日。 */
export function parseDateKey(key) {
	const m = typeof key === 'string' ? DATE_KEY.exec(key.trim()) : null;
	if (m === null) throw new Error(`日期必须是 YYYY-MM-DD（收到：${JSON.stringify(key)}）`);
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	// 用 UTC 回读做存在性校验：2026-02-30 这种要拒掉，不能默默进位
	const probe = new Date(Date.UTC(year, month - 1, day));
	if (
		probe.getUTCFullYear() !== year ||
		probe.getUTCMonth() !== month - 1 ||
		probe.getUTCDate() !== day
	) {
		throw new Error(`这个日期不存在：${key}`);
	}
	return { year, month, day };
}

/** 日期键是否合法（不抛错版本）。 */
export function isDateKey(value) {
	try {
		parseDateKey(value);
		return true;
	} catch {
		return false;
	}
}

/** 日期键 +/- n 天。 */
export function addDays(key, delta) {
	const { year, month, day } = parseDateKey(key);
	const d = new Date(Date.UTC(year, month - 1, day + delta));
	return d.toISOString().slice(0, 10);
}

/** 两个日期键的差（b - a，单位天）。 */
export function daysBetween(a, b) {
	const x = parseDateKey(a);
	const y = parseDateKey(b);
	const ta = Date.UTC(x.year, x.month - 1, x.day);
	const tb = Date.UTC(y.year, y.month - 1, y.day);
	return Math.round((tb - ta) / DAY_MS);
}

/** 以 end 结尾、长度 count 的日期键列表（升序）。 */
export function lastDays(end, count) {
	if (!Number.isInteger(count) || count < 1) throw new Error(`天数必须是正整数（收到：${String(count)}）`);
	const out = [];
	for (let i = count - 1; i >= 0; i -= 1) out.push(addDays(end, -i));
	return out;
}

/** 同一时区里某个日期键的 00:00 对应时刻（毫秒）。 */
export function startOfDay(key, tz) {
	const { year, month, day } = parseDateKey(key);
	const z = zone(tz);
	const guess = Date.UTC(year, month - 1, day);
	// 先用 guess 猜偏移再修正；夏令时切换日也只需要一次修正
	const first = guess - offsetMinutes(new Date(guess), z) * 60000;
	return first - (offsetMinutes(new Date(first), z) * 60000 - offsetMinutes(new Date(guess), z) * 60000);
}

/**
 * 从"随手写的时刻"解析出带偏移的完整时间戳。
 *
 * 支持：
 *   空 / 只有 "HH:mm"        → 用今天（params.today）的日期
 *   "YYYY-MM-DD"             → 当天 00:00
 *   "YYYY-MM-DDTHH:mm[:ss]"  → 补秒，按给定时区算偏移
 *   带 Z 或 ±HH:MM 的完整串   → 原样换算到给定时区
 * 解析不了返回 null（由调用方决定是宽容还是报错）。
 */
export function normalizeTimestamp(input, { tz, today } = {}) {
	const z = zone(tz);
	const base = isDateKey(today) ? today : todayKey(z);
	if (input === undefined || input === null) return null;
	const raw = String(input).trim();
	if (raw === '') return null;
	const fillDate = (timePart) => {
		const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timePart);
		if (tm === null) return null;
		const hh = String(Math.min(23, Number(tm[1]))).padStart(2, '0');
		const mm = String(Math.min(59, Number(tm[2]))).padStart(2, '0');
		const ss = String(Math.min(59, Number(tm[3] ?? '0'))).padStart(2, '0');
		return `${base}T${hh}:${mm}:${ss}`;
	};
	let datePart = null;
	let timePart = null;
	if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
		const filled = fillDate(raw);
		if (filled === null) return null;
		return timestampWithOffset(filled, z);
	}
	const full = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(raw);
	if (full !== null) {
		datePart = full[1];
		timePart = full[2];
		if (full[3] !== undefined) {
			const t = new Date(raw.replace(' ', 'T'));
			if (Number.isNaN(t.getTime())) return null;
			return timestampOf(t, z);
		}
	} else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
		datePart = raw;
		timePart = '00:00:00';
	} else {
		const t = new Date(raw);
		if (Number.isNaN(t.getTime())) return null;
		return timestampOf(t, z);
	}
	if (!isDateKey(datePart)) return null;
	const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/.exec(timePart);
	if (tm === null) return null;
	const hh = String(Math.min(23, Number(tm[1]))).padStart(2, '0');
	const mm = String(Math.min(59, Number(tm[2]))).padStart(2, '0');
	const ss = String(Math.min(59, Number(tm[3] ?? '0'))).padStart(2, '0');
	return timestampWithOffset(`${datePart}T${hh}:${mm}:${ss}`, z);
}

/**
 * 把"墙上时间 + 时区"换成带偏移时间戳。
 * 先按 UTC 猜，再用真实偏移修正一次 —— 夏令时边界上也能对上。
 */
function timestampWithOffset(wallTime, tz) {
	const asUtc = new Date(`${wallTime}Z`);
	if (Number.isNaN(asUtc.getTime())) return null;
	let t = new Date(asUtc.getTime() - offsetMinutes(asUtc, tz) * 60000);
	t = new Date(asUtc.getTime() - offsetMinutes(t, tz) * 60000);
	// 如果修正把日期跨到别的日子（夏令时跳变），保留原写法，只补偏移
	const stamp = timestampOf(t, tz);
	const wall = stamp.slice(0, 19);
	return wall === wallTime ? stamp : `${wallTime}${stamp.slice(19)}`;
}

/** 时间戳里的日期部分（"YYYY-MM-DD"）；解析不了返回 null。 */
export function datePartOf(timestamp) {
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(timestamp ?? ''));
	return m === null ? null : m[1];
}

/** 时间戳排序键（毫秒）；解析不了返回 NaN。 */
export function epochOf(timestamp) {
	if (timestamp === undefined || timestamp === null) return Number.NaN;
	const t = new Date(String(timestamp));
	return t.getTime();
}

/** 本地化显示：2026-11-02 19:09。 */
export function humanTime(timestamp) {
	const s = String(timestamp ?? '');
	const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s);
	return m === null ? s : `${m[1]} ${m[2]}`;
}

/** 星期几（中文短名）。 */
export function weekdayCN(key) {
	const { year, month, day } = parseDateKey(key);
	const d = new Date(Date.UTC(year, month - 1, day));
	return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
}
