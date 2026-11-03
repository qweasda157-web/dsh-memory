// 测试：数据结构逻辑 + 红线自检。
//
//   node dsh-memory/test/verify.mjs
//
// 不依赖任何测试框架，跑完输出一行行 ok / FAIL，全部通过才退出码 0。
// 每个用例都在系统临时目录里建自己的库，互不干扰，跑完删干净。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('../', import.meta.url));
const imp = (p) => import(pathToFileURL(join(HERE, p)).href);

const { createMemory } = await imp('lib/store.js');
const { renderDiaryDay } = await imp('lib/diary.js');
const { buildBootstrap, recallDay, recallRecent } = await imp('lib/recall.js');
const { remember, resolveDayArg } = await imp('lib/write.js');
const { createRuntime, inject, registerTools, apply, resolveConfig } = await imp('index.js');
const time = await imp('lib/time.js');
const paths = await imp('lib/paths.js');

const TZ = 'Asia/Shanghai';
let pass = 0;
const failures = [];
const temps = [];
const pending = [];

function ok(label) {
	pass += 1;
	console.log(`ok   ${label}`);
}
function test(label, fn) {
	try {
		const maybe = fn();
		if (maybe !== null && typeof maybe === 'object' && typeof maybe.then === 'function') {
			pending.push(
				maybe.then(
					() => ok(label),
					(error) => {
						failures.push({ label, error });
						console.log(`FAIL ${label}\n     ${error?.message ?? error}`);
					},
				),
			);
			return;
		}
		ok(label);
	} catch (error) {
		failures.push({ label, error });
		console.log(`FAIL ${label}\n     ${error?.message ?? error}`);
	}
}
function tempRoot() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'));
	temps.push(dir);
	return dir;
}
function noBom(file) {
	const buf = readFileSync(file);
	assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${file} 带 BOM`);
	const text = buf.toString('utf8');
	assert.notEqual(text.charCodeAt(0), 0xfeff, `${file} 以 U+FEFF 开头`);
}

/* ================= 时间与日期 ================= */
console.log('\n-- 时间与日期 --');
test('dateKeyOf 按给定时区切天（北京时间凌晨属于当天）', () => {
	const d = new Date('2026-11-02T16:30:00Z'); // = 11-03 00:30 +08:00
	assert.equal(time.dateKeyOf(d, TZ), '2026-11-03');
	assert.equal(time.dateKeyOf(d, 'UTC'), '2026-11-02');
});
test('timestampOf 带 ±HH:MM 偏移', () => {
	assert.equal(time.timestampOf(new Date('2026-11-02T11:09:01Z'), TZ), '2026-11-02T19:09:01+08:00');
	assert.equal(time.timestampOf(new Date('2026-11-02T11:09:01Z'), 'UTC'), '2026-11-02T11:09:01+00:00');
});
test('parseDateKey 拒绝不存在的日期', () => {
	assert.throws(() => time.parseDateKey('2026-02-30'), /不存在/);
	assert.throws(() => time.parseDateKey('2026-13-01'), /不存在/);
	assert.throws(() => time.parseDateKey('26-1-1'), /YYYY-MM-DD/);
});
test('lastDays / addDays 跨月跨年', () => {
	assert.deepEqual(time.lastDays('2026-03-01', 3), ['2026-02-27', '2026-02-28', '2026-03-01']);
	assert.equal(time.addDays('2026-12-31', 1), '2027-01-01');
	assert.equal(time.daysBetween('2026-11-02', '2026-11-05'), 3);
});
test('normalizeTimestamp：HH:mm 补当天、跨天写全、带偏移换算', () => {
	assert.equal(time.normalizeTimestamp('19:09', { tz: TZ, today: '2026-11-02' }), '2026-11-02T19:09:00+08:00');
	assert.equal(time.normalizeTimestamp('2026-11-01T23:30', { tz: TZ, today: '2026-11-02' }), '2026-11-01T23:30:00+08:00');
	assert.equal(time.normalizeTimestamp('2026-11-01T20:00:00Z', { tz: TZ, today: '2026-11-02' }), '2026-11-02T04:00:00+08:00');
	assert.equal(time.normalizeTimestamp('', { tz: TZ, today: '2026-11-02' }), null);
});

/* ================= 路径守门员 ================= */
console.log('\n-- 路径守门员（红线：只写工作区内）--');
test('相对路径 .. 越界被拒', () => {
	const root = tempRoot();
	assert.throws(() => paths.resolveInside(root, '../outside.json'), /之外/);
	assert.throws(() => paths.resolveInside(root, join('..', 'x', 'y.json')), /之外/);
});
test('绝对路径越界被拒', () => {
	const root = tempRoot();
	const outside = isAbsolute(tmpdir()) ? join(tmpdir(), 'nope-xyz.json') : 'C:\\nope-xyz.json';
	assert.throws(() => paths.resolveInside(root, outside), /之外/);
});
test('根内的绝对路径放行', () => {
	const root = tempRoot();
	const inside = join(root, 'ok.json');
	assert.equal(paths.resolveInside(root, inside), resolve(inside));
});
test('createVault 的 dir 也不能越界', () => {
	const root = tempRoot();
	assert.throws(() => createMemory({ root, dir: '..\\..\\escape' }), /之外/);
});
test('写出的每个文件都在根内', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(store, [{ time: '10:00', saw: ['一个视频'], actions: [{ kind: '点赞' }] }], { tz: TZ, today: '2026-11-02' });
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			assert.ok(paths.isInside(root, full), `${full} 跑出根目录了`);
			if (entry.isDirectory()) walk(full);
		}
	};
	walk(root);
});

/* ================= 写入 → 按日期读回 ================= */
console.log('\n-- 写入 → 按日期读回 --');
test('写两天，按日期能分别读回，且不串天', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(store, [{ time: '09:00', saw: ['早上的东西'] }], { tz: TZ, today: '2026-11-02' });
	remember(store, [{ time: '21:00', saw: ['晚上的东西'] }], { tz: TZ, today: '2026-11-03' });
	const d1 = recallDay(store, '2026-11-02', { tz: TZ });
	const d2 = recallDay(store, '2026-11-03', { tz: TZ });
	assert.ok(d1.text.includes('早上的东西'));
	assert.ok(!d1.text.includes('晚上的东西'));
	assert.ok(d2.text.includes('晚上的东西'));
	assert.ok(!d2.text.includes('早上的东西'));
});
test('一条跨天时间被分到正确的那天', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(store, [{ time: '2026-11-01T23:59', saw: ['昨晚的事'] }], { tz: TZ, today: '2026-11-03' });
	assert.ok(recallDay(store, '2026-11-01', { tz: TZ }).text.includes('昨晚的事'));
	assert.equal(recallDay(store, '2026-11-03', { tz: TZ }).found, false);
});
test('只有 HH:mm 但带 id 前缀的条目回到 id 那天', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(store, [{ id: '20261101-203000-ab12', time: '20:30', saw: ['补写的历史'] }], { tz: TZ, today: '2026-11-03' });
	assert.ok(recallDay(store, '2026-11-01', { tz: TZ }).text.includes('补写的历史'));
});
test('缺的那天返回 found=false 而不是抛错', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	const r = recallDay(store, '2020-01-01', { tz: TZ });
	assert.equal(r.found, false);
	assert.match(r.text, /没有留下什么记录/);
});
test('同一天追加写入是累加，不是覆盖', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(store, [{ time: '09:00', saw: ['第一件'] }], { tz: TZ, today: '2026-11-02' });
	remember(store, [{ time: '18:00', saw: ['第二件'] }], { tz: TZ, today: '2026-11-02' });
	const doc = store.readDiaryDay('2026-11-02');
	assert.equal(doc.entries.length, 2);
	assert.deepEqual(doc.entries.map((e) => e.at.slice(11, 16)), ['09:00', '18:00'], '应按时间排序');
});
test('同一条（同 id）重复写是更新，不会变两条', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(store, [{ id: '20261102-100000-aaaa', time: '10:00', saw: ['原样'] }], { tz: TZ, today: '2026-11-02' });
	remember(store, [{ id: '20261102-100000-aaaa', time: '10:00', saw: ['改过的'] }], { tz: TZ, today: '2026-11-02' });
	const doc = store.readDiaryDay('2026-11-02');
	assert.equal(doc.entries.length, 1);
	assert.equal(doc.entries[0].saw[0].what, '改过的');
});
test('非法输入整体拒绝，日记不受影响', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	assert.throws(
		() => remember(store, [{ time: '09:00', saw: ['好的'] }, { time: 'bad-time', saw: ['坏的'] }], { tz: TZ, today: '2026-11-02' }),
	);
	assert.equal(store.readDiaryDay('2026-11-02'), null, '一条不合法就一条都不写');
});
test('未知字段会报错（防止拼错字段名被静默丢掉）', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	assert.throws(() => remember(store, [{ time: '09:00', saww: ['拼错了'] }], { tz: TZ, today: '2026-11-02' }), /不认识的字段/);
});

/* ================= 启动注入 ================= */
console.log('\n-- 启动注入最近三天 --');
test('注入含最近三天，从早到晚', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	for (const day of ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']) {
		remember(store, [{ time: '12:00', saw: [`${day} 的事`] }], { tz: TZ, today: day });
	}
	const boot = buildBootstrap(store, { days: 3, today: '2026-11-03', tz: TZ });
	const order = ['2026-11-01', '2026-11-02', '2026-11-03'].map((d) => boot.text.indexOf(d));
	assert.ok(order.every((i) => i >= 0), '三天都在');
	assert.deepEqual([...order].sort((a, b) => a - b), order, '顺序应为升序');
	assert.ok(!boot.text.includes('2026-10-31 的事'), '第四天之前的不该出现');
});
test('中间有一天没记录，也保留那一天并说明空白', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(store, [{ time: '12:00', saw: ['周五的事'] }], { tz: TZ, today: '2026-11-06' });
	remember(store, [{ time: '12:00', saw: ['周日的事'] }], { tz: TZ, today: '2026-11-08' });
	const boot = buildBootstrap(store, { days: 3, today: '2026-11-08', tz: TZ });
	assert.ok(boot.text.includes('2026-11-06'));
	assert.ok(boot.text.includes('2026-11-07'));
	assert.match(boot.text, /2026-11-07（周六）[\s\S]*?没有留下什么记录/);
});
test('注入正文有硬上限，超了先丢最早的', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) {
		remember(store, Array.from({ length: 30 }, (_, i) => ({ time: `1${i % 10}:00`, saw: [`很长的内容 `.repeat(20)] })), { tz: TZ, today: day });
	}
	const boot = buildBootstrap(store, { days: 3, today: '2026-11-03', tz: TZ, maxChars: 3000 });
	assert.ok(boot.text.length < 3400, `长度 ${boot.text.length} 应在上限附近`);
	assert.equal(boot.days[0], '2026-11-03', '最近的一天一定保留');
});

/* ================= 日记读起来像人话 ================= */
console.log('\n-- 日记读起来像人话（渲染回归）--');

test('「left.notes 是动作」时补主语，不出现"留下了没有回他"', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(
		store,
		[{ time: '20:46', saw: [{ what: '有人在我的评论下面回了一句', where: '评论区' }], left: [{ where: '评论区', notes: '没有回他' }] }],
		{ tz: TZ, today: '2026-11-03' },
	);
	const md = readFileSync(store.diary.mdFile('2026-11-03'), 'utf8');
	assert.ok(!md.includes('留下了没有回他'), `不应出现残缺句：${md}`);
	assert.ok(md.includes('我没有回他'), `应补上主语：${md}`);
});

test('场景词不重复：「评论区」不会渲染成"评论区看到了评论区里"', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(
		store,
		[{ time: '20:30', saw: [{ what: '评论区里关于“墙里的老鼠”的争论', where: '《某视频》的评论区' }] }],
		{ tz: TZ, today: '2026-11-03' },
	);
	const md = readFileSync(store.diary.mdFile('2026-11-03'), 'utf8');
	assert.ok(!md.includes('评论区里关于“墙里'), `场景词应被吃掉一次：${md}`);
	assert.ok(md.includes('关于“墙里的老鼠”的争论'), `正文应保留：${md}`);
});

test('已经带"我"的动作不会变成"我我"', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(store, [{ time: '10:00', left: [{ where: 'B站', notes: '我把那条评论删掉了' }] }], { tz: TZ, today: '2026-11-03' });
	const md = readFileSync(store.diary.mdFile('2026-11-03'), 'utf8');
	assert.ok(!md.includes('我我'), `不应重复主语：${md}`);
	assert.ok(md.includes('我把那条评论删掉了'));
});

/* ================= 编码 ================= */
console.log('\n-- UTF-8 无 BOM --');
test('写出的所有文件都是 UTF-8 无 BOM', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(store, [{ time: '10:00', saw: ['中文内容'], felt: '心里话' }], { tz: TZ, today: '2026-11-02', overview: '概览' });
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.push(full);
		}
	};
	walk(root);
	// 写一天日记会产出三个文件：当天的 json、当天的 md、以及索引
	assert.equal(files.length, 3, `应产出 3 个文件，实际 ${files.length}`);
	for (const f of files) noBom(f);
});
test('故意带 BOM 的输入会被剥掉', () => {
	const root = tempRoot();
	const store = createMemory({ root });
	remember(store, [{ time: '10:00', notes: `\uFEFF正文` }], { tz: TZ, today: '2026-11-02' });
	const f = store.diary.mdFile('2026-11-02');
	noBom(f);
});

/* ================= 插件外壳（按已核实的宿主 API）================= */
console.log('\n-- 插件外壳：systemPrompt 注入 / tools 注册 / 降级 --');

/** 造一个宿主形状的 ctx：get() 只认已注册的服务，读未声明的属性会抛 —— 和 Cordis 一样。 */
function makeHost({ services = {}, now } = {}) {
	const registered = [];
	const sections = [];
	const ctx = {
		logger: { warn() {}, info() {}, error() {} },
		get(n) {
			if (!(n in services)) throw new Error(`cannot get property "${n}" without inject`);
			return services[n];
		},
		effect(fn) {
			fn();
			return () => {};
		},
		once() {},
	};
	if (services.tools === undefined) {
		services.tools = { register(def) { registered.push(def); return () => { const i = registered.indexOf(def); if (i >= 0) registered.splice(i, 1); }; } };
	}
	if (services.systemPrompt === undefined) {
		services.systemPrompt = {
			section(def) {
				sections.push(def);
				return () => { const i = sections.indexOf(def); if (i >= 0) sections.splice(i, 1); };
			},
		};
	}
	return { ctx, services, registered, sections, now };
}

test('inject 只声明 tools（systemPrompt 靠探测，不写进硬依赖）', () => {
	assert.deepEqual(inject, ['tools']);
});

test('apply() 把日记挂成系统提示的一段：name/order/interpolate/text 都是函数', () => {
	const root = tempRoot();
	const host = makeHost({ now: () => new Date('2026-11-02T03:00:00Z') });
	const store = createMemory({ root });
	remember(store, [{ time: '10:00', saw: ['挂上去的内容'] }], { tz: TZ, today: time.dateKeyOf(new Date('2026-11-02T03:00:00Z'), TZ) });
	apply(host.ctx, { root, tz: TZ });
	assert.equal(host.sections.length, 1, '应注册且只注册一段');
	const def = host.sections[0];
	assert.equal(def.name, 'memory');
	assert.equal(def.order, 900);
	assert.equal(def.interpolate, false);
	assert.equal(typeof def.text, 'function', 'text 必须是函数，宿主每轮调用');
	assert.match(def.text(), /挂上去的内容/);
});

test('text() 每轮重算：刚写下的事下一轮就出现在注入里', () => {
	const root = tempRoot();
	const host = makeHost({ now: () => new Date('2026-11-02T03:00:00Z') });
	apply(host.ctx, { root, tz: TZ });
	const before = host.sections[0].text();
	assert.ok(!before.includes('刚刚写的'));
	// 模拟它在同一轮之后写了日记
	const store = createMemory({ root });
	remember(store, [{ time: '10:00', saw: ['刚刚写的'] }], { tz: TZ, today: time.dateKeyOf(new Date('2026-11-02T03:00:00Z'), TZ) });
	assert.match(host.sections[0].text(), /刚刚写的/);
});

test('跨天不会被缓存在昨天：换了时钟，注入正文跟着换', () => {
	const root = tempRoot();
	let clock = new Date('2026-11-02T03:00:00Z'); // 11-02 11:00 +08:00
	const host = makeHost({ now: () => clock });
	const day = time.dateKeyOf(clock, TZ);
	const store = createMemory({ root });
	remember(store, [{ time: '10:00', saw: ['第一天的事'] }], { tz: TZ, today: day });
	const runtime = createRuntime({ root, tz: TZ }, { now: () => clock });
	const first = runtime.bootstrap();
	assert.match(first, new RegExp(day));
	clock = new Date('2026-11-03T03:00:00Z'); // 第二天
	const second = runtime.bootstrap();
	assert.notEqual(first, second, '第二天必须重算，不能返回昨天的缓存');
	assert.match(second, /2026-11-03/);
	void host;
});

test('宿主没有 systemPrompt → 静默降级，工具照常可用', async () => {
	const root = tempRoot();
	const host = makeHost({ now: () => new Date('2026-11-02T03:00:00Z') });
	delete host.services.systemPrompt;
	// 把 get 改成"没有这个服务"
	const get = host.ctx.get;
	host.ctx.get = (n) => {
		if (n === 'systemPrompt') return undefined;
		return get.call(host.ctx, n);
	};
	assert.doesNotThrow(() => apply(host.ctx, { root, tz: TZ }));
	assert.equal(host.sections.length, 0, '不该凭空注册注入段');
	assert.equal(host.registered.length, 1, '工具仍应注册');
	const got = await host.registered[0].execute({ day: 'today' });
	assert.equal(typeof got.text, 'string');
});

test('宿主没有 tools → 只注入，不抛', () => {
	const root = tempRoot();
	const host = makeHost({ now: () => new Date('2026-11-02T03:00:00Z') });
	host.ctx.get = (n) => {
		if (n === 'tools') return undefined;
		if (n === 'systemPrompt') return host.services.systemPrompt;
		throw new Error('unknown');
	};
	assert.doesNotThrow(() => apply(host.ctx, { root, tz: TZ }));
	assert.equal(host.sections.length, 1);
});

test('服务探测遇到抛错也当"没有"，不把 apply() 拖垮', () => {
	const root = tempRoot();
	const ctx = {
		logger: { warn() {} },
		get() {
			throw new Error('cannot get property without inject');
		},
	};
	assert.doesNotThrow(() => apply(ctx, { root, tz: TZ }));
});

test('systemPrompt.section 抛错时，apply() 仍不抛且工具已注册', () => {
	const root = tempRoot();
	const host = makeHost();
	host.services.systemPrompt = { section() { throw new Error('bad section'); } };
	assert.doesNotThrow(() => apply(host.ctx, { root, tz: TZ }));
	assert.equal(host.registered.length, 1);
});

test('text() 内部出错返回空串，不能拖垮宿主一轮对话', () => {
	const root = tempRoot();
	const host = makeHost();
	apply(host.ctx, { root, tz: TZ });
	const def = host.sections[0];
	// 把库目录删掉，模拟磁盘问题
	rmSync(join(root, '.memory'), { recursive: true, force: true });
	let out;
	assert.doesNotThrow(() => {
		out = def.text();
	});
	assert.equal(typeof out, 'string');
});

test('注销：effect 清理后注入段与工具都撤掉', () => {
	const root = tempRoot();
	const host = makeHost();
	let dispose = null;
	host.ctx.effect = (fn) => {
		dispose = fn();
		return () => {};
	};
	apply(host.ctx, { root, tz: TZ });
	assert.equal(host.sections.length, 1);
	assert.equal(host.registered.length, 1);
	dispose();
	assert.equal(host.sections.length, 0);
	assert.equal(host.registered.length, 0);
});

test('enabled=false 时什么都不注册', () => {
	const root = tempRoot();
	const host = makeHost();
	apply(host.ctx, { root, tz: TZ, enabled: false });
	assert.equal(host.sections.length, 0);
	assert.equal(host.registered.length, 0);
});

test('非法配置不抛错，回落默认值并记录问题', () => {
	const root = tempRoot();
	const { config, problems } = resolveConfig({ bootstrapDays: 999, tz: 'Mars/Base', order: 'abc' }, {});
	assert.equal(config.bootstrapDays, 3);
	assert.equal(config.tz, undefined);
	assert.equal(config.order, 900);
	assert.equal(problems.length, 2);
});

test('废弃的 manifest 配置被忽略并提示，不留在 config 里', () => {
	const { config, problems } = resolveConfig({ manifest: '.memory-manifest.json' }, {});
	assert.equal('manifest' in config, false, 'manifest 不应出现在解析后的配置里');
	assert.ok(problems.some((p) => p.includes('manifest')), `应提示已废弃：${problems.join(' / ')}`);
});

test('root 目录不存在时自动创建并正常挂载（不再整个放弃）', () => {
	const base = tempRoot();
	const root = join(base, 'not-yet-exists', 'workspace');
	const host = makeHost();
	assert.doesNotThrow(() => apply(host.ctx, { root, tz: TZ }));
	assert.equal(host.sections.length, 1, '注入段应挂上');
	assert.equal(host.registered.length, 1, '工具应注册');
	assert.ok(existsSync(root), '根目录应被创建');
});
test('配置里的 root 优先，缺省用 cwd', () => {
	const root = tempRoot();
	assert.equal(resolveConfig({ root }, {}).config.root, root);
	assert.equal(resolveConfig({}, {}).config.root, process.cwd());
});

test('工具名是 diary，参数就 day/entries/overview 三个', async () => {
	const root = tempRoot();
	const host = makeHost({ now: () => new Date('2026-11-02T03:00:00Z') });
	const runtime = createRuntime({ root, tz: TZ }, { now: () => new Date('2026-11-02T03:00:00Z') });
	const off = registerTools(runtime, host.ctx);
	assert.equal(host.registered.length, 1);
	const tool = host.registered[0];
	assert.equal(tool.name, 'diary');
	assert.equal(typeof tool.execute, 'function');
	runtime.remember([{ time: '10:00', saw: ['工具写进去的'] }]);
	const got = await tool.execute({ day: 'today' });
	assert.ok(got.text.includes('工具写进去的'));
	assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['day', 'entries', 'overview']);
	off();
	assert.equal(host.registered.length, 0);
});

test('resolveDayArg 认 today/昨天/前天', () => {
	assert.equal(resolveDayArg('today', { today: '2026-11-03' }), '2026-11-03');
	assert.equal(resolveDayArg('昨天', { today: '2026-11-03' }), '2026-11-02');
	assert.equal(resolveDayArg('前天', { today: '2026-11-03' }), '2026-11-01');
	assert.equal(resolveDayArg('2026-01-05', { today: '2026-11-03' }), '2026-01-05');
});

/* ================= 收尾 ================= */
// 等所有异步用例落地，再下结论 —— 否则异步用例会"还没来得及跑就报告通过"
await Promise.all(pending);
for (const dir of temps) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* 临时目录清不掉也不影响结论 */
	}
}
console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}：${pass} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
