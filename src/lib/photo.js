// photo.js: shrink a photo in the browser before uploading it (like the Pantry and
// Home Projects): the longest side becomes at most `max` pixels, saved as JPEG.
// Phone photos (4–12 MB) come out around 200–500 KB.

/** Returns { blob, w, h }. Throws if the file isn't an image the browser can read. */
export async function shrinkPhoto(file, max = 1600, quality = 0.82) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('That isn’t a photo.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const img = bitmap || await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Couldn’t read that photo.'));
    i.src = URL.createObjectURL(file);
  });
  const w0 = img.width, h0 = img.height;
  const scale = Math.min(1, max / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  if (bitmap) bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Couldn’t shrink that photo.');
  return { blob, w, h };
}
