import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
	resolve: { alias: {	'@': resolve('src') } },
	test: {
		projects: [
			// 'tests',
			{ test: { include: ['bench'], environment: 'happy-dom' } },
		],
	},
})