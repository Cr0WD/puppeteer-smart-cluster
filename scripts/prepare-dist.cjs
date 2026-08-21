const { renameSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const distributionDirectory = join(__dirname, '..', 'dist')
const commonJsEntry = join(distributionDirectory, 'index.cjs')
// Build paths are constrained to the repository distribution directory.
// eslint-disable-next-line security/detect-non-literal-fs-filename
renameSync(commonJsEntry, join(distributionDirectory, 'index.bundle.cjs'))

// Build output is constrained to the repository distribution directory.
// eslint-disable-next-line security/detect-non-literal-fs-filename
writeFileSync(
	commonJsEntry,
	`'use strict'

const bundledModule = require('./index.bundle.cjs')
const CreateSmartCluster = bundledModule.default

module.exports = CreateSmartCluster
module.exports.default = CreateSmartCluster
Object.defineProperty(module.exports, '__esModule', { value: true })
`
)
