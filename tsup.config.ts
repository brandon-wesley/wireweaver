import { defineConfig } from 'tsup';

const entry = {
	index: 'src/container.ts',
	'vite-plugin': 'src/vite-plugin.ts',
};

const external = ['typescript', 'reflect-metadata', 'vite', 'esbuild'];

export default defineConfig([
	{
		entry,
		format: ['esm'],
		dts: true,
		clean: true,
		external,
		splitting: false,
	},
	{
		entry,
		format: ['cjs'],
		dts: false,
		clean: false,
		external,
		splitting: false,
		footer: {
			js: 'if (typeof module.exports.default === "function") module.exports = Object.assign(module.exports.default, module.exports);',
		},
	},
]);
