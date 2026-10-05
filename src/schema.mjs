import { readFileSync } from 'node:fs';

// These schemas use this small JSON Schema vocabulary. Unknown keywords fail
// loudly so a schema edit cannot silently weaken validation.
const keywords = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'description',
  'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems',
  'minLength', 'maxLength', 'maxItems', 'pattern', 'enum', 'const', 'oneOf', 'allOf', 'minimum', 'maximum']);

export function validateSchema(value, schema) {
  function check(data, rule, path) {
    for (const key of Object.keys(rule)) {
      if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    }
    if (rule.$ref) {
      if (!rule.$ref.startsWith('#/')) throw new Error('Only local schema references are supported');
      let target = schema;
      for (const part of rule.$ref.slice(2).split('/')) target = target?.[part];
      if (!target) throw new Error(`Missing schema reference ${rule.$ref}`);
      return check(data, target, path);
    }
    const errors = [];
    if (rule.oneOf && rule.oneOf.filter(branch => check(data, branch, path).length === 0).length !== 1) errors.push(`${path}: expected exactly one schema alternative`);
    if (rule.allOf) for (const branch of rule.allOf) errors.push(...check(data, branch, path));
    const type = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
    if (rule.type && !(rule.type === type || (rule.type === 'integer' && Number.isInteger(data)))) return [...errors, `${path}: expected ${rule.type}`];
    if (rule.const !== undefined && data !== rule.const) errors.push(`${path}: expected ${JSON.stringify(rule.const)}`);
    if (rule.enum && !rule.enum.includes(data)) errors.push(`${path}: unsupported value`);
    if (type === 'string') {
      if (rule.minLength && data.length < rule.minLength) errors.push(`${path}: too short`);
      if (rule.maxLength !== undefined && [...data].length > rule.maxLength) errors.push(`${path}: too long`);
      if (rule.pattern && !new RegExp(rule.pattern).test(data)) errors.push(`${path}: invalid format`);
    }
    if (typeof data === 'number' && rule.minimum !== undefined && data < rule.minimum) errors.push(`${path}: below minimum`);
    if (typeof data === 'number' && rule.maximum !== undefined && data > rule.maximum) errors.push(`${path}: above maximum`);
    if (type === 'array') {
      if (rule.minItems && data.length < rule.minItems) errors.push(`${path}: too few items`);
      if (rule.maxItems !== undefined && data.length > rule.maxItems) errors.push(`${path}: too many items`);
      if (rule.items) data.forEach((item, i) => errors.push(...check(item, rule.items, `${path}/${i}`)));
    }
    if (type === 'object') {
      for (const name of rule.required ?? []) if (!Object.hasOwn(data, name)) errors.push(`${path}/${name}: required`);
      for (const [name, item] of Object.entries(data)) {
        if (rule.properties?.[name]) errors.push(...check(item, rule.properties[name], `${path}/${name}`));
        else if (rule.additionalProperties === false) errors.push(`${path}/${name}: unknown field`);
        else if (typeof rule.additionalProperties === 'object') errors.push(...check(item, rule.additionalProperties, `${path}/${name}`));
      }
    }
    return errors;
  }
  return check(value, schema, '$');
}

export function loadSchema(name) {
  return JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
}
