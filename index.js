// 长期记忆（dsh-memory）—— DSH 插件入口。
//
// 插件做三件事：
//   1) 启动时把最近三天的日记注入系统提示 —— 走宿主真实存在的
//      `ctx.get('systemPrompt').section({ name, order, interpolate: false, text })`；
//   2) 注册一个 `diary` 工具：按日期回取某一天的记忆 / 往某天记下新的事；
//   3) 所有落盘路径都经过 lib/paths.js 的守门员，只落在工作区内。
//
// 宿主 API 依据（已由 dsh-rofm / screen-view 两份跑通的插件源码核实）：
//   · 不把 systemPrompt 写进 inject —— 宿主可能是精简版，硬依赖会让 apply() 直接失败；
//     改成 ctx.get(名) 探测 + try/catch + 静默降级。ctx 是受限代理，
//     读未声明的属性会抛错，所以探测本身也得包在 try 里。
//   · **没有 ctx.workspaceDir**。工作区要用配置显式给，或从 DSH_HOME 推。
//
// 硬约束：不写 package.json / cordis.yml / cordis.patch.yml，不 import 第三方包。
import { resolve as resolvePath } from 'node:path';
import { createMemory } from './lib/store.js';
import { buildBootstrap, describeDayRecall, recallRecent } from './lib/recall.js';
import { remember, resolveDayArg } from './lib/write.js';
import { todayKey, isDateKey, isValidTimeZone } from './lib/time.js';
import { displayPath } from './lib/paths.js';

/** 插件名（也是 DSH 里的包名）。 */
export const name = 'dsh-memory';
/** 入口 id：cordis.patch.yml 里 insert 的那一行的 id。 */
export const entryId = 'memory';
/**
 * 硬依赖。
 *
 * 只声明 tools：`systemPrompt` 刻意**不**写进来。它在部分宿主上是可选服务，
 * 声明成硬依赖会让整个 apply() 失败、插件在插件页显示"异常"；
 * 而 ctx 是受限代理，读未声明的属性会抛错，所以必须用 ctx.get() + try/catch 探测。
 * （这条来自 dsh-rofm 的做法。）
 */
export const inject = ['tools'];

export const DEFAULTS = {
	/** 启动时注入最近几天：3。 */
	bootstrapDays: 3,
	/** 总开关：false 时一个工具都不注册，也不注入。 */
	enabled: true,
	/**
	 * 记忆库根目录（绝对路径或相对 process.cwd() 的路径）。
	 * 空 = 用 process.cwd()。**没有 ctx.workspaceDir 这种东西**，
	 * 所以要么在这里显式配，要么靠 cwd —— 不要从宿主内部去猜。
	 */
	root: '',
	/** 记忆库相对根的目录。 */
	dir: '.memory',
	/** 时区；空 = 运行时本地时区。日期按这个时区切天。 */
	tz: '',
	/** 注入段在系统提示里的排序位（宿主给别的段也排，挑个靠后的）。 */
	order: 900,
	/** 单个工具调用的超时（毫秒）。 */
	timeoutMs: 20000,
};

/**
 * 解析配置。**不抛错**：任何非法配置都退回到安全默认值，
 * 因为 apply() 里抛错会让插件在插件页显示"异常"，而记忆是纯增益功能，
 * 宁可不注入也不该把宿主搞崩。
 * @returns {{config: object, problems: string[]}}
 */
export function resolveConfig(config, ctx = {}) {
	const problems = [];
	const merged = { ...DEFAULTS, ...(config !== null && typeof config === 'object' ? config : {}) };

	let days = Number(merged.bootstrapDays);
	if (!Number.isInteger(days) || days < 1 || days > 30) {
		problems.push(`bootstrapDays 非法（${String(merged.bootstrapDays)}），回落到 ${DEFAULTS.bootstrapDays}`);
		days = DEFAULTS.bootstrapDays;
	}
	if (!isValidTimeZone(merged.tz)) {
		problems.push(`tz 非法（${merged.tz}），回落到本地时区`);
		merged.tz = '';
	}
	let order = Number(merged.order);
	if (!Number.isFinite(order)) order = DEFAULTS.order;

	// 根目录：显式配置优先；否则 process.cwd()。
	// 注意这里**没有** ctx.workspaceDir —— 那个字段不存在，猜它只会静默写到错的目录。
	const rootRaw = String(merged.root ?? '').trim();
	const root = rootRaw === '' ? process.cwd() : resolvePath(rootRaw);
	void ctx;

	// 旧版本有个 manifest 配置项（防篡改痕迹），已经移除。
	// 用户配置里如果还留着，剔掉并说一声，免得"配了却没有效果"。
	if ('manifest' in merged) {
		delete merged.manifest;
		problems.push('manifest 配置项已废弃（新版本不再需要），已忽略');
	}

	return {
		config: {
			...merged,
			bootstrapDays: days,
			enabled: merged.enabled !== false,
			tz: merged.tz === '' ? undefined : merged.tz,
			order,
			root,
		},
		problems,
	};
}

/** 防御式取服务：拿不到返回 null，绝不抛。 */
export function resolveService(ctx, serviceName) {
	if (ctx === null || ctx === undefined) return null;
	if (typeof ctx.get === 'function') {
		try {
			const svc = ctx.get(serviceName);
			if (svc !== null && svc !== undefined) return svc;
		} catch {
			/* 受限代理：未声明的属性会抛错，按"没有"处理 */
		}
	}
	try {
		const direct = ctx[serviceName];
		if (direct !== null && direct !== undefined) return direct;
	} catch {
		/* 同上 */
	}
	return null;
}

/**
 * 构造一个「记忆运行时」：把 store、时区、今天这些串起来。
 * 宿主和 CLI 都走它，保证两边行为一致。
 * @param {object} config
 * @param {object} [host] - { root?, now? } 宿主侧注入的少量事实
 */
export function createRuntime(config = {}, host = {}) {
	const { config: cfg, problems } = resolveConfig({ ...config, root: config.root ?? host.root }, host);
	const store = createMemory({ root: cfg.root, dir: cfg.dir });
	let lastBootstrap = null;
	const now = () => (typeof host.now === 'function' ? host.now() : new Date());

	const today = () => todayKey(cfg.tz, now());

	return {
		vault: store.vault,
		store,
		config: cfg,
		problems,
		today,
		tz: cfg.tz,
		/**
		 * 启动注入：返回要拼进系统提示的文字。
		 *
		 * **不缓存** —— 系统提示的 section text 是个函数，每轮都会被调用；
		 * 跨天的会话（开着过夜）必须能在第二天拿到新的"最近三天"。
		 * 正文每一轮重算一次，成本只是读几个 JSON。
		 * @returns {string} 直接可拼进系统提示的正文
		 */
		bootstrap(options = {}) {
			if (options.force !== true && cfg.enabled !== true) return '';
			const result = buildBootstrap(store, {
				days: options.days ?? cfg.bootstrapDays,
				today: options.today ?? today(),
				tz: cfg.tz,
				maxChars: options.maxChars,
			});
			lastBootstrap = result;
			return result.text;
		},
		/** 最近一次注入的结果详情（正文 + 用了哪几天），调试/面板用。 */
		get lastBootstrap() {
			return lastBootstrap;
		},
		/** 按日期取回一天。day 支持 "today"/"昨天"/YYYY-MM-DD。 */
		recallDay(dayInput) {
			const day = resolveDayArg(dayInput, { today: today(), tz: cfg.tz });
			if (!isDateKey(day)) throw new Error(`日期必须是 YYYY-MM-DD（收到：${JSON.stringify(dayInput)}）`);
			return describeDayRecall(store, day, { today: today(), tz: cfg.tz });
		},
		/** 最近 n 天（日历天，含今天）。 */
		recallRecent(days = cfg.bootstrapDays) {
			return recallRecent(store, { days, today: today(), tz: cfg.tz });
		},
		/** 往日记里记下一段经历。 */
		remember(entries, options = {}) {
			const result = remember(store, entries, {
				tz: cfg.tz,
				today: options.today ?? today(),
				source: options.source ?? 'agent',
				author: options.author ?? '它',
				overview: options.overview,
			});
			return {
				...result,
				files: result.files.filter(Boolean).map((f) => displayPath(store.vault.root, f)),
			};
		},
	};
}

/** 工具描述：给模型看的说明，必须是它自己能看懂的"我"口吻。 */
const DIARY_TOOL_DESCRIPTION = [
	'你的记事本。用它回看某一天自己经历了什么，或者把刚刚经历的事记下来。',
	'取回：传 day（YYYY-MM-DD，或 "today"/"昨天"/"前天"）看那一天；不传 day 默认今天。',
	'记下：传 entries 一组经历，每条带 time（"HH:mm" 即可，跨天就写完整日期）和 saw/left/actions/felt 等字段。',
	'',
	'**什么时候该记**：做完一段事之后主动记一条 —— 这不需要谁来提醒你。',
	'一次记一个"场景"：看了什么、留了什么、做了什么，用你自己的话。不要写操作日志（"点击了坐标 320,480"），',
	'那不是你的记忆；写"我在首页看到了一条讲猫的视频，点进去看了两分钟"才是。',
	'',
	'**看到的东西要写成文字。** 你看到的画面不会一直留着，能留下的只有你写下的字。',
	'所以别只写"看了一个视频"——写下标题、作者、里面讲了什么、评论区谁说了什么。',
	'过几天回头翻的人（包括你自己）只能靠这些字把当时的样子还原出来。',
	'',
	'记漏了也没关系，不必为了凑数硬写；但别人回复了你、你发了东西、你有了什么想法，最好记下来。',
].join('\n');

const ENTRY_SCHEMA = {
	type: 'object',
	properties: {
		time: { type: 'string', description: '发生时间：HH:mm（当天）或 YYYY-MM-DDTHH:mm' },
		saw: {
			type: 'array',
			description: '看到了什么',
			items: {
				type: 'object',
				properties: {
					what: { type: 'string' },
					where: { type: 'string' },
					link: { type: 'string' },
					author: { type: 'string' },
					notes: { type: 'string' },
				},
			},
		},
		left: { type: 'array', description: '留下了什么（评论、视频、收藏等）', items: { type: 'object' } },
		actions: {
			type: 'array',
			description: '做了什么',
			items: {
				type: 'object',
				properties: {
					kind: { type: 'string', description: '观看/点赞/投币/收藏/评论/回复/发视频/搜索/关注/其他' },
					target: { type: 'string' },
					detail: { type: 'string', description: '留下的正文（评论内容等）' },
				},
			},
		},
		felt: { type: 'string', description: '当时怎么想的（可选，不必勉强）' },
		notes: { type: 'string' },
		tags: { type: 'array', items: { type: 'string' } },
	},
	required: ['time'],
};

/** 注册 diary 工具；返回注销函数。 */
export function registerTools(runtime, ctx) {
	const tools = resolveService(ctx, 'tools');
	if (tools === null || typeof tools.register !== 'function') return () => {};
	const unregister = tools.register({
		name: 'diary',
		description: DIARY_TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				day: { type: 'string', description: '取回哪一天：YYYY-MM-DD 或 today/昨天/前天；想记下时不用传' },
				entries: { type: 'array', description: '要记下的经历', items: ENTRY_SCHEMA },
				overview: { type: 'string', description: '顺便给这一天写一句概括（可选）' },
			},
		},
		output: {
			schema: {},
			render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
		},
		presentCall: (args) =>
			Array.isArray(args?.entries) && args.entries.length > 0
				? `在记事本里写下 ${args.entries.length} 件事`
				: `翻看 ${typeof args?.day === 'string' && args.day ? args.day : '今天'} 的记事`,
		timeoutMs: runtime.config.timeoutMs,
		async execute(args) {
			const a = args !== null && typeof args === 'object' ? args : {};
			const hasEntries = Array.isArray(a.entries) && a.entries.length > 0;
			if (!hasEntries) {
				return runtime.recallDay(a.day ?? 'today');
			}
			const result = runtime.remember(a.entries, { overview: a.overview });
			const days = result.days;
			const back = runtime.recallDay(days[days.length - 1]);
			const head = `记下了。涉及的日期：${days.join('、')}。\n`;
			return { day: days[days.length - 1], found: true, count: result.entries.length, text: head + back.text };
		},
	});
	return typeof unregister === 'function' ? unregister : () => {};
}

/**
 * 把最近几天的记忆挂到宿主的系统提示里。
 *
 * 真实 API（dsh-rofm / screen-view 核实）：
 *   const sp = ctx.get('systemPrompt')
 *   sp.section({ name, order, interpolate: false, text: () => 字符串 })
 * `text` 是**函数**，每次渲染系统提示时调用 —— 所以我们每轮重算，跨天不会卡在旧内容上。
 *
 * 拿不到 systemPrompt 就静默降级（返回 null），不抛错。
 * @returns {(() => void)|null} 注销函数
 */
export function registerSystemPrompt(runtime, ctx, logger = null) {
	const systemPrompt = resolveService(ctx, 'systemPrompt');
	if (systemPrompt === null) {
		logger?.warn?.('dsh-memory: 宿主没有 systemPrompt 服务，跳过启动注入（diary 工具仍可用）');
		return null;
	}
	if (typeof systemPrompt.section !== 'function') {
		logger?.warn?.('dsh-memory: systemPrompt 没有 section()，跳过启动注入');
		return null;
	}
	try {
		const disposer = systemPrompt.section({
			name: 'memory',
			order: runtime.config.order,
			// 正文里有日期、链接等文本，不做插值替换
			interpolate: false,
			text: () => {
				try {
					return runtime.bootstrap();
				} catch (error) {
					// 注入正文算挂了绝不能拖垮宿主一轮对话
					logger?.warn?.(`dsh-memory: 生成注入正文失败：${error?.message ?? error}`);
					return '';
				}
			},
		});
		return typeof disposer === 'function' ? disposer : () => {};
	} catch (error) {
		logger?.warn?.(`dsh-memory: 注册系统提示段失败：${error?.message ?? error}`);
		return null;
	}
}

/**
 * DSH 外壳：宿主调用 apply(ctx, config)。
 * 任何一步拿不到服务都静默降级，绝不在挂载时抛错。
 */
export function apply(ctx, config = {}) {
	const logger = ctx?.logger ?? null;
	let runtime;
	try {
		runtime = createRuntime(config);
	} catch (error) {
		logger?.warn?.(`${name}: 初始化失败：${error?.message ?? error}`);
		return;
	}
	for (const problem of runtime.problems) logger?.warn?.(`${name}: ${problem}`);
	if (runtime.config.enabled !== true) return;

	const disposers = [];
	const offPrompt = registerSystemPrompt(runtime, ctx, logger);
	if (offPrompt !== null) disposers.push(offPrompt);
	try {
		disposers.push(registerTools(runtime, ctx));
	} catch (error) {
		logger?.warn?.(`${name}: 注册工具失败：${error?.message ?? error}`);
	}

	const stop = () => {
		for (const dispose of disposers.splice(0)) {
			try {
				dispose();
			} catch {
				/* 注销失败不影响其他清理 */
			}
		}
	};
	if (typeof ctx.effect === 'function') {
		ctx.effect(() => () => stop(), `${name}: mount`);
	} else {
		ctx.once?.('disposed', stop);
	}
}
