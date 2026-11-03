#!/usr/bin/env node
// dsh-memory 命令行：不经过 DSH 也能读写记忆库。
//
// 用法：
//   node dsh-memory/bin/remember.mjs bootstrap [--days 3] [--today 2026-11-02] [--tz Asia/Shanghai]
//   node dsh-memory/bin/remember.mjs recall --day 2026-11-02 | --day today | --last 3
//   node dsh-memory/bin/remember.mjs note --file 条目.json [--overview "那天..."] [--author 它]
//   node dsh-memory/bin/remember.mjs render --day 2026-11-02
//   node dsh-memory/bin/remember.mjs days
//
// 公共参数：--root <工作区>（默认当前目录）、--dir .memory、--tz、--today、--json
// 「现在」默认取真实时钟；--today 只影响"今天"的判定与缺口时间的补全，方便复现。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMemory } from '../lib/store.js';
import { renderDiaryDay } from '../lib/diary.js';
import { buildBootstrap, recallRecent, describeDayRecall } from '../lib/recall.js';
import { remember, resolveDayArg, redrawDiaryDay } from '../lib/write.js';
import { isDateKey, todayKey, isValidTimeZone } from '../lib/time.js';
import { displayPath } from '../lib/paths.js';

function fail(message) {
	process.stderr.write(`错误：${message}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token.startsWith('--')) {
			const key = token.slice(2);
			const next = argv[i + 1];
			if (key === 'json' || key === 'all' || key === 'replace' || key === 'quiet') {
				args[key] = true;
			} else if (next === undefined || next.startsWith('--')) {
				args[key] = true;
			} else {
				args[key] = next;
				i += 1;
			}
		} else {
			args._.push(token);
		}
	}
	return args;
}

function readJsonFile(file) {
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch (error) {
		fail(`读不到文件 ${file}：${error.message}`);
	}
	try {
		return JSON.parse(text.replace(/^\uFEFF/, ''));
	} catch (error) {
		fail(`${file} 不是合法 JSON：${error.message}`);
	}
}

/** 从文件里取出条目数组：允许裸数组，也允许 {entries:[...]} 这类包装。 */
function unwrap(fileValue, wrapperKeys, what) {
	if (Array.isArray(fileValue)) return { list: fileValue };
	if (fileValue !== null && typeof fileValue === 'object') {
		const key = wrapperKeys.find((k) => Array.isArray(fileValue[k]));
		if (key !== undefined) return { ...fileValue, list: fileValue[key] };
		fail(`${what}里有 ${wrapperKeys.join('/')} 字段但不是数组`);
	}
	fail(`${what}看起来不像条目：需要数组或 {${wrapperKeys.join('/')}: [...]} 形式（收到 ${typeof fileValue}）`);
	return null;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const command = args._[0];
	if (command === undefined || command === 'help' || args.help === true) {
		process.stdout.write(usage());
		return;
	}
	const root = resolve(typeof args.root === 'string' ? args.root : process.cwd());
	if (!isValidTimeZone(typeof args.tz === 'string' ? args.tz : undefined)) fail(`不合法的时区：${args.tz}`);
	const tz = typeof args.tz === 'string' ? args.tz : undefined;
	const today = typeof args.today === 'string' ? args.today : todayKey(tz);
	if (!isDateKey(today)) fail(`--today 必须是 YYYY-MM-DD（收到 ${args.today}）`);

	const store = createMemory({
		root,
		dir: typeof args.dir === 'string' ? args.dir : '.memory',
	});
	const ctx = { tz, today, store, root };

	let output;
	try {
		output = dispatch(command, args, ctx);
	} catch (error) {
		fail(error?.message ?? String(error));
	}
	if (output !== undefined) process.stdout.write(String(output).endsWith('\n') ? output : `${output}\n`);
}

function dispatch(command, args, ctx) {
	switch (command) {
		case 'bootstrap':
			return cmdBootstrap(args, ctx);
		case 'recall':
			return cmdRecall(args, ctx);
		case 'note':
			return cmdNote(args, ctx);
		case 'render':
			return cmdRender(args, ctx);
		case 'days':
			return cmdDays(args, ctx);
		default:
			fail(`不认识的命令：${command}\n\n${usage()}`);
	}
	return undefined;
}

function requireDay(args, ctx) {
	const raw = typeof args.day === 'string' ? args.day : undefined;
	if (raw === undefined) fail('这个命令需要 --day YYYY-MM-DD（也接受 today/昨天/前天）');
	const day = resolveDayArg(raw, { today: ctx.today, tz: ctx.tz });
	if (!isDateKey(day)) fail(`--day 必须是 YYYY-MM-DD（收到 ${raw}）`);
	return day;
}

function cmdBootstrap(args, ctx) {
	const days = Number(args.days ?? 3);
	const r = buildBootstrap(ctx.store, { days, today: ctx.today, tz: ctx.tz });
	if (args.json === true) return JSON.stringify(r, null, 2);
	return r.text;
}

function cmdRecall(args, ctx) {
	if (typeof args.last === 'string') {
		const r = recallRecent(ctx.store, { days: Number(args.last), today: ctx.today, tz: ctx.tz });
		if (args.json === true) return JSON.stringify(r, null, 2);
		return r.text;
	}
	const day = requireDay(args, ctx);
	const r = describeDayRecall(ctx.store, day, { today: ctx.today, tz: ctx.tz });
	if (args.json === true) return JSON.stringify(r, null, 2);
	return r.text;
}

function cmdNote(args, ctx) {
	if (typeof args.file !== 'string') fail('note 需要 --file 条目.json');
	const raw = readJsonFile(args.file);
	const unpacked = unwrap(raw, ['entries', 'items'], '条目文件');
	const overview = typeof args.overview === 'string' ? args.overview : raw?.overview;
	const r = remember(ctx.store, unpacked.list, {
		tz: ctx.tz,
		today: ctx.today,
		source: typeof args.source === 'string' ? args.source : 'agent',
		author: typeof args.author === 'string' ? args.author : '它',
		overview,
	});
	const files = r.files.map((x) => displayPath(ctx.root, x));
	if (args.json === true) return JSON.stringify({ ok: true, days: r.days, entries: r.entries.length, files }, null, 2);
	return `已记下 ${r.entries.length} 条，涉及日期：${r.days.join('、')}\n` +
		files.map((f) => `  更新了 ${f}`).join('\n');
}

function cmdRender(args, ctx) {
	const day = requireDay(args, ctx);
	const file = redrawDiaryDay(ctx.store, day, { tz: ctx.tz });
	if (file === null) fail(`${day} 没有日记`);
	const doc = ctx.store.readDiaryDay(day);
	return args.json === true ? JSON.stringify(doc, null, 2) : renderDiaryDay(doc, { tz: ctx.tz });
}

function cmdDays(args, ctx) {
	const diaryDays = ctx.store.diary.listDayFiles();
	if (args.json === true) return JSON.stringify({ diary: diaryDays }, null, 2);
	const lines = ['日记：', ...(diaryDays.length ? diaryDays.map((d) => `  ${d}`) : ['  （空）'])];
	return lines.join('\n');
}

function usage() {
	return `dsh-memory CLI —— 给 Agent 用的跨天记忆

命令：
  bootstrap [--days 3]          打印启动注入正文（最近 N 天）
  recall --day <日期>           打印某天的记事；或 --last 3
  note --file <条目.json>       写入条目（可带 --overview）
  render --day <日期>           按 json 重渲染那一天的 .md
  days                          列出记忆库里有哪些日子

公共参数：
  --root <工作区>  默认当前目录
  --dir .memory    记忆库目录（必须在工作区内）
  --tz <时区>      默认系统本地时区
  --today <日期>   覆盖"今天"（复现用）
  --json           输出 JSON
`;
}

main();
