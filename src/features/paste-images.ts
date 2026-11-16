import type { App } from 'obsidian';

// MIME types are supplied by the clipboard. Never use them directly in a path.
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

// Let Obsidian choose the attachment folder, avoid name collisions, and format
// links according to the user's preferences. The caller inserts the links.
export async function savePastedImagesToVault(
  app: App,
  files: File[],
  sourcePath: string,
): Promise<string | null> {
  if (!files.length) return null;
  const extensions = files.map(file => IMAGE_EXTENSIONS[file.type.toLowerCase()]);
  if (extensions.some(ext => typeof ext !== 'string')) throw new Error('Unsupported pasted image type');

  const manager = app.fileManager;
  if (typeof manager?.getAvailablePathForAttachment !== 'function'
    || typeof manager.generateMarkdownLink !== 'function') {
    throw new Error('Image paste is unavailable on this Obsidian version');
  }

  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const links: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const filename = `Pasted image ${timestamp}${files.length > 1 ? ` ${i + 1}` : ''}.${extensions[i]}`;
    const path = await manager.getAvailablePathForAttachment(filename, sourcePath);
    const file = await app.vault.createBinary(path, await files[i].arrayBuffer());
    links.push(`!${manager.generateMarkdownLink(file, sourcePath)}`);
  }
  return links.join('\n');
}
