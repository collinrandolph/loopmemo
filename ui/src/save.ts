/**
 * Getting files out of the browser, and a ZIP written by hand to do it in one go.
 *
 * An export is often several files (§2.7 — stems, every pass), and a browser has no good way to
 * hand over several at once: a loop of `<a download>` clicks trips Chrome's multiple-download
 * prompt and arrives as an unordered pile. One archive is one decision for the user.
 *
 * **No library.** `CompressionStream('deflate-raw')` is exactly the codec ZIP wants, so the only
 * things left to write are the CRC and the record layout. Both are small and neither is a
 * judgement call.
 */

export type OutputFile = { readonly name: string; readonly blob: Blob };

/** Reversed-polynomial CRC-32, the one ZIP specifies. Table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array<ArrayBuffer>): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A ZIP holding `files`, deflated.
 *
 * Deliberately plain: no directories, no zip64, no data descriptors. The sizes here are tens of
 * megabytes at most, which is inside every limit the basic format has, and a bigger
 * implementation would be more to get wrong for no gain.
 *
 * PCM audio deflates by roughly a tenth — worth having and not worth expecting much from. The
 * stored fallback exists for the case where the compressed form would be *larger*, which happens
 * with high-entropy audio and would otherwise make the archive bigger than its contents.
 */
export async function zip(files: readonly OutputFile[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const raw = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(raw);
    const packed = await deflate(raw);
    const stored = packed.length >= raw.length;
    const body = stored ? raw : packed;
    const method = stored ? 0 : 8;

    const local = new DataView<ArrayBuffer>(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, method, true);
    local.setUint16(10, 0, true); // time — left at zero rather than invented
    local.setUint16(12, 0x21, true); // date — 1980-01-01, the format's own epoch
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra field length
    parts.push(local, name, body);

    const entry = new DataView<ArrayBuffer>(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); // central directory header
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0, true);
    entry.setUint16(10, method, true);
    entry.setUint16(12, 0, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, body.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry, name);

    offset += 30 + name.length + body.length;
  }

  const directory = await new Blob(central).arrayBuffer();
  const end = new DataView<ArrayBuffer>(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directory.byteLength, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, directory, end], { type: 'application/zip' });
}

/**
 * Hand a blob to the user.
 *
 * `showSaveFilePicker` where it exists, because it lets them choose the folder and the name and
 * tells us whether they went through with it. Chrome only, and a fallback matters: an `<a
 * download>` click works everywhere and simply drops the file in Downloads. A cancelled picker
 * is a normal outcome, not an error, and reports `false`.
 */
export async function save(blob: Blob, filename: string): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<unknown> })
    .showSaveFilePicker;
  if (picker) {
    try {
      const handle = (await picker({
        suggestedName: filename,
        types: [
          {
            description: blob.type === 'application/zip' ? 'ZIP archive' : 'WAV audio',
            accept: { [blob.type]: [filename.slice(filename.lastIndexOf('.'))] },
          },
        ],
      })) as { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> };
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch {
      return false; // the user cancelled, or the picker is unavailable in this context
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoked on a later turn of the event loop: revoking synchronously races the download the
  // click just started, and the file arrives empty.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
