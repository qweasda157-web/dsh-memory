// 记忆库根路径与「守门员」：所有落盘路径都必须经过这里。
//
// 规则：
//   1) 根目录默认是**工作区**（进程 cwd）；
//   2) 任何相对路径、任何带 .. 的路径，解析后必须仍在根目录之内，否则直接抛错；
//   3) 不提供任何绕过手段：不写系统目录、不读环境变量里的路径、不动配置文件。
//
// 换句话说：这个插件只会写你配置的那个目录，别的地方碰不到。
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DEFAULT_DIR = '.memory';
const BOM = '\uFEFF';

/** child 是否在 root 之内（字符串层面，大小写不敏感以适配 Windows）。 */
export function isInside(root, child) {
	const r = resolve(root);
	const c = resolve(child);
	if (r.toLowerCase() === c.toLowerCase()) return true;
	const rel = relative(r, c);
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 把用户给的路径钉到根目录里。
 * 相对路径按根解析；绝对路径只有**本来就在根里**才放行，否则报错并说明原因。
 * 已存在的路径再做一次 realpath 检查，防止符号链接 / junction 绕到外面。
 */
export function resolveInside(root, input, what = '路径') {
	const r = resolve(root);
	if (input === undefined || input === null || String(input).trim() === '') {
		throw new Error(`${what}不能为空`);
	}
	const raw = String(input).trim();
	const candidate = isAbsolute(raw) ? resolve(raw) : resolve(r, raw);
	if (!isInside(r, candidate)) {
		throw new Error(
			`${what}「${raw}」解析到 ${candidate}，落在工作区 ${r} 之外 —— 已拒绝。` +
			'所有记忆文件只允许写在工作区内。',
		);
	}
	if (existsSync(candidate)) {
		try {
			const realRoot = realpathSync(r);
			const realCandidate = realpathSync(candidate);
			if (!isInside(realRoot, realCandidate)) {
				throw new Error(`${what}「${raw}」通过链接指向了工作区之外，已拒绝。`);
			}
		} catch (error) {
			if (String(error?.message ?? '').includes('已拒绝')) throw error;
			// realpath 失败（权限、竞态）不阻塞：字符串层面已经确认在根内
		}
	}
	return candidate;
}

/** 递归建目录（在根内）。 */
export function ensureDir(root, relPath) {
	const dir = resolveInside(root, relPath, '目录');
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 列出目录下的文件（只有文件，排序）；目录不存在返回 []。 */
export function listFiles(dir, pattern) {
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => (pattern === undefined ? true : pattern.test(name)))
		.filter((name) => {
			try {
				return statSync(join(dir, name)).isFile();
			} catch {
				return false;
			}
		})
		.sort();
}

/** 读 JSON；缺失时 missing=true，坏文件时 ok=false 并带回原因。绝不抛。 */
export function readJsonSafe(file) {
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT') return { ok: false, missing: true, value: null, error: null };
		return { ok: false, missing: false, value: null, error };
	}
	try {
		return { ok: true, missing: false, value: JSON.parse(text.replace(/^\uFEFF/, '')), error: null };
	} catch (error) {
		return { ok: false, missing: false, value: null, error };
	}
}

/**
 * 写文件：UTF-8 无 BOM，原子替换。
 * 先写同目录临时文件再 rename —— 中途崩了也不会留下半个 JSON。
 */
export function writeFileAtomic(file, text) {
	const body = text.startsWith(BOM) ? text.slice(1) : text;
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tmp, body, { encoding: 'utf8' });
		renameSync(tmp, file);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* 清理失败不影响主流程 */
		}
		throw error;
	}
	return file;
}

/** 相对工作区的展示路径，写进给人看的报告用。 */
export function displayPath(root, file) {
	const rel = relative(resolve(root), resolve(file));
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return file;
	return rel.split(sep).join('/');
}

/* ------------------------------------------------------------------ */
/* 记忆库根                                                            */
/* ------------------------------------------------------------------ */

/**
 * 构造一个「记忆库」句柄：把根钉死，之后所有读写都走它。
 * @param {object} opts
 * @param {string} [opts.root] - 工作区绝对路径，默认进程 cwd。
 * @param {string} [opts.dir] - 记忆库相对目录，默认 .memory。
 */
export function createVault(opts = {}) {
	const root = resolve(String(opts.root ?? process.cwd()));
	// 根目录不存在就建：装载时宿主给的工作区可能还没落地，
	// 为了这个把整个插件的注入和工具都放弃，代价太大。
	if (!existsSync(root)) {
		try {
			mkdirSync(root, { recursive: true });
		} catch (error) {
			throw new Error(`工作区不存在且无法创建：${root}（${error?.message ?? error}）`);
		}
	}
	const dir = resolveInside(root, opts.dir ?? DEFAULT_DIR, '记忆库目录');

	const rel = (sub) => join(relative(root, dir), sub);
	const paths = {
		root,
		dir,
		diary: resolveInside(root, rel('diary'), '日记目录'),
		diaryDays: resolveInside(root, rel(join('diary', 'days')), '日记按日目录'),
		diaryIndex: resolveInside(root, rel(join('diary', 'index.json')), '日记索引'),
		state: resolveInside(root, rel('state'), '状态目录'),
	};

	return {
		root,
		dir: paths.dir,
		paths,
		/** 目录不存在就建（只建记忆库内的目录）。 */
		ensure() {
			ensureDir(root, paths.diaryDays);
			ensureDir(root, paths.state);
			return paths;
		},
	};
}
