// Builds the fixture site into dist/: each page gets its components inlined.
// A page includes a component with <!-- component:name -->.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dirname;
const src = join(root, 'src');
const out = join(root, 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const component = (name) => readFileSync(join(src, 'components', `${name}.html`), 'utf8').trim();
const expand = (html, depth = 0) => {
	if (depth > 5) throw new Error('Components nest too deep.');
	return html.replace(/<!-- component:([a-z-]+) -->/g, (_, name) => expand(component(name), depth + 1));
};

for (const page of readdirSync(join(src, 'pages'))) {
	if (!page.endsWith('.html')) continue;
	writeFileSync(join(out, page), expand(readFileSync(join(src, 'pages', page), 'utf8')));
}
for (const dir of ['styles', 'scripts', 'data']) {
	cpSync(join(src, dir), join(out, dir), { recursive: true });
}
console.log(`Built ${out}`);
