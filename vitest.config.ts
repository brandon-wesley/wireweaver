import { defineConfig } from 'vitest/config';
import { wireWeaverPlugin } from './src/vite-plugin.js';

export default defineConfig({
	plugins: [wireWeaverPlugin()],
	test: {
		include: ['test/**/*.test.ts'],
	},
});
