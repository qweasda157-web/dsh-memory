// 记忆库：按天存日记的读写。
//
// 目录布局：
//   <root>/.memory/diary/YYYY-MM-DD.json   当天的结构化内容（真源）
//   <root>/.memory/diary/YYYY-MM-DD.md     由 JSON 渲染出的人读版本
//   <root>/.memory/diary/index.json        机器索引（哪天有几条、什么时候改的）
//
// 设计取舍：
//   - JSON 是真源，md 是渲染产物。改 JSON 之后重画 md，反过来不成立。
//   - 一份记录里"一条条的事"共享同一个 id，重复写同一个 id 就是更新而不是追加。
//   - 所有写盘都走 writeFileAtomic（临时文件 + rename），避免写一半断电留下坏文件。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	readJsonSafe,
	writeFileAtomic,
	listFiles,
	ensureDir,
	createVault,
} from './paths.js';
import {
	ensureEpisodeId,
	fingerprint,
	normalizeEpisode,
	sortEpisodes,
} from './episode.js';
import { addDays, datePartOf, isDateKey, parseDateKey, todayKey } from './time.js';

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
const MARKER = ['tmp-', 'bak-'];

function emptyIndex(kind) {
	return { version: 1, kind, updatedAt: null, days: {} };
}

function indexOf(day) {
	return {
		count: Array.isArray(day.entries) ? day.entries.length : 0,
		editedAt: day.editedAt ?? null,
		fingerprint: day.fingerprint ?? null,
	};
}

/**
 * 一份按天存的记录集合。
 */
export class RecordSet {
	/**
	 * @param {object} opts
	 * @param {ReturnType<import('./paths.js').createVault>} opts.vault
	 * @param {'diary'} opts.kind
	 * @param {string} [opts.tz]
	 */
	constructor({ vault, kind, tz }) {
		if (kind !== 'diary') throw new Error(`未知记录类型：${kind}`);
		this.vault = vault;
		this.kind = kind;
		this.tz = tz;
		this.daysDir = vault.paths.diaryDays;
		this.indexFile = vault.paths.diaryIndex;
	}

	ensure() {
		ensureDir(this.vault.root, this.daysDir);
	}

	dayFile(day) {
		parseDateKey(day);
		return join(this.daysDir, `${day}.json`);
	}

	mdFile(day) {
		parseDateKey(day);
		return join(this.daysDir, `${day}.md`);
	}

	/** 读索引；没有就是空索引，坏了就报错（坏索引比空索引更值得人知道）。 */
	readIndex() {
		const r = readJsonSafe(this.indexFile);
		if (r.missing) return emptyIndex(this.kind);
		if (!r.ok) throw new Error(`${this.indexFile} 解析失败：${r.error?.message ?? '未知原因'}`);
		const idx = r.value;
		if (idx === null || typeof idx !== 'object' || typeof idx.days !== 'object' || idx.days === null) {
			throw new Error(`${this.indexFile} 结构不对：缺 days 对象`);
		}
		return { version: 1, kind: idx.kind ?? this.kind, updatedAt: idx.updatedAt ?? null, days: idx.days };
	}

	writeIndex(index) {
		this.ensure();
		const body = {
			version: 1,
			kind: index.kind ?? this.kind,
			updatedAt: index.updatedAt ?? null,
			days: index.days,
		};
		writeFileAtomic(this.indexFile, `${JSON.stringify(body, null, 2)}\n`);
	}

	/** 读某天；不存在返回 null，坏了抛错。 */
	readDay(day) {
		parseDateKey(day);
		const r = readJsonSafe(this.dayFile(day));
		if (r.missing) return null;
		if (!r.ok) throw new Error(`${this.dayFile(day)} 解析失败：${r.error?.message ?? '未知原因'}`);
		return r.value;
	}

	/** 磁盘上实际存在的日期（从 days/ 目录扫）。 */
	listDayFiles() {
		return listFiles(this.daysDir, DAY_FILE)
			.map((name) => name.slice(0, 10))
			.filter((d) => isDateKey(d))
			.sort();
	}

	/** 索引里登记的日期。 */
	indexedDays() {
		return Object.keys(this.readIndex().days).sort();
	}

	/** 磁盘与索引的差异，用来发现被删/被改。 */
	auditIndex() {
		const index = this.readIndex();
		const onDisk = this.listDayFiles();
		const files = new Set(onDisk);
		const indexed = new Set(Object.keys(index.days));
		const missingFiles = [...indexed].filter((d) => !files.has(d)).sort();
		const unindexed = [...files].filter((d) => !indexed.has(d)).sort();
		const mismatched = [];
		for (const d of onDisk) {
			if (!indexed.has(d)) continue;
			let fp = null;
			try {
				const day = this.readDay(d);
				fp = day !== null ? fingerprintOfDiary(day) : null;
			} catch {
				mismatched.push({ day: d, reason: '文件解析失败' });
				continue;
			}
			const recorded = index.days[d]?.fingerprint ?? null;
			if (recorded !== null && recorded !== fp) {
				mismatched.push({ day: d, reason: '内容变了' });
			}
		}
		return { onDisk, indexed: [...indexed].sort(), missingFiles, unindexed, mismatched };
	}

	writeDay(day, doc) {
		parseDateKey(day);
		this.ensure();
		writeFileAtomic(this.dayFile(day), `${JSON.stringify(doc, null, 2)}\n`);
		if (typeof doc.md === 'string' && doc.md !== '') {
			writeFileAtomic(this.mdFile(day), doc.md);
		}
		const index = this.readIndex();
		const kept = { ...doc };
		delete kept.md;
		index.days[day] = indexOf(kept);
		index.updatedAt = new Date().toISOString();
		index.kind = this.kind;
		this.writeIndex(index);
	}

	/** 所有日期：磁盘 ∪ 索引。 */
	allDays() {
		return [...new Set([...this.listDayFiles(), ...this.indexedDays()])].sort();
	}

	/** 最近 n 天里**有记录**的日期（升序）。 */
	recentDaysWithData(count, today, { maxLookbackDays = 90 } = {}) {
		const have = new Set(this.listDayFiles());
		const out = [];
		for (let i = 0; i < Math.max(count, maxLookbackDays) && out.length < count; i += 1) {
			const d = addDays(today, -i);
			if (have.has(d)) out.push(d);
		}
		return out.reverse();
	}

	/**
	 * 逐天找「满足条件」的日子。
	 * @param {string} today
	 * @param {string} [dir]
	 * @param {(day:string)=>boolean} match
	 * @param {number} [limit]
	 * @param {number} [maxLookbackDays]
	 */
	findDays(today, dir, match, limit = 10, maxLookbackDays = 400) {
		const out = [];
		const step = dir === 'forward' ? 1 : -1;
		for (let i = 0, d = today; i < maxLookbackDays && out.length < limit; i += 1, d = addDays(d, step)) {
			if (match(d)) out.push(d);
		}
		// 结果一律按日期升序返回，方便拼接
		return out.sort();
	}
}

/** 日记内容指纹（不含 md 文本，只含结构化条目）。 */
export function fingerprintOfDiary(day) {
	const parts = [];
	const entries = Array.isArray(day.entries) ? sortEpisodes(day.entries) : [];
	for (const e of entries) {
		parts.push(e.id, e.at, JSON.stringify(e.saw ?? []), JSON.stringify(e.left ?? []), JSON.stringify(e.actions ?? []), JSON.stringify(e.responses ?? []), e.notes ?? '', e.felt ?? '');
	}
	parts.push(day.overview ?? '');
	return fingerprint(parts);
}

/* ------------------------------------------------------------------ */
/* 组合：读写整库                                                     */
/* ------------------------------------------------------------------ */

function sortAndDedupe(entries) {
	const sorted = sortEpisodes(entries);
	const seen = new Set();
	return sorted.filter((e) => {
		if (seen.has(e.id)) return false;
		seen.add(e.id);
		return true;
	});
}

/** 按天分组（跨天的条目各回各家，而不是硬塞进某一天）。 */
function groupByDay(entries) {
	const map = new Map();
	for (const e of entries) {
		if (!map.has(e.day)) map.set(e.day, []);
		map.get(e.day).push(e);
	}
	return map;
}

/** 建一个记忆库（根默认进程 cwd）。 */
export function createMemory(vaultOptions) {
	return new MemoryStore(createVault(vaultOptions ?? {}));
}

/**
 * 记忆库门面：所有公开操作都在这里。
 */
export class MemoryStore {
	constructor(vault) {
		this.vault = vault;
		this.diary = new RecordSet({ vault, kind: 'diary' });
	}

	ensure() {
		this.vault.ensure();
		return this;
	}

	/**
	 * 往日记里追加条目（同一个 id 视为同一条，重复写就是更新）。
	 * @param {object[]} inputs - 原始条目
	 * @param {object} opts
	 * @param {string} opts.tz
	 * @param {string} opts.today
	 * @param {string} [opts.source]
	 * @param {string} [opts.author]
	 * @param {string} [opts.overview] - 某一天的概览（没有就沿用原来的）
	 * @returns {{written: string[], entries: object[]}}
	 */
	writeDiary(inputs, opts) {
		const list = Array.isArray(inputs) ? inputs : [inputs];
		const normalized = list.map((raw) =>
			ensureEpisodeId(normalizeEpisode(raw, { tz: opts.tz, today: opts.today, source: opts.source ?? 'agent', author: opts.author ?? '它' })),
		);
		const byDay = groupByDay(normalized);
		const written = [];
		for (const [day, entries] of byDay) {
			const existing = this.diary.readDay(day);
			const doc = existing ?? { version: 1, kind: 'diary', day, author: opts.author ?? '它', overview: '', entries: [], updatedAt: null };
			const map = new Map((doc.entries ?? []).map((e) => [e.id, e]));
			for (const e of entries) {
				if (map.has(e.id)) map.set(e.id, { ...map.get(e.id), ...e });
				else map.set(e.id, e);
			}
			doc.entries = sortAndDedupe([...map.values()]);
			const overview = typeof opts.overview === 'string' ? opts.overview.trim() : '';
			if (overview !== '') doc.overview = overview;
			doc.updatedAt = new Date().toISOString();
			doc.fingerprint = fingerprintOfDiary(doc);
			this.diary.writeDay(day, doc);
			written.push(day);
		}
		return { written: written.sort(), entries: normalized };
	}

	/** 读取日记的一天（不存在返回 null）。 */
	readDiaryDay(day) {
		return this.diary.readDay(day);
	}

	/** 回灌用的读取。刻意没有「offset」一类的参数，读到什么就是什么。 */
	readDiary(day) {
		const doc = this.diary.readDay(day);
		if (doc === null) return null;
		return { day: doc.day ?? day, entries: sortEpisodes(doc.entries ?? []), overview: doc.overview ?? '', author: doc.author ?? '它' };
	}

	/** 删掉日记里的一条（用于更正；不会自动触发文件回写 md）。 */
	removeDiaryEntry(day, id) {
		const doc = this.diary.readDay(day);
		if (doc === null) return false;
		const before = (doc.entries ?? []).length;
		doc.entries = (doc.entries ?? []).filter((e) => e.id !== id);
		if (doc.entries.length === before) return false;
		doc.updatedAt = new Date().toISOString();
		doc.fingerprint = fingerprintOfDiary(doc);
		this.diary.writeDay(day, doc);
		return true;
	}
}

export { addDays, todayKey, datePartOf, existsSync, MARKER };
