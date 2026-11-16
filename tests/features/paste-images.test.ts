import { describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import { savePastedImagesToVault } from '../../src/features/paste-images';

describe('pasted image attachments', () => {
  it('uses Obsidian to choose paths and generate links for the source note', async () => {
    const app = new App();
    const source = 'notes/A note.md';
    const choosePath = vi.mocked(app.fileManager.getAvailablePathForAttachment);
    choosePath.mockResolvedValueOnce('attachments/Pasted image.png');
    choosePath.mockResolvedValueOnce('attachments/Pasted image (1).svg');
    const makeLink = vi.mocked(app.fileManager.generateMarkdownLink);
    makeLink.mockImplementation(file => `[image](../${encodeURIComponent(file.path)})`);
    const files = [
      new File(['png'], 'clipboard.png', { type: 'image/png' }),
      new File(['svg'], 'clipboard.svg', { type: 'image/svg+xml' }),
    ];

    const result = await savePastedImagesToVault(app, files, source);

    expect(choosePath).toHaveBeenCalledTimes(2);
    expect(choosePath.mock.calls[0][0]).toMatch(/^Pasted image \d{8}_\d{6} 1\.png$/);
    expect(choosePath.mock.calls[1][0]).toMatch(/^Pasted image \d{8}_\d{6} 2\.svg$/);
    expect(choosePath.mock.calls.map(call => call[1])).toEqual([source, source]);
    expect(app.vault.createBinary).toHaveBeenCalledTimes(2);
    expect(makeLink.mock.calls.map(([file, path]) => [(file as TFile).path, path])).toEqual([
      ['attachments/Pasted image.png', source], ['attachments/Pasted image (1).svg', source],
    ]);
    expect(result).toBe('![image](../attachments%2FPasted%20image.png)\n![image](../attachments%2FPasted%20image%20(1).svg)');
  });

  it('rejects unsupported MIME types before creating any attachments', async () => {
    const app = new App();
    const files = [
      new File(['png'], 'ok.png', { type: 'image/png' }),
      new File(['bad'], 'bad', { type: 'image/../../escape' }),
    ];
    await expect(savePastedImagesToVault(app, files, 'note.md')).rejects.toThrow('Unsupported');
    expect(app.vault.createBinary).not.toHaveBeenCalled();
  });

  it('reports missing attachment APIs rather than inventing a location', async () => {
    const app = new App();
    (app.fileManager as unknown as { getAvailablePathForAttachment?: unknown }).getAvailablePathForAttachment = undefined;
    await expect(savePastedImagesToVault(app, [new File(['png'], 'x.png', { type: 'image/png' })], 'note.md'))
      .rejects.toThrow('unavailable');
    expect(app.vault.createBinary).not.toHaveBeenCalled();
  });
});
