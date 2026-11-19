// Encode locally before requesting an upload credential. The original never leaves the browser.
export async function prepareProfilePicture(file: Blob): Promise<Blob> {
  if (!file.size || !['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choose a PNG or JPEG image.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MiB.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, {imageOrientation:'from-image'}); }
  catch { throw new Error('This image could not be opened. Choose another PNG or JPEG.'); }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not prepare the image.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 512, 512);
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 512, 512);
    for (const quality of [.85, .75, .65, .55, .45, .35, .25, .15, .1]) {
      const blob = await new Promise<Blob|null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) throw new Error('Your browser could not encode the image.');
      if (blob.type === 'image/jpeg' && blob.size <= 64 * 1024) return blob;
    }
    throw new Error('This image could not fit within the upload limit. Choose a simpler image.');
  } finally { bitmap.close(); }
}

export async function previewProfilePicture(file: File): Promise<{ image: Blob; url: string }> {
  const image = await prepareProfilePicture(file);
  // A small data URL avoids object-URL ownership and revocation across component lifetimes.
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not display the preview. Choose the image again.'));
    };
    reader.onerror = () => reject(new Error('Could not display the preview. Choose the image again.'));
    reader.readAsDataURL(image);
  });
  return { image, url };
}
