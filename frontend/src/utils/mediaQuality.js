/**
 * Standard / HD tiers, and the image re-encode that gives them meaning.
 *
 * Before this, the web uploaded the raw File untouched: a modern phone photo
 * went up at full sensor resolution, and one over the image cap was REJECTED
 * with a toast rather than fitted. The same photo sent from iOS arrives, because
 * iOS runs it through ImageIO first — and every iOS recipient then downloads the
 * web's full-size originals over cellular.
 *
 * Mirrors ios/RxHive/Features/Media/MediaQuality.swift: the same two tiers, the
 * same long-edge limits, the same JPEG qualities, and the same three rules that
 * make it safe —
 *
 *   never upscale        a small original is left alone, exactly as
 *                        CGImageSourceCreateThumbnailAtIndex does.
 *   keep the smaller     if the re-encode comes out bigger than the source, the
 *                        source wins. Re-encoding an already-optimised JPEG
 *                        routinely inflates it.
 *   rename to .jpg       the server derives the MIME type from the extension and
 *                        ignores what the client claims.
 *
 * HEIC is the one case a browser cannot match. Chrome and Firefox cannot decode
 * image/heic at all, so createImageBitmap rejects and the original bytes are
 * uploaded untouched. In practice that rarely bites for the headline case: iOS
 * Safari and Android Chrome both convert HEIC to JPEG when a photo is picked
 * through <input type="file" accept="image/*">, so raw HEIC mostly arrives from
 * a desktop user dragging in a file copied off a phone. A wasm decoder is not an
 * option — the app's CSP is script-src 'self' with no 'wasm-unsafe-eval' (see
 * PdfViewer.jsx), which is the same constraint that ruled out pdf.js.
 */

export const QUALITY_STORAGE_KEY = 'rxhive_media_quality';

export const TIERS = {
  standard: { key: 'standard', label: 'Standard', maxEdge: 1600, jpegQuality: 0.7 },
  hd: { key: 'hd', label: 'HD', maxEdge: 3024, jpegQuality: 0.9 },
};

export const loadQualityTier = () => {
  try {
    const v = localStorage.getItem(QUALITY_STORAGE_KEY);
    return v === 'hd' ? 'hd' : 'standard';
  } catch {
    return 'standard';
  }
};

export const saveQualityTier = (tier) => {
  try { localStorage.setItem(QUALITY_STORAGE_KEY, tier); } catch { /* private mode */ }
};

const isImage = (file) => (file?.type || '').startsWith('image/');

/**
 * Re-encode an image for the given tier.
 *
 * Returns the ORIGINAL file unchanged whenever re-encoding would not help or
 * cannot be done, so every caller can use the result unconditionally.
 */
export async function transcodeImage(file, tierKey = 'standard') {
  if (!isImage(file)) return file;
  // An animated GIF re-encodes to a single still frame, which is a silent
  // content change rather than a size optimisation.
  if (file.type === 'image/gif') return file;

  const tier = TIERS[tierKey] || TIERS.standard;

  try {
    // imageOrientation: 'from-image' bakes the EXIF rotation into the pixels,
    // which is what kCGImageSourceCreateThumbnailWithTransform does on iOS.
    // Without it a portrait photo from a phone arrives on its side, because the
    // orientation tag is lost the moment it is drawn to a canvas.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

    const longEdge = Math.max(bitmap.width, bitmap.height);
    // Never upscale.
    const scale = Math.min(1, tier.maxEdge / longEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); return file; }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: tier.jpegQuality })
      : await new Promise((r) => canvas.toBlob(r, 'image/jpeg', tier.jpegQuality));
    if (!blob) return file;

    // Keep whichever is smaller. A JPEG that is already well compressed usually
    // grows when re-encoded, and sending the larger of the two would make the
    // whole feature counterproductive.
    if (blob.size >= file.size) return file;

    const base = (file.name || 'image').replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    // HEIC in a browser that cannot decode it, a corrupt file, a tainted canvas.
    // Upload what the user picked.
    return file;
  }
}

/**
 * What this batch will actually cost to send, in bytes.
 *
 * Measured by running the real transcode, not estimated — the number beside the
 * send button has to be the number that arrives, or it is worse than no number.
 * Videos are counted at their original size and labelled as such, exactly as
 * iOS does: a video export is far too slow to run just to draw a label.
 */
export async function measureBatchSize(files, tierKey) {
  let total = 0;
  let anyOriginal = false;
  for (const f of files) {
    const file = f.file || f;
    if (isImage(file) && file.type !== 'image/gif') {
      const out = await transcodeImage(file, tierKey);
      total += out.size;
    } else {
      total += file.size;
      anyOriginal = true;
    }
  }
  return { total, anyOriginal };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
