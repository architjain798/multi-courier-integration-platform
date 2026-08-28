import { mkdir, writeFile } from 'node:fs/promises';
import Converter from 'openapi-to-postmanv2';
import { buildOpenApiDocument } from '../src/openapi.js';

// The converter emits one request per operation and stops there. Three things are missing before a
// reviewer can import the file and work through it: the server variable arrives duplicated and
// self-referential, {{apiKey}} is referenced by the auth block but never declared, and nothing
// carries an id from one response into the next request.
const variables = [
  { key: 'baseUrl', value: 'http://localhost:3000', type: 'string' },
  { key: 'apiKey', value: '', type: 'string' },
  { key: 'orderId', value: 'ORD-1001', type: 'string' },
  { key: 'batchId', value: '', type: 'string' },
];

const captureIds = {
  listen: 'test',
  script: {
    type: 'text/javascript',
    exec: [
      "pm.test('answers with the standard envelope', function () {",
      "  pm.expect(pm.response.json()).to.have.property('success');",
      '});',
      '',
      // `data` is already taken in the Postman sandbox, and redeclaring it fails the whole script.
      'const payload = pm.response.json().data;',
      'if (payload && payload.order_id) {',
      "  pm.collectionVariables.set('orderId', payload.order_id);",
      '}',
      'if (payload && payload.batch_id) {',
      "  pm.collectionVariables.set('batchId', payload.batch_id);",
      '}',
    ],
  },
};

const chained: Record<string, string> = { orderId: '{{orderId}}', batchId: '{{batchId}}' };

const document = buildOpenApiDocument('1.0.0');

await mkdir('docs', { recursive: true });
await mkdir('postman', { recursive: true });
await writeFile('docs/openapi.json', `${JSON.stringify(document, null, 2)}\n`);
console.log('wrote docs/openapi.json');

const converted = await new Promise<unknown>((resolve, reject) => {
  Converter.convert(
    { type: 'json', data: document },
    { folderStrategy: 'Tags', requestParametersResolution: 'Example' },
    (error, result) => {
      if (error !== null) {
        reject(new Error(error.message));
        return;
      }
      const first = result?.output?.[0];
      if (result?.result !== true || first === undefined) {
        reject(new Error(result?.reason ?? 'conversion produced no collection'));
        return;
      }
      resolve(first.data);
    },
  );
});

await writeFile(
  'postman/multi-courier.postman_collection.json',
  `${JSON.stringify(runnable(converted), null, 2)}\n`,
);
console.log('wrote postman/multi-courier.postman_collection.json');

function runnable(collection: unknown): unknown {
  if (!isRecord(collection)) {
    throw new Error('the converter returned something that is not a collection');
  }
  return {
    ...collection,
    variable: variables,
    event: [captureIds],
    item: mapItems(collection.item),
  };
}

function mapItems(items: unknown): unknown {
  if (!Array.isArray(items)) {
    return items;
  }
  return items.map((entry: unknown) => {
    if (!isRecord(entry)) {
      return entry;
    }
    if ('item' in entry) {
      return { ...entry, item: mapItems(entry.item) };
    }
    return { ...entry, request: mapRequest(entry.request) };
  });
}

function mapRequest(request: unknown): unknown {
  if (!isRecord(request) || !isRecord(request.url) || !Array.isArray(request.url.variable)) {
    return request;
  }
  const variable = request.url.variable
    .filter((entry: unknown) => !isRecord(entry) || entry.key !== 'baseUrl')
    .map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry.key !== 'string') {
        return entry;
      }
      const replacement = chained[entry.key];
      return replacement === undefined ? entry : { ...entry, value: replacement };
    });
  return { ...request, url: { ...request.url, variable } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
