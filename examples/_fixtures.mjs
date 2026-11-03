// 读 examples/fixtures/ 下的虚构数据。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export function fromFile(name) {
	return JSON.parse(readFileSync(new URL(`file://${FIXTURES.replace(/\\/g, '/')}/${name}`), 'utf8'));
}
