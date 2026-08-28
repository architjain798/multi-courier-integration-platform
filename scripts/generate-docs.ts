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
      // Without this the run is only a smoke test of connectivity: the error envelope is itself a
      // valid envelope, so a route answering 500 would pass the assertion above.
      "pm.test('does not fail on the server side', function () {",
      '  pm.expect(pm.response.code).to.be.below(500);',
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

// The converter stamps a fresh uuid on the collection and on every item and example response, so
// two runs over an unchanged schema differ by ~250 lines of pure noise. That hides real changes in
// review and makes a CI staleness check impossible. Postman assigns its own ids on import.
const generatedKeys = new Set(['id', '_postman_id']);

const document = buildOpenApiDocument('1.0.0');
const queryExamples = queryExamplesFrom(document);

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
  return normalize({ ...collection, variable: variables, event: [captureIds] });
}

// One walk over the finished collection. It drops the generated ids, and rewrites the two kinds of
// URL slot the converter fills in badly: path variables, which have to carry the chained values,
// and query parameters, which it invents from the schema.
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !generatedKeys.has(key))
      .map(([key, entry]) => [key, key === 'url' ? normalizeUrl(entry) : normalize(entry)]),
  );
}

function normalizeUrl(url: unknown): unknown {
  const walked = normalize(url);
  if (!isRecord(walked)) {
    return walked;
  }
  return {
    ...walked,
    ...(Array.isArray(walked.variable)
      ? { variable: walked.variable.filter(isNotBaseUrl).map(substitute(chained)) }
      : {}),
    ...(Array.isArray(walked.query) ? { query: walked.query.map(substitute(queryExamples)) } : {}),
  };
}

function isNotBaseUrl(entry: unknown): boolean {
  return !isRecord(entry) || entry.key !== 'baseUrl';
}

function substitute(replacements: Record<string, string | undefined>) {
  return (entry: unknown): unknown => {
    if (!isRecord(entry) || typeof entry.key !== 'string') {
      return entry;
    }
    const replacement = replacements[entry.key];
    return replacement === undefined ? entry : { ...entry, value: replacement };
  };
}

// The converter resolves a query parameter by inventing a value from its schema, and for an enum it
// picks a member at random -- so the committed collection showed a different ?status= on every
// regeneration, and a reviewer had no way to tell that from a real change. The document already
// carries the example we want on the parameter; this is only copying it across.
function queryExamplesFrom(document: unknown): Record<string, string | undefined> {
  const examples: Record<string, string | undefined> = {};
  if (!isRecord(document) || !isRecord(document.paths)) {
    return examples;
  }

  for (const operations of Object.values(document.paths)) {
    if (!isRecord(operations)) {
      continue;
    }
    for (const operation of Object.values(operations)) {
      if (!isRecord(operation) || !Array.isArray(operation.parameters)) {
        continue;
      }
      for (const parameter of operation.parameters) {
        if (
          isRecord(parameter) &&
          parameter.in === 'query' &&
          typeof parameter.name === 'string' &&
          typeof parameter.example === 'string'
        ) {
          examples[parameter.name] = parameter.example;
        }
      }
    }
  }
  return examples;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
