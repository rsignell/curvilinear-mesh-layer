import { Storage } from '@earthmover/icechunk';

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '');
}

function objectUrl(baseUrl, path) {
  const normalizedPath = path.replace(/^\/+/, '');
  return `${baseUrl}/${normalizedPath}`;
}

function throwForStatus(resp, url) {
  if (resp.ok) return;
  if (resp.status === 404) {
    throw new Error(`ObjectNotFound: ${url}`);
  }
  throw new Error(`HTTP ${resp.status}: ${url}`);
}

async function fetchObject(baseUrl, path, rangeStart, rangeEnd) {
  const url = objectUrl(baseUrl, path);
  const headers = {};

  if (rangeStart != null && rangeEnd != null) {
    headers.Range = `bytes=${rangeStart}-${rangeEnd - 1}`;
  } else if (rangeStart != null) {
    headers.Range = `bytes=${rangeStart}-`;
  }

  const resp = await fetch(url, { headers });
  throwForStatus(resp, url);

  return {
    data: new Uint8Array(await resp.arrayBuffer()),
    version: { etag: resp.headers.get('etag') ?? undefined },
  };
}

function parseS3List(xml, keyPrefix) {
  const results = [];
  const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;

  while ((match = contentRegex.exec(xml)) !== null) {
    const block = match[1];
    const key = block.match(/<Key>(.*?)<\/Key>/)?.[1];
    const lastModified = block.match(/<LastModified>(.*?)<\/LastModified>/)?.[1];
    const size = block.match(/<Size>(.*?)<\/Size>/)?.[1];
    if (!key || !lastModified || !size) continue;

    results.push({
      id: key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key,
      createdAt: new Date(lastModified),
      sizeBytes: Number(size),
    });
  }

  return results;
}

export function createIcechunkV2FetchStorage(repoUrl) {
  const baseUrl = normalizeBaseUrl(repoUrl);

  return Storage.newCustom({
    canWrite: async () => false,

    getObjectRange: async (_err, { path, rangeStart, rangeEnd }) =>
      fetchObject(baseUrl, path, rangeStart, rangeEnd),

    putObject: async () => {
      throw new Error('Read-only storage: putObject not supported');
    },

    copyObject: async () => {
      throw new Error('Read-only storage: copyObject not supported');
    },

    listObjects: async (_err, prefix) => {
      const url = new URL(baseUrl);
      const repoPrefix = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
      const keyPrefix = `${repoPrefix}/${prefix.replace(/^\/+/, '')}`;
      const listUrl = `${url.origin}/?list-type=2&prefix=${encodeURIComponent(keyPrefix)}`;

      const resp = await fetch(listUrl);
      throwForStatus(resp, listUrl);
      return parseS3List(await resp.text(), keyPrefix);
    },

    deleteBatch: async () => {
      throw new Error('Read-only storage: deleteBatch not supported');
    },

    getObjectLastModified: async (_err, path) => {
      const url = objectUrl(baseUrl, path);
      const resp = await fetch(url, { method: 'HEAD' });
      throwForStatus(resp, url);
      const lastModified = resp.headers.get('last-modified');
      if (!lastModified) throw new Error(`No Last-Modified header: ${url}`);
      return new Date(lastModified);
    },

    getObjectConditional: async (_err, { path, previousVersion }) => {
      const url = objectUrl(baseUrl, path);
      const headers = {};
      if (previousVersion?.etag) headers['If-None-Match'] = previousVersion.etag;

      const resp = await fetch(url, { headers });
      if (resp.status === 304) return { kind: 'on_latest_version' };
      throwForStatus(resp, url);

      return {
        kind: 'modified',
        data: new Uint8Array(await resp.arrayBuffer()),
        newVersion: { etag: resp.headers.get('etag') ?? undefined },
      };
    },
  });
}
