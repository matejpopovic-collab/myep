/* ============================================================================
   STAFF PHOTOS
   ----------------------------------------------------------------------------
   The old register led every row with the worker's face, and the supervisors
   on the gate use it to match a person to a name. The new one had dropped it
   for initials. This puts it back.

   A photo is stored per worker as a small square JPEG data URL (160px, ~10KB),
   journalled to localStorage like pay rates, so it survives a reload. The
   upload is scaled and centre-cropped here before it is stored — nobody needs
   a 4MB phone photo to draw a 32px circle. No photo → `Avatar` falls back to
   initials, so nothing changes for a worker who has not got one yet.

   Demo seed: half the register (the odd ids) ship with an illustrated
   portrait from /public/staff-photos, so both states are visible. Removing a
   seeded photo is journalled as an empty string, so it stays removed.
   ========================================================================== */

const KEY = 'eprosta.staffPhotos.v1';
const SIZE = 160;

type PhotoMap = Record<string, string>;

function load(): PhotoMap {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function save(): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(STORE));
    return true;
  } catch {
    return false; /* private mode or full */
  }
}

const SEED: PhotoMap = Object.fromEntries(
  Array.from({ length: 15 }, (_, i) => {
    const id = `e-${i * 2 + 1}`;
    return [id, `${import.meta.env.BASE_URL}staff-photos/${id}.svg`];
  }),
);

let STORE: PhotoMap = { ...SEED, ...load() };

const listeners = new Set<() => void>();
let version = 0;
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const getVersion = (): number => version;
function emit(): void {
  version += 1;
  listeners.forEach((fn) => fn());
}

/** The worker's photo as a data URL, or undefined when they have none. */
export const get = (empId: string): string | undefined => STORE[empId] || undefined;

export function set(empId: string, dataUrl: string): boolean {
  STORE = { ...STORE, [empId]: dataUrl };
  const ok = save();
  emit();
  return ok;
}

export function remove(empId: string): void {
  // An empty string, not a delete — otherwise a seeded photo would come back.
  STORE = { ...STORE, [empId]: '' };
  save();
  emit();
}

/** Square, centre-cropped JPEG data URL from an uploaded image file. */
export function fileToPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('That file is not an image.'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        return reject(new Error('Could not read the image.'));
      }
      ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the image.'));
    };
    img.src = url;
  });
}
