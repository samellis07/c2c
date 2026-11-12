/**
 * Subset of JSON Schema draft 2020-12 used by docs/feature-matrix/schema.json.
 * Supports type, const, enum, required, properties, additionalProperties,
 * items, minLength, minimum, pattern, $ref (local), allOf, oneOf, if/then/else.
 */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeOk(type, data) {
  switch (type) {
    case 'object':
      return isObject(data);
    case 'array':
      return Array.isArray(data);
    case 'string':
      return typeof data === 'string';
    case 'boolean':
      return typeof data === 'boolean';
    case 'integer':
      return typeof data === 'number' && Number.isInteger(data);
    case 'number':
      return typeof data === 'number' && Number.isFinite(data);
    case 'null':
      return data === null;
    default:
      return false;
  }
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) {
    throw new Error(`only local $ref is supported, got ${ref}`);
  }
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = root;
  for (const part of parts) {
    if (!isObject(node) && !Array.isArray(node)) {
      throw new Error(`unresolvable $ref ${ref}`);
    }
    node = node[part];
  }
  if (node === undefined) throw new Error(`unresolvable $ref ${ref}`);
  return node;
}

function walk(schema, data, instancePath, root, errors) {
  if (!isObject(schema)) {
    errors.push({ path: instancePath || '/', message: 'schema is not an object' });
    return;
  }

  if (schema.$ref) {
    walk(resolveRef(root, schema.$ref), data, instancePath, root, errors);
  }

  if (schema.const !== undefined && data !== schema.const) {
    errors.push({
      path: instancePath || '/',
      message: `must be ${JSON.stringify(schema.const)}`,
    });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === data)) {
    errors.push({
      path: instancePath || '/',
      message: `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(' | ')}`,
    });
  }

  let typed = true;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    typed = types.some((type) => typeOk(type, data));
    if (!typed) {
      errors.push({
        path: instancePath || '/',
        message: `expected ${types.join('|')}`,
      });
    }
  }

  if (typed && (schema.minLength !== undefined || schema.pattern !== undefined) && typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push({
        path: instancePath || '/',
        message: `must be at least ${schema.minLength} characters`,
      });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(data)) {
      errors.push({
        path: instancePath || '/',
        message: `must match ${schema.pattern}`,
      });
    }
  }

  if (typed && schema.minimum !== undefined && typeof data === 'number' && data < schema.minimum) {
    errors.push({
      path: instancePath || '/',
      message: `must be >= ${schema.minimum}`,
    });
  }

  if (typed && (schema.properties || schema.required || schema.additionalProperties === false)) {
    if (!isObject(data)) {
      if (schema.type === undefined) {
        errors.push({ path: instancePath || '/', message: 'expected object' });
      }
    } else {
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (data[key] === undefined) {
            errors.push({
              path: instancePath || '/',
              message: `missing required property ${key}`,
            });
          }
        }
      }
      const props = schema.properties || {};
      for (const key of Object.keys(data)) {
        const childPath = `${instancePath}/${key}`;
        if (props[key]) {
          walk(props[key], data[key], childPath, root, errors);
        } else if (schema.additionalProperties === false) {
          errors.push({ path: childPath, message: 'unknown property' });
        } else if (isObject(schema.additionalProperties)) {
          walk(schema.additionalProperties, data[key], childPath, root, errors);
        }
      }
    }
  }

  if (typed && schema.items && Array.isArray(data)) {
    data.forEach((item, index) => {
      walk(schema.items, item, `${instancePath}/${index}`, root, errors);
    });
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) walk(sub, data, instancePath, root, errors);
  }

  if (Array.isArray(schema.oneOf)) {
    const matched = [];
    for (const sub of schema.oneOf) {
      const subErrors = [];
      walk(sub, data, instancePath, root, subErrors);
      if (subErrors.length === 0) matched.push(sub);
    }
    if (matched.length !== 1) {
      errors.push({
        path: instancePath || '/',
        message: `must match exactly one schema (${matched.length} matched)`,
      });
    }
  }

  if (schema.if) {
    const ifErrors = [];
    walk(schema.if, data, instancePath, root, ifErrors);
    if (ifErrors.length === 0) {
      if (schema.then) walk(schema.then, data, instancePath, root, errors);
    } else if (schema.else) {
      walk(schema.else, data, instancePath, root, errors);
    }
  }
}

export function validateAgainstSchema(schema, data) {
  const errors = [];
  walk(schema, data, '', schema, errors);
  return errors;
}
