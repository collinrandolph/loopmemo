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

/** Somewhere to put a file, reserved before the work that produces it. */
export type Destination = {
  /** Where it is going, for a message. */
  readonly filename: string;
  /** Write the finished blob. The string is why it failed; undefined means it was written. */
  write(blob: Blob): Promise<string | undefined>;
};

type FileHandle = {
  createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>;
};

/**
 * Ask the user where the file should go — **before** rendering it, not after.
 *
 * `showSaveFilePicker` requires transient user activation, and Chrome's lasts about five seconds
 * from the click. An export renders every file first and only then asked to save, so any export
 * slower than that window threw `SecurityError: Must be handling a user gesture to show a file
 * picker` — measured here at nine files, and a single full loop of a long project is enough on
 * its own. The old `catch { return false }` turned that into silence: the button counted through
 * the renders, reset itself, and no file ever arrived. **Both halves were the bug** — losing the
 * activation, and then swallowing the proof.
 *
 * So the destination is reserved while the click is still fresh, and the blob is written into it
 * afterwards. It also means a cancel costs nothing: the render has not happened yet.
 *
 * Undefined means the user cancelled, which is a decision rather than a failure. Everything else
 * falls through to `<a download>`, which needs no activation and works in every browser — it just
 * cannot offer a folder or say whether the user kept the file.
 */
export async function chooseDestination(filename: string, mime: string): Promise<Destination | undefined> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileHandle> })
    .showSaveFilePicker;

  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [
          {
            description: mime === 'application/zip' ? 'ZIP archive' : 'WAV audio',
            accept: { [mime]: [filename.slice(filename.lastIndexOf('.'))] },
          },
        ],
      });
      return {
        filename,
        async write(blob) {
          try {
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return undefined;
          } catch (e) {
            return reason(e);
          }
        },
      };
    } catch (e) {
      // The one error that is not an error. Everything else — no activation left, a context that
      // refuses the picker, a name the platform will not take — is a reason to fall back rather
      // than to stop, and must never be mistaken for the user saying no.
      if (e instanceof DOMException && e.name === 'AbortError') return undefined;
    }
  }

  return { filename, write: async (blob) => download(blob, filename) };
}

/** The download that always works: no activation, no picker, straight to Downloads. */
function download(blob: Blob, filename: string): string | undefined {
  try {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    // Revoked on a later turn of the event loop: revoking synchronously races the download the
    // click just started, and the file arrives empty.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return undefined;
  } catch (e) {
    return reason(e);
  }
}

function reason(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
