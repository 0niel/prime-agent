/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.js";
import { assertImageEncodedSize, ImageDecodeSafetyError } from "../utils/image-decode-safety.js";
import { formatDimensionNote, type ResizedImage, resizeImage } from "../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.js";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// Check if file is empty
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// Reject oversized images before reading the whole file into memory.
			try {
				assertImageEncodedSize(stats.size);
			} catch (error) {
				if (!(error instanceof ImageDecodeSafetyError)) throw error;
				text += `<file name="${absolutePath}">[${error.message}]</file>\n`;
				continue;
			}
			const content = await readFile(absolutePath);
			const base64Content = content.toString("base64");

			let attachment: ImageContent;
			let dimensionNote: string | undefined;

			if (autoResizeImages) {
				let resized: ResizedImage | null;
				try {
					resized = await resizeImage({ type: "image", data: base64Content, mimeType });
				} catch (error) {
					if (!(error instanceof ImageDecodeSafetyError)) throw error;
					text += `<file name="${absolutePath}">[${error.message}]</file>\n`;
					continue;
				}
				if (!resized) {
					text += `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`;
					continue;
				}
				dimensionNote = formatDimensionNote(resized);
				attachment = {
					type: "image",
					mimeType: resized.mimeType,
					data: resized.data,
				};
			} else {
				attachment = {
					type: "image",
					mimeType,
					data: base64Content,
				};
			}

			images.push(attachment);

			// Add text reference to image with optional dimension note
			if (dimensionNote) {
				text += `<file name="${absolutePath}">${dimensionNote}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			try {
				const content = await readFile(absolutePath, "utf-8");
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
