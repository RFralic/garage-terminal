// off.js: looks up a store barcode in Open Food Facts (openfoodfacts.org), a
// free, open database of food products. No key needed. Only the barcode is sent.
// Used to fill in the name, brand and size when a new code is scanned.

const FIELDS = 'product_name,product_name_en,generic_name,brands,quantity,image_front_small_url';

/** { name, brand, size, photo } for a UPC/EAN, or null if it isn't known (or the lookup fails). */
export async function lookupProduct(code, timeoutMs = 6000) {
  if (!/^\d{8,14}$/.test(code)) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${FIELDS}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const p = j && j.status === 1 && j.product;
    if (!p) return null;
    const name = String(p.product_name_en || p.product_name || p.generic_name || '').trim();
    if (!name) return null;
    const photo = String(p.image_front_small_url || '');
    return {
      name: name.slice(0, 120),
      brand: String(p.brands || '').split(',')[0].trim().slice(0, 60),
      size: String(p.quantity || '').trim().slice(0, 40),
      photo: /^https:\/\/(images|static)\.openfoodfacts\.org\//.test(photo) ? photo : '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
