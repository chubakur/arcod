// S3 with SigV4, hand-written: the generated service stays dependency-free.
export const BLOB_SOURCE = `// ---------- blob ----------

const S3_ENDPOINT = (process.env.S3_ENDPOINT || 'http://s3:9000').replace(/[/]+$/, '');
const S3_BUCKET = process.env.S3_BUCKET || 'files';
const S3_ACCESS = process.env.S3_ACCESS_KEY || 'minio';
const S3_SECRET = process.env.S3_SECRET_KEY || 'minio123';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const BLOB_MEMORY = process.env.BLOB_DRIVER === 'memory';
const blobMemory = new Map();
let bucketReady = false;

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function amzStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/[.][0-9]{3}/, '');
}

async function s3Request(method, key, body, type) {
  const url = new URL(S3_ENDPOINT);
  const path = '/' + S3_BUCKET + (key ? '/' + key : '');
  const payload = body == null ? '' : String(body);
  const stamp = amzStamp();
  const date = stamp.slice(0, 8);
  const payloadHash = sha256(payload);
  const canonicalHeaders = 'host:' + url.host + '\\n'
    + 'x-amz-content-sha256:' + payloadHash + '\\n'
    + 'x-amz-date:' + stamp + '\\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = method + '\\n' + path + '\\n\\n' + canonicalHeaders + '\\n' + signedHeaders + '\\n' + payloadHash;
  const scope = date + '/' + S3_REGION + '/s3/aws4_request';
  const stringToSign = 'AWS4-HMAC-SHA256\\n' + stamp + '\\n' + scope + '\\n' + sha256(canonicalRequest);
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + S3_SECRET, date), S3_REGION), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const headers = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
    authorization: 'AWS4-HMAC-SHA256 Credential=' + S3_ACCESS + '/' + scope
      + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
  };
  if (type) headers['content-type'] = type;
  return fetch(S3_ENDPOINT + path, {
    method,
    headers,
    body: method === 'PUT' || method === 'POST' ? payload : undefined,
  });
}

async function ensureBucket() {
  if (bucketReady) return;
  const response = await s3Request('PUT', '', '', '');
  if (!response.ok && response.status !== 409) throw new Error('blob: bucket ' + response.status);
  bucketReady = true;
}

async function blobPut(key, value, type) {
  if (BLOB_MEMORY) {
    blobMemory.set(key, { value: String(value), type: type || 'text/plain' });
    return;
  }
  await ensureBucket();
  const response = await s3Request('PUT', key, value, type || 'application/octet-stream');
  if (!response.ok) throw new Error('blob: put ' + response.status);
}

async function blobGet(key) {
  if (BLOB_MEMORY) {
    const item = blobMemory.get(key);
    return item ? item.value : null;
  }
  const response = await s3Request('GET', key, null, '');
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('blob: get ' + response.status);
  return response.text();
}

async function blobDelete(key) {
  if (BLOB_MEMORY) {
    blobMemory.delete(key);
    return;
  }
  await s3Request('DELETE', key, null, '');
}
`;
