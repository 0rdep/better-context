import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Config } from '../config/index.ts';
import { Transaction } from '../context/transaction.ts';
import { CommonHints, getErrorHint, getErrorMessage } from '../errors.ts';
import { Metrics } from '../metrics/index.ts';
import { Resources } from '../resources/service.ts';
import { isGitResource } from '../resources/schema.ts';
import { FS_RESOURCE_SYSTEM_NOTE, type BtcaFsResource } from '../resources/types.ts';
import { CollectionError, getCollectionKey, type CollectionResult } from './types.ts';
import { VirtualFs } from '../vfs/virtual-fs.ts';
import {
	clearVirtualCollectionMetadata,
	setVirtualCollectionMetadata,
	type VirtualResourceMetadata
} from './virtual-metadata.ts';

export namespace Collections {
	export type Service = {
		load: (args: {
			resourceNames: readonly string[];
			quiet?: boolean;
		}) => Promise<CollectionResult>;
	};

	const createCollectionInstructionBlock = (resource: BtcaFsResource): string => {
		const focusLines = resource.repoSubPaths.map(
			(subPath) => `Focus: ./${resource.fsName}/${subPath}`
		);
		const lines = [
			`## Resource: ${resource.name}`,
			FS_RESOURCE_SYSTEM_NOTE,
			`Path: ./${resource.fsName}`,
			...focusLines,
			resource.specialAgentInstructions ? `Notes: ${resource.specialAgentInstructions}` : ''
		].filter(Boolean);

		return lines.join('\n');
	};

	const getGitHeadHash = async (resourcePath: string) => {
		try {
			const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
				cwd: resourcePath,
				stdout: 'pipe',
				stderr: 'pipe'
			});
			const stdout = await new Response(proc.stdout).text();
			const exitCode = await proc.exited;
			if (exitCode !== 0) return undefined;
			const trimmed = stdout.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		} catch {
			return undefined;
		}
	};

	const buildVirtualMetadata = async (args: {
		resource: BtcaFsResource;
		resourcePath: string;
		loadedAt: string;
		definition?: ReturnType<Config.Service['getResource']>;
	}) => {
		if (!args.definition) return null;
		const base = {
			name: args.resource.name,
			fsName: args.resource.fsName,
			type: args.resource.type,
			path: args.resourcePath,
			repoSubPaths: args.resource.repoSubPaths,
			loadedAt: args.loadedAt
		};
		if (!isGitResource(args.definition)) return base;
		const commit = await getGitHeadHash(args.resourcePath);
		return {
			...base,
			url: args.definition.url,
			branch: args.definition.branch,
			commit
		};
	};

	export const create = (args: {
		config: Config.Service;
		resources: Resources.Service;
	}): Service => {
		return {
			load: ({ resourceNames, quiet = false }) =>
				Transaction.run('collections.load', async () => {
					const uniqueNames = Array.from(new Set(resourceNames));
					if (uniqueNames.length === 0)
						throw new CollectionError({
							message: 'Cannot create collection with no resources',
							hint: `${CommonHints.LIST_RESOURCES} ${CommonHints.ADD_RESOURCE}`
						});

					Metrics.info('collections.load', { resources: uniqueNames, quiet });

					const sortedNames = [...uniqueNames].sort((a, b) => a.localeCompare(b));
					const key = getCollectionKey(sortedNames);
					const collectionPath = '/';
					const vfsId = VirtualFs.create();
					const cleanupVirtual = () => {
						VirtualFs.dispose(vfsId);
						clearVirtualCollectionMetadata(vfsId);
					};

					try {
						// Virtual collections use the VFS root as the collection root.
						await VirtualFs.mkdir(collectionPath, { recursive: true }, vfsId);
					} catch (cause) {
						cleanupVirtual();
						throw new CollectionError({
							message: `Failed to initialize virtual collection root: "${collectionPath}"`,
							hint: 'Check that the virtual filesystem is available.',
							cause
						});
					}

					const loadedResources: BtcaFsResource[] = [];
					const metadataResources: VirtualResourceMetadata[] = [];
					const loadedAt = new Date().toISOString();
					for (const name of sortedNames) {
						try {
							loadedResources.push(await args.resources.load(name, { quiet }));
						} catch (cause) {
							// Preserve the hint from the underlying error if available
							const underlyingHint = getErrorHint(cause);
							const underlyingMessage = getErrorMessage(cause);
							cleanupVirtual();
							throw new CollectionError({
								message: `Failed to load resource "${name}": ${underlyingMessage}`,
								hint:
									underlyingHint ??
									`${CommonHints.CLEAR_CACHE} Check that the resource "${name}" is correctly configured.`,
								cause
							});
						}
					}

					for (const resource of loadedResources) {
						let resourcePath: string;
						try {
							resourcePath = await resource.getAbsoluteDirectoryPath();
						} catch (cause) {
							cleanupVirtual();
							throw new CollectionError({
								message: `Failed to get path for resource "${resource.name}"`,
								hint: CommonHints.CLEAR_CACHE,
								cause
							});
						}

						const virtualResourcePath = path.posix.join('/', resource.fsName);
						try {
							await VirtualFs.rm(virtualResourcePath, { recursive: true, force: true }, vfsId);
						} catch {
							// ignore
						}
						try {
							await VirtualFs.importDirectoryFromDisk({
								sourcePath: resourcePath,
								destinationPath: virtualResourcePath,
								vfsId,
								ignore: (relativePath) => {
									const normalized = relativePath.split(path.sep).join('/');
									return (
										normalized === '.git' ||
										normalized.startsWith('.git/') ||
										normalized.includes('/.git/')
									);
								}
							});
						} catch (cause) {
							cleanupVirtual();
							throw new CollectionError({
								message: `Failed to virtualize resource "${resource.name}"`,
								hint: CommonHints.CLEAR_CACHE,
								cause
							});
						}

						const definition = args.config.getResource(resource.name);
						const metadata = await buildVirtualMetadata({
							resource,
							resourcePath,
							loadedAt,
							definition
						});
						if (metadata) metadataResources.push(metadata);
					}

					setVirtualCollectionMetadata({
						vfsId,
						collectionKey: key,
						createdAt: loadedAt,
						resources: metadataResources
					});

					const instructionBlocks = loadedResources.map(createCollectionInstructionBlock);

					// Create a real collection directory with symlinks for external CLI tools (e.g., Cursor)
					let realPath: string | undefined;
					let tempDir: string | undefined;
					try {
						tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'btca-collection-'));
						for (const resource of loadedResources) {
							const resourceAbsPath = await resource.getAbsoluteDirectoryPath();
							const symlinkPath = path.join(tempDir, resource.fsName);
							// On Windows, directory symlinks often require admin unless using junctions.
							if (os.platform() === 'win32') {
								await fs.symlink(resourceAbsPath, symlinkPath, 'junction');
							} else {
								await fs.symlink(resourceAbsPath, symlinkPath);
							}
						}
						realPath = tempDir;
						Metrics.info('collections.realpath.created', { path: tempDir });
					} catch (cause) {
						// Non-fatal: VFS will still work, just external CLI tools won't
						Metrics.error('collections.realpath.failed', { error: String(cause) });
						if (tempDir) {
							try {
								await fs.rm(tempDir, { recursive: true, force: true });
							} catch {
								// ignore cleanup errors
							}
						}
					}

					return {
						path: collectionPath,
						agentInstructions: instructionBlocks.join('\n\n'),
						vfsId,
						realPath
					};
				})
		};
	};
}
