// 最小可运行示例：用虚构数据跑通「写入 → 按日期读回」的完整流程。
//
// 跑法（在 dsh-memory 目录下）：
//   node examples/demo.mjs
//   node examples/demo.mjs --keep     # 保留 .demo 目录，方便自己点开看文件
//
// 它会在 examples/.demo/ 里建一个**独立的记忆库**（不是真的 .memory），
// 因此不会碰你自己的数据；跑完默认删掉。
//
// 覆盖的流程：
//   [1] 写下三天的日记（虚构数据）
//   [2] 按日期读回其中一天
//   [3] 启动注入最近三天（2026-11-04 为"今天"）
//   [4] 目录结构与文件长什么样
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createMemory } from '../lib/store.js';
import { buildBootstrap, describeDayRecall } from '../lib/recall.js';
import { remember } from '../lib/write.js';
import { fromFile } from './_fixtures.mjs';

const TZ = 'Asia/Shanghai';
const TODAY = '2026-11-04';
const DEMO_ROOT = fileURLToPath(new URL('./.demo/', import.meta.url));
const KEEP = process.argv.includes('--keep');

function hr(title) {
	console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);
}

if (existsSync(DEMO_ROOT)) rmSync(DEMO_ROOT, { recursive: true, force: true });
mkdirSync(DEMO_ROOT, { recursive: true });
const store = createMemory({ root: DEMO_ROOT, dir: '.memory' });

/* ---------------- [1] 写入 ---------------- */
hr('[1] 写下三天的日记（虚构数据）');

remember(store, fromFile('seed-1102.json'), { tz: TZ, today: TODAY, source: 'seed', author: '它' });
remember(store, fromFile('diary-1103.json'), {
	tz: TZ,
	today: TODAY,
	source: 'agent',
	author: '它',
	overview: '今天看了一个讲猫为什么会盯着墙角的视频，在底下留了条评论。',
});
remember(store, fromFile('diary-1104.json'), {
	tz: TZ,
	today: TODAY,
	source: 'agent',
	author: '它',
	overview: '今天看了几个视频，推荐里忽然全是猫。',
});

console.log('写入了这些日子：', store.diary.listDayFiles().join(', '));
assert.equal(store.diary.listDayFiles().length, 3, '应有 3 天记录');

const diary1103 = readFileSync(join(DEMO_ROOT, '.memory', 'diary', 'days', '2026-11-03.md'), 'utf8');
console.log('\n--- 2026-11-03.md（模型读到的就是这种文字）---');
console.log(diary1103);

/* ---------------- [2] 按日期读回 ---------------- */
hr('[2] 按日期读回：2026-11-03');
const day1103 = describeDayRecall(store, '2026-11-03', { today: TODAY, tz: TZ });
assert.equal(day1103.found, true, '11-03 应该有日记');
assert.equal(day1103.count, 3, '11-03 应有 3 条');
console.log(day1103.text);

/* ---------------- [3] 启动注入最近三天 ---------------- */
hr(`[3] 启动注入最近三天（今天是 ${TODAY}）`);
const boot = buildBootstrap(store, { days: 3, today: TODAY, tz: TZ });
assert.match(boot.text, /2026-11-02/, '注入应包含 11-02');
assert.match(boot.text, /2026-11-03/, '注入应包含 11-03');
assert.match(boot.text, /2026-11-04/, '注入应包含 11-04');
console.log(boot.text);

/* ---------------- [4] 目录结构 ---------------- */
hr('[4] 目录结构');
function tree(dir, prefix = '') {
	const items = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	items.forEach((it, i) => {
		const last = i === items.length - 1;
		console.log(`${prefix}${last ? '└─ ' : '├─ '}${it.name}`);
		if (it.isDirectory()) tree(join(dir, it.name), `${prefix}${last ? '   ' : '│  '}`);
	});
}
tree(DEMO_ROOT);
console.log('\n--- .memory/diary/days/2026-11-04.md ---');
console.log(readFileSync(join(DEMO_ROOT, '.memory', 'diary', 'days', '2026-11-04.md'), 'utf8'));
console.log('--- .memory/diary/days/2026-11-03.json（机器可读的真源）---');
console.log(readFileSync(join(DEMO_ROOT, '.memory', 'diary', 'days', '2026-11-03.json'), 'utf8').slice(0, 900));

hr('全部断言通过');
if (KEEP) {
	console.log(`保留示例目录：${DEMO_ROOT}`);
} else {
	rmSync(DEMO_ROOT, { recursive: true, force: true });
	console.log('已清理示例目录（加 --keep 可保留）');
}
