import { fileURLToPath } from 'node:url';

/** An explicit asset directory for a same-origin Workshop gateway/backend. */
export const workshopAssetsRoot = fileURLToPath(new URL('../tools/workshop/public/', import.meta.url));
