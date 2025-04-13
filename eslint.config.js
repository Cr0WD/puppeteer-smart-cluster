import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginImport from 'eslint-plugin-import'
import eslintPluginPromise from 'eslint-plugin-promise'
import eslintPluginSecurity from 'eslint-plugin-security'
import eslintPluginUnicorn from 'eslint-plugin-unicorn'
import tseslint from 'typescript-eslint'

/**
 * A custom ESLint configuration for libraries that use Next.js.
 *
 * @type {import("eslint").Linter.Config}
 * */
export const config = [
	js.configs.recommended,
	eslintConfigPrettier,
	...tseslint.configs.recommended,
	eslintPluginImport.flatConfigs.recommended,
	eslintPluginImport.flatConfigs.errors,
	eslintPluginImport.flatConfigs.warnings,
	eslintPluginImport.flatConfigs.typescript,
	eslintPluginPromise.configs['flat/recommended'],
	eslintPluginSecurity.configs.recommended,
	eslintPluginUnicorn.configs['flat/recommended']
]
